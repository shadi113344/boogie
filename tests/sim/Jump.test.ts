import { describe, expect, it } from 'vitest';
import { DEFAULT_AUDIBLE } from '@/sim/audible';
import { Jump, type JumpConfig } from '@/sim/Jump';
import { NEUTRAL_INPUT, type JumpInput } from '@/sim/inputs';
import { DEFAULT_JUMPER } from '@/sim/jumper';
import { Rng } from '@/sim/rng';
import { defaultExit } from '@/sim/spot';
import { FT, KT } from '@/sim/units';
import { WIND_PRESETS, Wind } from '@/sim/wind';

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
    // The AAD gets the reserve out on the way down, so the jumper lands
    // under a canopy instead of hitting the ground in the freefall.
    expect(jump.aadFired).toBe(true);
    expect(types).not.toContain('impact');
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

/** The wind of a typical day at the drop zone. */
const TYPICAL = WIND_PRESETS.typical;

/** The height at which the pattern starts, in feet above the landing area. */
const PATTERN_FT = 1000;

/** The height at which the flare starts, in feet above the landing area. */
const FLARE_FT = 12;

/** How long after the canopy opens the brakes are unstowed, in seconds. */
const UNSTOW_S = 3;

/** The gain of the steering: the toggle travel per radian of heading error. */
const STEER_GAIN = 1.2;

/** The full jump: the exit of the spot, the typical wind and the pattern. */
function makeFullConfig(overrides: Partial<JumpConfig> = {}): JumpConfig {
  const wind = new Wind(TYPICAL, new Rng(1));
  const exit = defaultExit({
    lzGroundY: GROUND_M,
    exitAltitudeAglM: EXIT_FT * FT,
    wind,
    aircraftTasMs: EXIT_SPEED_MS,
  });
  return makeConfig({
    wind: TYPICAL,
    exitPos: exit.pos,
    exitHeadingRad: exit.headingRad,
    ...overrides,
  });
}

/**
 * Points the canopy at the surface wind.
 *
 * The error is the difference between the heading the canopy is flying and
 * the direction the surface wind comes from; the toggle travel is what is
 * needed to turn that much, and the toggle that is pulled is the one that
 * turns the canopy the right way.
 */
function steer(jump: Jump, input: JumpInput): void {
  const target = (jump.wind.fromDegAt(0) * Math.PI) / 180;
  let error = target - jump.canopyHeadingRad();
  while (error > Math.PI) error -= 2 * Math.PI;
  while (error < -Math.PI) error += 2 * Math.PI;
  const travel = Math.min(Math.max(Math.abs(error) * STEER_GAIN, 0), 0.6);
  input.canopy.left = error < 0 ? travel : 0;
  input.canopy.right = error > 0 ? travel : 0;
}

/** How the jumper flies the pattern. */
interface PatternOptions {
  /** Whether the jumper throws the canopy at the pull altitude. */
  pull?: boolean;
  /** The toggles held while the brakes are stowed. */
  stowedToggles?: number;
  /** Whether the jumper rolls into a PLF in the freefall. */
  plfInFreefall?: boolean;
}

/**
 * Flies a jump with the pattern: the steering on the way down and the
 * standard stroke at the bottom.
 *
 * @param jump the jump to fly
 * @param options how the jumper flies it
 */
function flyPattern(jump: Jump, options: PatternOptions = {}): void {
  const pull = options.pull ?? true;
  const stowedToggles = options.stowedToggles ?? 0;
  let steps = 0;
  let unstowed = false;
  let flareStartS = -1;
  while (jump.phase !== 'landed' && steps < MAX_STEPS) {
    const input: JumpInput = {
      freefall: { ...NEUTRAL.freefall },
      pull:
        pull &&
        jump.phase === 'freefall' &&
        jump.altitudeAglM() <= jump.config.pullAltitudeFt * FT,
      canopy: { ...NEUTRAL.canopy },
      plf: options.plfInFreefall === true && jump.phase === 'freefall',
    };
    if (jump.phase === 'canopy') {
      const opened = jump.events.find((event) => event.type === 'open');
      if (opened && !unstowed && jump.tS >= opened.tS + UNSTOW_S) {
        input.canopy.unstow = true;
        unstowed = true;
      }
      if (!unstowed) {
        input.canopy.left = stowedToggles;
        input.canopy.right = stowedToggles;
      }
      const aglFt = jump.heightAboveGround() / FT;
      if (aglFt <= PATTERN_FT) steer(jump, input);
      if (aglFt <= FLARE_FT) {
        if (flareStartS < 0) flareStartS = jump.tS;
        const t = jump.tS - flareStartS;
        const travel =
          t < 0.3
            ? (t / 0.3) * 0.5
            : t < 1.1
              ? 0.5 + ((t - 0.3) / 0.8) * 0.4
              : 0.9;
        input.canopy.left = travel;
        input.canopy.right = travel;
      }
    }
    jump.step(input);
    steps++;
  }
}

