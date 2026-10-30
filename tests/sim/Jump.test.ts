import { describe, expect, it } from 'vitest';
import { DEFAULT_AUDIBLE } from '@/sim/audible';
import { Jump, type JumpConfig } from '@/sim/Jump';
import { NEUTRAL_INPUT } from '@/sim/inputs';
import { DEFAULT_JUMPER } from '@/sim/jumper';
import { FT, KT } from '@/sim/units';
import { WIND_PRESETS } from '@/sim/wind';

/** Interlaken: the landing area is 568 m above mean sea level. */
const GROUND_M = 568;

/** The exit is 13,500 ft above the landing area. */
const EXIT_FT = 13500;

/** The pull is at 3,500 ft above the landing area. */
const PULL_FT = 3500;

/** The speed of the aircraft at the exit: 95 knots true. */
const EXIT_SPEED_MS = 95 * KT;

/** The most steps a test will fly before it gives up. */
const MAX_STEPS = 300 * 120;

/** A jump over flat ground at Interlaken. */
function makeConfig(overrides: Partial<JumpConfig> = {}): JumpConfig {
  return {
    seed: 1,
    jumper: DEFAULT_JUMPER,
    wind: WIND_PRESETS.calm,
    temperatureOffsetC: 0,
    exitPos: { x: 0, y: GROUND_M + EXIT_FT * FT, z: 0 },
    exitHeadingRad: 0,
    aircraftTasMs: EXIT_SPEED_MS,
    lzGroundY: GROUND_M,
    ground: () => GROUND_M,
    canopyId: 'sport-210',
    pullAltitudeFt: PULL_FT,
    audible: DEFAULT_AUDIBLE,
    ...overrides,
  };
}

/** The input of a jumper who is not touching anything. */
const NEUTRAL = { ...NEUTRAL_INPUT };

/** Flies the jumper down to the pull and throws the canopy. */
function flyToPull(jump: Jump): void {
  let steps = 0;
  while (jump.phase === 'freefall' && steps < MAX_STEPS) {
    jump.step({ ...NEUTRAL, pull: jump.altitudeAglM() <= PULL_FT * FT });
    steps++;
  }
}

describe('the jump', () => {
  it('leaves the aircraft at the exit speed', () => {
    const jump = new Jump(makeConfig());
    const velocity = jump.velocity();

    // 95 knots true, plus the little wind there is at 13,500 ft.
    const speed = Math.hypot(velocity.x, velocity.z);
    expect(speed).toBeGreaterThan(EXIT_SPEED_MS - 3);
    expect(speed).toBeLessThan(EXIT_SPEED_MS + 3);
    // The run is north, so the jumper goes north.
    expect(velocity.z).toBeLessThan(0);
    expect(jump.position().y).toBeCloseTo(GROUND_M + EXIT_FT * FT, 9);
  });

  it('logs the exit, the two alarms and the pull, in that order', () => {
    const jump = new Jump(makeConfig());
    flyToPull(jump);

    expect(jump.events.map((event) => event.type)).toEqual([
      'exit',
      'alarm',
      'alarm',
      'pull',
    ]);
    expect(jump.events[1]?.detail).toBe('alarm1');
    expect(jump.events[2]?.detail).toBe('alarm2');
    expect(jump.phase).toBe('opening');
  });

  it('takes between fifty five and sixty five seconds to the pull', () => {
    // The band of the plan is the sea level figure: the air at 13,500 ft
    // is thin, and the same jump in the standard atmosphere is quicker.
    const jump = new Jump(makeConfig({ constantDensity: 1.225 }));
    flyToPull(jump);

    expect(jump.tS).toBeGreaterThan(55);
    expect(jump.tS).toBeLessThan(65);
  });

  it('falls quicker in the thin air of the standard atmosphere', () => {
    const seaLevel = new Jump(makeConfig({ constantDensity: 1.225 }));
    flyToPull(seaLevel);
    const standard = new Jump(makeConfig());
    flyToPull(standard);

    expect(standard.tS).toBeGreaterThan(52);
    expect(standard.tS).toBeLessThan(56);
    expect(standard.tS).toBeLessThan(seaLevel.tS - 5);
  });

  it('pulls at 3,500 ft above the landing area', () => {
    const jump = new Jump(makeConfig());
    flyToPull(jump);

    const pull = jump.events.find((event) => event.type === 'pull');
    expect(pull).toBeDefined();
    const pullFt = (pull?.aglM ?? 0) / FT;
    expect(Math.abs(pullFt - PULL_FT)).toBeLessThan(50);
    // The altimeter reads the height above the landing area.
    expect(Math.abs(jump.altitudeAglM() / FT - PULL_FT)).toBeLessThan(50);
  });

  it('acts on the pull only once', () => {
    const jump = new Jump(makeConfig());
    flyToPull(jump);

    for (let i = 0; i < 240; i++) jump.step({ ...NEUTRAL, pull: true });

    expect(jump.events.filter((event) => event.type === 'pull')).toHaveLength(1);
    expect(jump.phase).toBe('opening');
  });

  it('ends on the ground when there is no pull', () => {
    const jump = new Jump(makeConfig());
    let steps = 0;
    while (jump.phase !== 'landed' && steps < MAX_STEPS) {
      jump.step(NEUTRAL);
      steps++;
    }

    expect(jump.phase).toBe('landed');
    const types = jump.events.map((event) => event.type);
    expect(types).toContain('touchdown');
    expect(types).toContain('impact');
    expect(types.indexOf('touchdown')).toBeLessThan(types.indexOf('impact'));
  });

  it('replays exactly from the input log', () => {
    const first = new Jump(makeConfig());
    let steps = 0;
    while (first.phase !== 'landed' && steps < MAX_STEPS) {
      first.step({ ...NEUTRAL, pull: first.altitudeAglM() <= PULL_FT * FT });
      steps++;
    }

    const second = new Jump(makeConfig());
    for (const input of first.inputLog) second.step(input);

    expect(second.position().x).toBeCloseTo(first.position().x, 9);
    expect(second.position().y).toBeCloseTo(first.position().y, 9);
    expect(second.position().z).toBeCloseTo(first.position().z, 9);
    expect(second.phase).toBe(first.phase);
    expect(second.events).toHaveLength(first.events.length);
  });

  it('logs a copy of every input', () => {
    const jump = new Jump(makeConfig());
    const input = { ...NEUTRAL, freefall: { ...NEUTRAL.freefall, turn: 0.5 } };

    jump.step(input);
    input.freefall.turn = 1;

    expect(jump.inputLog).toHaveLength(1);
    expect(jump.inputLog[0]?.freefall.turn).toBe(0.5);
  });

  it('samples the track ten times a second', () => {
    const jump = new Jump(makeConfig());
    for (let i = 0; i < 3 * 120; i++) jump.step(NEUTRAL);

    expect(jump.track).toHaveLength(30);
    expect(jump.track[0]?.tS).toBeCloseTo(0.1, 9);
    expect(jump.track[0]?.phase).toBe('freefall');
  });
});
