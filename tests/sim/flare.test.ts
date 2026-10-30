import { describe, expect, it } from 'vitest';
import { CANOPIES } from '@/data/canopies';
import type { CanopyId, CanopySpec } from '@/data/canopies';
import { SEA_LEVEL_DENSITY } from '@/sim/atmosphere';
import type { CanopyInput } from '@/sim/inputs';
import { createCanopyState, stepCanopy } from '@/sim/canopy/canopy';
import type { CanopyEnv, CanopyState } from '@/sim/canopy/canopy';
import { polarFor } from '@/sim/canopy/polar';
import { classifyLanding, type LandingOutcome } from '@/sim/landing';
import { FT, FPM, MPH } from '@/sim/units';
import { vec3 } from '@/sim/vec3';

/**
 * The flare.
 *
 * A canopy is trimmed, the jumper is a height above the ground, and the
 * toggles go down: half travel in three tenths of a second, then deep over
 * eight tenths more, and then they stay down. The canopy turns into the
 * wind, the sink comes off, and the jumper lands.
 *
 * The test flies the canopy model on its own, over flat ground at sea
 * level, and asks at which heights the landing is soft. The windows the
 * model gives are six to seventeen feet for the Student 280, nine to eleven
 * for the Sport 210, fourteen to sixteen for the Sport 170 and twenty three
 * to twenty five for the Elliptical 150: the faster the canopy, the higher
 * the flare has to start.
 */

/** The step of the simulation, in seconds. */
const DT = 1 / 120;

/** The four main canopies: the reserve is not landed from a pattern. */
const MAINS: CanopyId[] = ['student-280', 'sport-210', 'sport-170', 'elliptical-150'];

/** Sea level, and the jumper the tables of the canopies are written for. */
function seaLevel(wind = vec3(0, 0, 0)): CanopyEnv {
  return {
    rho: () => SEA_LEVEL_DENSITY,
    wind: () => wind,
    jumper: { bodyMassKg: 85, gearMassKg: 12 },
  };
}

/** The jumper holding nothing. */
function neutral(over: Partial<CanopyInput> = {}): CanopyInput {
  return { left: 0, right: 0, frontLeft: 0, frontRight: 0, rear: 0, unstow: false, ...over };
}

/** The velocity the canopy flies at in full flight: its table speed and sink. */
function trimVelocity(spec: CanopySpec) {
  const speed = spec.fullFlight.mph * MPH;
  const sink = spec.fullFlight.fpm * FPM;
  const gamma = Math.asin(sink / speed);
  return vec3(0, -sink, -speed * Math.cos(gamma));
}

/** The canopy, settled in full flight. */
function settled(spec: CanopySpec, env: CanopyEnv): CanopyState {
  const s = createCanopyState(vec3(0, 1000, 0), trimVelocity(spec), false);
  const polar = polarFor(spec);
  const input = neutral();
  for (let i = 0; i < Math.round(10 / DT); i++) stepCanopy(s, spec, polar, input, env, DT);
  return s;
}

/** What a flare from a height above the ground came to. */
interface Flare {
  /** The height the flare was started from, in feet. */
  heightFt: number;
  /** How fast the jumper hit the ground, in metres per second. */
  verticalMs: number;
  /** How fast the jumper was going over the ground, in metres per second. */
  groundSpeedMs: number;
  /** How the landing came out. */
  outcome: LandingOutcome;
  /** The longest run of the flare with the sink under a metre per second. */
  levelGlideS: number;
  /** The sink the canopy flies at in full flight, in metres per second. */
  trimSinkMs: number;
}

/**
 * Flares the canopy from a height above the ground and lands it.
 *
 * @param spec the canopy being flown
 * @param heightFt the height the flare is started from, in feet
 * @param env the air the canopy flies through
 */