/** The event of a type in a jump. */
function eventOf(jump: Jump, type: 'pull' | 'open' | 'aad' | 'outcome' | 'touchdown') {
  return jump.events.find((event) => event.type === type);
}

describe('the jump with a canopy', () => {
  it('flies the whole jump in the order of the plan', () => {
    const jump = new Jump(makeFullConfig());
    flyPattern(jump);

    expect(jump.events.map((event) => event.type)).toEqual([
      'exit',
      'alarm',
      'alarm',
      'pull',
      'stage',
      'stage',
      'stage',
      'stage',
      'open',
      'unstow',
      'touchdown',
      'outcome',
    ]);
    // The stages of the opening, in the order the canopy comes out.
    expect(
      jump.events.filter((event) => event.type === 'stage').map((event) => event.detail),
    ).toEqual(['bag', 'line-stretch', 'snivel', 'inflation']);
    expect(jump.phase).toBe('landed');
  });

  it('takes between fifty one and fifty eight seconds to the pull', () => {
    // The band of the plan is the sea level figure: the air at 13,500 ft
    // is thin, and the same jump in the standard atmosphere is quicker.
    const jump = new Jump(makeFullConfig());
    flyPattern(jump);

    const pull = eventOf(jump, 'pull');
    expect(pull).toBeDefined();
    expect(pull?.tS).toBeGreaterThan(51);
    expect(pull?.tS).toBeLessThan(58);
  });

  it('opens the canopy three and seven tenths to five and two tenths seconds after the throw', () => {
    const jump = new Jump(makeFullConfig());
    flyPattern(jump);

    const pull = eventOf(jump, 'pull');
    const open = eventOf(jump, 'open');
    expect(pull).toBeDefined();
    expect(open).toBeDefined();
    const openS = (open?.tS ?? 0) - (pull?.tS ?? 0);
    expect(openS).toBeGreaterThan(3.7);
    expect(openS).toBeLessThan(5.2);
  });

  it('pulls between two and eight and five and a half g through the opening', () => {
    const jump = new Jump(makeFullConfig());
    flyPattern(jump);

    expect(jump.maxOpeningG).toBeGreaterThan(2.8);
    expect(jump.maxOpeningG).toBeLessThan(5.5);
  });

  it('lands the jumper without an injury and without a death', () => {
    const jump = new Jump(makeFullConfig());
    flyPattern(jump);

    const outcome = eventOf(jump, 'outcome');
    expect(outcome).toBeDefined();
    expect(outcome?.detail).not.toBe('injury');
    expect(outcome?.detail).not.toBe('fatal');
    expect(jump.touchdown).not.toBeNull();
    expect(jump.touchdown?.outcome).toBe(outcome?.detail);
  });
});

