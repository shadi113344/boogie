import { describe, expect, it } from 'vitest';
import { CANOPIES } from '@/data/canopies';
import type { CanopyId, CanopySpec } from '@/data/canopies';
import { SEA_LEVEL_DENSITY } from '@/sim/atmosphere';
import type { CanopyInput } from '@/sim/inputs';
import { canopyHeadingRad, createCanopyState, stepCanopy } from '@/sim/canopy/canopy';
import type { CanopyEnv, CanopyState } from '@/sim/canopy/canopy';
import { polarFor, POLAR } from '@/sim/canopy/polar';
import { FT, FPM, G, MPH } from '@/sim/units';
import { vec3 } from '@/sim/vec3';

/** The step of the simulation, in seconds. */
const DT = 1 / 120;

/** The four main canopies: the reserve has no turns of its own. */
const MAINS: CanopyId[] = ['student-280', 'sport-210', 'sport-170', 'elliptical-150'];

/** The height of the turn the spec asks for, in feet, at 90 and at 180 degrees. */
const TURN_LOSS_FT: Record<string, [number, number]> = {
  'student-280': [60, 140],
  'sport-210': [95, 225],
  'sport-170': [125, 275],
  'elliptical-150': [200, 450],
};

/** Sea level, calm air, and the jumper of the tables: 85 kg and 12 kg of gear. */
function seaLevel(bodyMassKg = 85, gearMassKg = 12): CanopyEnv {
  return {
    rho: () => SEA_LEVEL_DENSITY,
    wind: () => vec3(0, 0, 0),
    jumper: { bodyMassKg, gearMassKg },
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

/** A canopy at the start, flying at its full flight speed and sink. */
function trimState(spec: CanopySpec): CanopyState {
  return createCanopyState(vec3(0, 0, 0), trimVelocity(spec), false);
}

/** Flies the canopy for a number of seconds. */
function run(
  s: CanopyState,
  spec: CanopySpec,
  input: CanopyInput,
  env: CanopyEnv,
  seconds: number,
): void {
  const polar = polarFor(spec);
  const steps = Math.round(seconds / DT);
  for (let i = 0; i < steps; i++) stepCanopy(s, spec, polar, input, env, DT);
}

/** The speed of the canopy through the air. */
function airspeed(s: CanopyState): number {
  return Math.hypot(s.vel.x, s.vel.y, s.vel.z);
}

/** How far a number is from the one it should be, as a fraction of it. */
function off(actual: number, target: number): number {
  return Math.abs(actual - target) / target;
}

/** The difference between two headings, wrapped into half a turn. */
function headingDelta(a: number, b: number): number {
  let delta = b - a;
  if (delta > Math.PI) delta -= 2 * Math.PI;
  if (delta < -Math.PI) delta += 2 * Math.PI;
  return delta;
}

/** The state of a canopy that has settled in full flight. */
function settled(spec: CanopySpec, env: CanopyEnv): CanopyState {
  const s = trimState(spec);
  run(s, spec, neutral(), env, 10);
  return s;
}

/**
 * A turn on one toggle: the toggle goes down, and it comes up when the
 * heading has changed by the wanted amount. The height is measured from the
 * toggle going down to the canopy being back at trim.
 */
function toggleTurn(
  spec: CanopySpec,
  env: CanopyEnv,
  targetDeg: number,
): { lossFt: number; seconds: number } {
  const polar = polarFor(spec);
  const s = settled(spec, env);
  const trimSink = -s.vel.y;
  const startY = s.pos.y;
  let heading = canopyHeadingRad(s, env);
  let turned = 0;
  let released = false;
  const input = neutral();
  for (let i = 0; i < 120 * 60; i++) {
    if (released) {
      input.right = 0;
      const atTrim =
        Math.abs(-s.vel.y - trimSink) < 0.1 * trimSink && Math.abs(s.bank) < (2 * Math.PI) / 180;
      if (atTrim) break;
    } else {
      input.right = 1;
      const now = canopyHeadingRad(s, env);
      turned += headingDelta(heading, now);
      heading = now;
      if (Math.abs(turned) >= (targetDeg * Math.PI) / 180) released = true;
    }
    stepCanopy(s, spec, polar, input, env, DT);
  }
  return { lossFt: (startY - s.pos.y) / FT, seconds: s.tS };
}

describe('the canopy', () => {
  it('flies the speed and the sink of its table in full flight', () => {
    for (const id of Object.keys(CANOPIES) as CanopyId[]) {
      const spec = CANOPIES[id];
      const s = settled(spec, seaLevel());
      expect(off(airspeed(s), spec.fullFlight.mph * MPH)).toBeLessThanOrEqual(0.08);
      expect(off(-s.vel.y, spec.fullFlight.fpm * FPM)).toBeLessThanOrEqual(0.08);
    }
  });

  it('flies the speed and the sink of its table at half brakes', () => {
    for (const id of Object.keys(CANOPIES) as CanopyId[]) {
      const spec = CANOPIES[id];
      const env = seaLevel();
      const s = settled(spec, env);
      run(s, spec, neutral({ left: 0.5, right: 0.5 }), env, 30);
      expect(off(airspeed(s), spec.halfBrakes.mph * MPH)).toBeLessThanOrEqual(0.08);
      expect(off(-s.vel.y, spec.halfBrakes.fpm * FPM)).toBeLessThanOrEqual(0.08);
    }
  });

  it('costs the height of the turn when a toggle goes down', () => {
    for (const id of MAINS) {
      const spec = CANOPIES[id];
      const env = seaLevel();
      const [at90, at180] = TURN_LOSS_FT[id] ?? [0, 0];
      const quarter = toggleTurn(spec, env, 90);
      expect(quarter.lossFt).toBeGreaterThan(at90 * 0.8);
      expect(quarter.lossFt).toBeLessThan(at90 * 1.2);
      const half = toggleTurn(spec, env, 180);
      expect(half.lossFt).toBeGreaterThan(at180 * 0.8);
      expect(half.lossFt).toBeLessThan(at180 * 1.2);
    }
  });

  it('turns at the rate the bank and the speed give', () => {
    for (const id of MAINS) {
      const spec = CANOPIES[id];
      const env = seaLevel();
      const polar = polarFor(spec);
      const s = settled(spec, env);
      run(s, spec, neutral({ right: 0.5 }), env, 18);
      const before = canopyHeadingRad(s, env);
      run(s, spec, neutral({ right: 0.5 }), env, 2);
      const yawRate = headingDelta(before, canopyHeadingRad(s, env)) / 2;
      const expected = (G * Math.tan(s.bank)) / airspeed(s);
      expect(Math.abs(yawRate - expected) / expected).toBeLessThanOrEqual(0.05);
    }
  });

  it('slows down in deep brakes without sinking faster than at half brakes', () => {
    for (const id of Object.keys(CANOPIES) as CanopyId[]) {
      const spec = CANOPIES[id];
      const env = seaLevel();
      const half = settled(spec, env);
      run(half, spec, neutral({ left: 0.5, right: 0.5 }), env, 30);
      const deep = settled(spec, env);
      run(deep, spec, neutral({ left: 0.9, right: 0.9 }), env, 30);
      expect(airspeed(deep)).toBeLessThan(airspeed(half));
      const ratio = -deep.vel.y / -half.vel.y;
      expect(ratio).toBeGreaterThanOrEqual(0.7);
      expect(ratio).toBeLessThanOrEqual(1.1);
    }
  });

  it('stalls in full brakes and flies again when the brakes come up', () => {
    for (const id of MAINS) {
      const spec = CANOPIES[id];
      const env = seaLevel();
      const polar = polarFor(spec);
      const s = settled(spec, env);
      const trimSink = -s.vel.y;
      const trimSpeed = airspeed(s);
      const startY = s.pos.y;
      const input = neutral({ left: 1, right: 1 });
      let stalledAt = -1;
      for (let i = 0; i < 120 * 8; i++) {
        stepCanopy(s, spec, polar, input, env, DT);
        if (s.stalled && stalledAt < 0) stalledAt = s.tS;
      }
      expect(stalledAt).toBeGreaterThan(0);
      expect(stalledAt - 10).toBeLessThanOrEqual(3);

      // The brakes come up, and the canopy flies again.
      input.left = 0;
      input.right = 0;
      let lossFt = 0;
      for (let i = 0; i < 120 * 8; i++) {
        stepCanopy(s, spec, polar, input, env, DT);
        if (i === 120 * 6 - 1) lossFt = (startY - s.pos.y) / FT;
      }
      expect(lossFt).toBeGreaterThanOrEqual(200);
      expect(s.stalled).toBe(false);
      expect(Math.abs(s.bank)).toBeLessThan((2 * Math.PI) / 180);
      expect(off(airspeed(s), trimSpeed)).toBeLessThanOrEqual(0.1);
      expect(off(-s.vel.y, trimSink)).toBeLessThanOrEqual(0.1);
    }
  });

  it('surges when the brakes come up, then settles at trim', () => {
    for (const id of MAINS) {
      const spec = CANOPIES[id];
      const env = seaLevel();
      const polar = polarFor(spec);
      const s = settled(spec, env);
      const trimSink = -s.vel.y;
      const input = neutral({ left: 0.5, right: 0.5 });
      for (let i = 0; i < 120 * 30; i++) stepCanopy(s, spec, polar, input, env, DT);
      input.left = 0;
      input.right = 0;
      let surge = 0;
      for (let i = 0; i < 120 * 8; i++) {
        stepCanopy(s, spec, polar, input, env, DT);
        if (i < 120 * 3) surge = Math.max(surge, -s.vel.y / trimSink);
      }
      // Released, the canopy dives forward before it settles back to trim.
      expect(surge).toBeGreaterThan(1.2);
      expect(off(-s.vel.y, trimSink)).toBeLessThanOrEqual(0.05);
    }
  });

  it('turns the front risers into a dive and the rear risers into a glide', () => {
    for (const id of Object.keys(CANOPIES) as CanopyId[]) {
      const spec = CANOPIES[id];
      const env = seaLevel();
      const trim = settled(spec, env);
      const trimSpeed = airspeed(trim);
      const trimSink = -trim.vel.y;
      const glideTrim = trimSpeed / trimSink;

      const front = settled(spec, env);
      run(front, spec, neutral({ frontLeft: 1, frontRight: 1 }), env, 30);
      expect(-front.vel.y / trimSink).toBeGreaterThanOrEqual(2);
      expect(-front.vel.y / trimSink).toBeLessThanOrEqual(3);
      expect(airspeed(front)).toBeGreaterThan(trimSpeed);

      const rear = settled(spec, env);
      run(rear, spec, neutral({ rear: 1 }), env, 30);
      const glideRear = airspeed(rear) / -rear.vel.y;
      expect(glideRear / glideTrim - 1).toBeGreaterThanOrEqual(0.03);
      expect(glideRear / glideTrim - 1).toBeLessThanOrEqual(0.15);
      expect(1 - airspeed(rear) / trimSpeed).toBeGreaterThanOrEqual(0.02);
      expect(1 - airspeed(rear) / trimSpeed).toBeLessThanOrEqual(0.1);
    }
  });

  it('banks the canopy to the right on the right front riser alone', () => {
    const spec = CANOPIES['sport-210'];
    const env = seaLevel();
    const s = settled(spec, env);
    run(s, spec, neutral({ frontRight: 1 }), env, 2);
    // One front riser turns the canopy at four fifths of its bank.
    const wanted = (0.8 * spec.bankMaxDeg * Math.PI) / 180;
    expect(s.bank).toBeGreaterThan(wanted * 0.9);
    expect(s.bank).toBeLessThan(wanted * 1.1);
  });

  it('flies faster and sinks more when the jumper is heavier', () => {
    const spec = CANOPIES['sport-210'];
    const light = settled(spec, seaLevel(85));
    const heavy = settled(spec, seaLevel(110));
    const small = settled(spec, seaLevel(55));
    expect(airspeed(heavy)).toBeGreaterThan(airspeed(light));
    expect(-heavy.vel.y).toBeGreaterThan(-light.vel.y);
    expect(airspeed(small)).toBeLessThan(airspeed(light));
    expect(-small.vel.y).toBeLessThan(-light.vel.y);
    for (const s of [light, heavy, small]) {
      expect(Number.isFinite(s.pos.x)).toBe(true);
      expect(Number.isFinite(s.pos.y)).toBe(true);
      expect(Number.isFinite(s.pos.z)).toBe(true);
      expect(Number.isFinite(s.vel.x)).toBe(true);
      expect(Number.isFinite(s.vel.y)).toBe(true);
      expect(Number.isFinite(s.vel.z)).toBe(true);
      expect(Number.isFinite(s.bank)).toBe(true);
    }
  });

  it('ignores the toggles while the brakes are stowed', () => {
    const spec = CANOPIES['sport-210'];
    const env = seaLevel();
    const polar = polarFor(spec);
    const s = createCanopyState(vec3(0, 0, 0), trimVelocity(spec), true);
    run(s, spec, neutral({ left: 1, right: 1 }), env, 2);
    expect(s.bank).toBe(0);
    expect(s.brakeLeft).toBe(POLAR.stowedBrake);
    expect(s.brakeRight).toBe(POLAR.stowedBrake);

    // The rear risers work while the brakes are stowed.
    const stowed = settled(spec, env);
    const withRear = createCanopyState(vec3(0, 0, 0), trimVelocity(spec), true);
    run(stowed, spec, neutral(), env, 30);
    run(withRear, spec, neutral({ rear: 1 }), env, 30);
    expect(-withRear.vel.y).toBeLessThan(-stowed.vel.y);

    // The brakes come up, and then the toggles work.
    stepCanopy(s, spec, polar, neutral({ unstow: true }), env, DT);
    expect(s.stowed).toBe(false);
    run(s, spec, neutral({ right: 1 }), env, 2);
    expect(s.bank).toBeGreaterThan(0);
  });

  it('swings the jumper ahead in a flare and out in a turn', () => {
    const spec = CANOPIES['sport-210'];
    const env = seaLevel();
    const polar = polarFor(spec);

    // The standard flare stroke: both toggles to half travel, then to deep.
    const flare = settled(spec, env);
    const stroke = neutral();
    let peakFore = 0;
    for (let i = 0; i < 120 * 6; i++) {
      const t = i * DT;
      if (t < 0.3) stroke.left = stroke.right = (t / 0.3) * 0.5;
      else if (t < 1.1) stroke.left = stroke.right = 0.5 + ((t - 0.3) / 0.8) * 0.4;
      else stroke.left = stroke.right = 0.9;
      stepCanopy(flare, spec, polar, stroke, env, DT);
      peakFore = Math.max(peakFore, flare.swingFore);
    }
    expect(peakFore).toBeGreaterThan((10 * Math.PI) / 180);

    // A full toggle turn swings the jumper out of it.
    const turn = settled(spec, env);
    let peakSide = 0;
    const toggle = neutral({ right: 1 });
    for (let i = 0; i < 120 * 6; i++) {
      stepCanopy(turn, spec, polar, toggle, env, DT);
      peakSide = Math.max(peakSide, Math.abs(turn.swingSide));
    }
    expect(peakSide).toBeGreaterThan((5 * Math.PI) / 180);

    // In steady flight the jumper hangs still.
    const steady = settled(spec, env);
    expect(Math.abs(steady.swingFore)).toBeLessThan((1 * Math.PI) / 180);
    expect(Math.abs(steady.swingSide)).toBeLessThan((1 * Math.PI) / 180);
  });
});