function flare(spec: CanopySpec, heightFt: number, env: CanopyEnv): Flare {
  const polar = polarFor(spec);
  const s = settled(spec, env);
  const trimSinkMs = -s.vel.y;
  s.pos = vec3(s.pos.x, heightFt * FT, s.pos.z);

  const stroke = neutral();
  let levelGlideS = 0;
  let levelFor = 0;
  let steps = 0;
  while (s.pos.y > 0 && steps < 120 * 60) {
    const t = steps * DT;
    if (t < 0.3) stroke.left = stroke.right = (t / 0.3) * 0.5;
    else if (t < 1.1) stroke.left = stroke.right = 0.5 + ((t - 0.3) / 0.8) * 0.4;
    else stroke.left = stroke.right = 0.9;
    stepCanopy(s, spec, polar, stroke, env, DT);
    steps++;
    if (-s.vel.y < 1) {
      levelFor += DT;
      if (levelFor > levelGlideS) levelGlideS = levelFor;
    } else {
      levelFor = 0;
    }
  }

  const verticalMs = -s.vel.y;
  const groundSpeedMs = Math.hypot(s.vel.x, s.vel.z);
  return {
    heightFt,
    verticalMs,
    groundSpeedMs,
    outcome: classifyLanding(verticalMs, groundSpeedMs, false),
    levelGlideS,
    trimSinkMs,
  };
}

/** Every height from four to forty feet, one foot at a time. */
function search(spec: CanopySpec, env: CanopyEnv): Flare[] {
  const flares: Flare[] = [];
  for (let h = 4; h <= 40; h++) flares.push(flare(spec, h, env));
  return flares;
}

/** The softest landing of a search: the lowest sink at the touchdown. */
function best(flares: Flare[]): Flare {
  let winner = flares[0] as Flare;
  for (const f of flares) if (f.verticalMs < winner.verticalMs) winner = f;
  return winner;
}

/** The landings of a search that are soft: slow down and slow along. */
function soft(flares: Flare[]): Flare[] {
  return flares.filter((f) => f.verticalMs < 1.5 && f.groundSpeedMs < 8);
}

describe('the flare', () => {
  it('lands softly from a window of heights for every canopy', () => {
    for (const id of MAINS) {
      const spec = CANOPIES[id];
      const window = soft(search(spec, seaLevel()));
      expect(window.length).toBeGreaterThan(0);
      const heights = window.map((f) => f.heightFt);
      expect(Math.min(...heights)).toBeGreaterThanOrEqual(6);
      expect(Math.max(...heights)).toBeLessThanOrEqual(30);
    }
  });

  it('lands the Sport 170 softly from ten to twenty feet', () => {
    const spec = CANOPIES['sport-170'];
    const window = soft(search(spec, seaLevel()));
    const heights = window.map((f) => f.heightFt);
    expect(heights.length).toBeGreaterThan(0);
    expect(Math.min(...heights)).toBeGreaterThanOrEqual(10);
    expect(Math.max(...heights)).toBeLessThanOrEqual(20);
  });

  it('glides the canopy level after the flare', () => {
    // The level glide is the run of the flare with the sink under a metre
    // per second: 1.31 s for the Student 280, 1.47 s for the Sport 210,
    // 1.62 s for the Sport 170 and 1.76 s for the Elliptical 150.
    for (const id of MAINS) {
      const spec = CANOPIES[id];
      const b = best(search(spec, seaLevel()));
      expect(b.levelGlideS).toBeGreaterThan(1.25);
    }
    // The Sport 170, the canopy the plan asks about, holds it longer.
    const sport = best(search(CANOPIES['sport-170'], seaLevel()));
    expect(sport.levelGlideS).toBeGreaterThanOrEqual(1.5);
  });

  it('is too late when the flare starts from four feet', () => {
    for (const id of MAINS) {
      const spec = CANOPIES[id];
      const b = best(search(spec, seaLevel()));
      const late = flare(spec, 4, seaLevel());
      // The canopy is still flying at nearly its full flight sink.
      expect(late.verticalMs).toBeGreaterThanOrEqual(0.55 * b.trimSinkMs);
      expect(late.verticalMs).toBeGreaterThanOrEqual(b.verticalMs + 0.5);
    }
  });

  it('lands harder when the flare starts from too high', () => {
    for (const id of MAINS) {
      const spec = CANOPIES[id];
      const b = best(search(spec, seaLevel()));
      const high = flare(spec, 2 * b.heightFt + 6, seaLevel());
      expect(high.verticalMs).toBeGreaterThanOrEqual(b.verticalMs + 0.4);
    }
  });

  it('lands the Sport 210 on its feet into a headwind', () => {
    const spec = CANOPIES['sport-210'];
    const b = best(search(spec, seaLevel()));
    // The canopy flies north, so the wind blows south: four metres per
    // second of headwind.
    const intoWind = flare(spec, b.heightFt, seaLevel(vec3(0, 0, 4)));
    expect(intoWind.outcome).toBe('stand-up');
  });
});