describe('the AAD', () => {
  it('fires the reserve between seven hundred and eight hundred feet when the jumper never pulls', () => {
    const jump = new Jump(makeFullConfig());
    flyPattern(jump, { pull: false });

    const aad = eventOf(jump, 'aad');
    expect(aad).toBeDefined();
    const aadFt = (aad?.aglM ?? 0) / FT;
    expect(aadFt).toBeGreaterThan(700);
    expect(aadFt).toBeLessThan(800);
    expect(jump.aadFired).toBe(true);
    // The reserve comes out and opens with room to spare.
    const open = eventOf(jump, 'open');
    expect(open).toBeDefined();
    expect((open?.aglM ?? 0) / FT).toBeGreaterThan(200);
    expect(jump.canopySpec.id).toBe('reserve-220');
    // The jumper lands under the reserve.
    expect(jump.phase).toBe('landed');
    expect(jump.events.map((event) => event.type)).not.toContain('impact');
  });

  it('fires the reserve before a pull planned at five hundred feet', () => {
    const jump = new Jump(makeFullConfig({ pullAltitudeFt: 500 }));
    flyPattern(jump);

    // The AAD fires at 750 ft, before the jumper gets to the handle.
    expect(jump.aadFired).toBe(true);
    expect(jump.canopySpec.id).toBe('reserve-220');
    expect(eventOf(jump, 'pull')).toBeUndefined();
  });

  it('leaves a jumper without an AAD who pulls at five hundred feet with an unfinished opening', () => {
    const jump = new Jump(makeFullConfig({ pullAltitudeFt: 500, aad: false }));
    flyPattern(jump);

    // Nothing fires the reserve: the main is out, too low.
    expect(jump.aadFired).toBe(false);
    expect(jump.canopySpec.id).toBe('sport-210');
    // The opening does not finish before the ground.
    expect(eventOf(jump, 'open')).toBeUndefined();
    expect(jump.events.map((event) => event.type)).toContain('impact');
    // And the landing says so.
    const outcome = eventOf(jump, 'outcome');
    expect(['injury', 'fatal']).toContain(outcome?.detail);
    expect(jump.touchdown?.outcome).toBe(outcome?.detail);
  });

  it('opens the main between two hundred and four hundred feet for a pull at a thousand feet', () => {
    const jump = new Jump(makeFullConfig({ pullAltitudeFt: 1000 }));
    flyPattern(jump);

    expect(jump.aadFired).toBe(false);
    const open = eventOf(jump, 'open');
    expect(open).toBeDefined();
    const openFt = (open?.aglM ?? 0) / FT;
    expect(openFt).toBeGreaterThan(200);
    expect(openFt).toBeLessThan(400);
    expect(jump.phase).toBe('landed');
  });
});

describe('the inputs that do not apply', () => {
  it('ignores the toggles while the brakes are stowed', () => {
    const plain = new Jump(makeFullConfig());
    flyPattern(plain);
    const held = new Jump(makeFullConfig());
    flyPattern(held, { stowedToggles: 0.9 });

    expect(held.touchdown?.pos.x).toBeCloseTo(plain.touchdown?.pos.x ?? 0, 9);
    expect(held.touchdown?.pos.y).toBeCloseTo(plain.touchdown?.pos.y ?? 0, 9);
    expect(held.touchdown?.pos.z).toBeCloseTo(plain.touchdown?.pos.z ?? 0, 9);
    expect(held.touchdown?.outcome).toBe(plain.touchdown?.outcome);
  });

  it('ignores a PLF in the freefall', () => {
    const plain = new Jump(makeFullConfig());
    flyPattern(plain);
    const rolled = new Jump(makeFullConfig());
    flyPattern(rolled, { plfInFreefall: true });

    expect(rolled.touchdown?.pos.x).toBeCloseTo(plain.touchdown?.pos.x ?? 0, 9);
    expect(rolled.touchdown?.pos.y).toBeCloseTo(plain.touchdown?.pos.y ?? 0, 9);
    expect(rolled.touchdown?.pos.z).toBeCloseTo(plain.touchdown?.pos.z ?? 0, 9);
    expect(rolled.touchdown?.outcome).toBe(plain.touchdown?.outcome);
  });

  it('replays the touchdown point exactly from the input log', () => {
    const first = new Jump(makeFullConfig());
    flyPattern(first);

    const second = new Jump(makeFullConfig());
    for (const input of first.inputLog) second.step(input);

    expect(second.phase).toBe('landed');
    expect(second.touchdown).not.toBeNull();
    const x = Math.abs((second.touchdown?.pos.x ?? 0) - (first.touchdown?.pos.x ?? 0));
    const y = Math.abs((second.touchdown?.pos.y ?? 0) - (first.touchdown?.pos.y ?? 0));
    const z = Math.abs((second.touchdown?.pos.z ?? 0) - (first.touchdown?.pos.z ?? 0));
    expect(x).toBeLessThan(1e-9);
    expect(y).toBeLessThan(1e-9);
    expect(z).toBeLessThan(1e-9);
  });
});
