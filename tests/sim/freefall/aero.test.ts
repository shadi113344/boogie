import { describe, expect, it } from 'vitest';
import {
  BELLY,
  JUMPSUIT_TRACK,
  bellyCdA,
  freefallForce,
  type BodyFrame,
} from '@/sim/freefall/aero';
import { DEFAULT_JUMPER, bodyAreaScale, clampBodyMass, exitMassKg } from '@/sim/jumper';
import { G, MPH } from '@/sim/units';
import { type Vec3, cross, dot, length, normalize, scale, sub } from '@/sim/vec3';

/**
 * The freefall table of the spec (section 7.1), asserted within ±5 percent.
 * The numbers are the sea-level equivalents of the default jumper.
 */
const RHO = 1.225;
const DT = 1 / 120;
const STEPS = 90 * 120;
const NORTH: Vec3 = { x: 0, y: 0, z: -1 };
const WORLD_UP: Vec3 = { x: 0, y: 1, z: 0 };

/** Rotates `v` about the unit axis `axis` by `rad`, right-hand rule. */
function rotateAbout(v: Vec3, axis: Vec3, rad: number): Vec3 {
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  const k = cross(axis, v);
  const kd = dot(axis, v);
  return {
    x: v.x * c + k.x * s + axis.x * kd * (1 - c),
    y: v.y * c + k.y * s + axis.y * kd * (1 - c),
    z: v.z * c + k.z * s + axis.z * kd * (1 - c),
  };
}

/**
 * The belly attitude: the head points north across the relative wind, the
 * back points into it, and the pitch rotates both about the body's right
 * axis. A positive pitch is head-low.
 */
function bellyFrame(d: Vec3, pitchRad: number): BodyFrame {
  const forward = normalize(sub(NORTH, scale(d, dot(NORTH, d))));
  const up = scale(d, -1);
  const right = cross(forward, up);
  return {
    forward: rotateAbout(forward, right, -pitchRad),
    up: rotateAbout(up, right, -pitchRad),
  };
}

/**
 * The jumpsuit track attitude: the head comes up above the flight path by
 * the trim angle and the back is the third axis of the body.
 */
function trackFrame(d: Vec3, trimRad: number): BodyFrame {
  const right = normalize(cross(d, WORLD_UP));
  const forward = rotateAbout(d, right, trimRad);
  return { forward, up: cross(right, forward) };
}

interface Run {
  /** The downward speed, m/s. */
  verticalMs: number;
  /** The horizontal speed, m/s. */
  horizontalMs: number;
  /** The horizontal speed along the horizontal head direction, m/s. */
  alongHeadMs: number;
  /** The horizontal speed over the vertical speed. */
  glide: number;
  /** The airspeed over the ground, m/s. */
  airspeedMs: number;
}

/**
 * A point mass of the exit mass under gravity and `freefallForce`, in still
 * air at the standard sea-level density, re-aiming the body every step so it
 * holds its attitude against the relative wind.
 */
function runFreefall(o: {
  mode: 'belly' | 'track';
  pitchRad?: number;
  fallRate?: number;
  startVel: Vec3;
  bodyMassKg?: number;
}): Run {
  const jumper = {
    bodyMassKg: o.bodyMassKg ?? DEFAULT_JUMPER.bodyMassKg,
    gearMassKg: DEFAULT_JUMPER.gearMassKg,
  };
  const mass = exitMassKg(jumper);
  const areaScale = bodyAreaScale(jumper);
  const pitch = o.pitchRad ?? 0;
  const fallRate = o.fallRate ?? 0;
  let vel: Vec3 = { ...o.startVel };
  let body: BodyFrame = { forward: NORTH, up: WORLD_UP };

  for (let i = 0; i < STEPS; i++) {
    const d = normalize(vel);
    body =
      o.mode === 'belly'
        ? bellyFrame(d, pitch)
        : trackFrame(d, JUMPSUIT_TRACK.trimAlphaRad);
    const force = freefallForce({
      airVel: vel,
      rho: RHO,
      body,
      fallRate,
      trackBlend: o.mode === 'track' ? 1 : 0,
      areaScale,
    });
    vel = {
      x: vel.x + (force.x / mass) * DT,
      y: vel.y + (force.y / mass - G) * DT,
      z: vel.z + (force.z / mass) * DT,
    };
  }

  const verticalMs = -vel.y;
  const horizontalMs = Math.hypot(vel.x, vel.z);
  const head = normalize({ x: body.forward.x, y: 0, z: body.forward.z });
  return {
    verticalMs,
    horizontalMs,
    alongHeadMs: vel.x * head.x + vel.z * head.z,
    glide: horizontalMs / verticalMs,
    airspeedMs: length(vel),
  };
}

describe('jumper', () => {
  it('has a default of 85 kg of body and 12 kg of gear', () => {
    expect(DEFAULT_JUMPER.bodyMassKg).toBe(85);
    expect(DEFAULT_JUMPER.gearMassKg).toBe(12);
    expect(exitMassKg(DEFAULT_JUMPER)).toBe(97);
  });

  it('keeps the body mass between 55 and 110 kg', () => {
    expect(clampBodyMass(10)).toBe(55);
    expect(clampBodyMass(80)).toBe(80);
    expect(clampBodyMass(200)).toBe(110);
  });

  it('scales the body area with the two thirds power of the mass', () => {
    expect(bodyAreaScale(DEFAULT_JUMPER)).toBeCloseTo(1, 12);
    expect(bodyAreaScale({ bodyMassKg: 55, gearMassKg: 12 })).toBeCloseTo(
      (55 / 85) ** (2 / 3),
      12,
    );
    expect(bodyAreaScale({ bodyMassKg: 110, gearMassKg: 12 })).toBeCloseTo(
      (110 / 85) ** (2 / 3),
      12,
    );
  });
});

describe('belly drag area', () => {
  it('is 0.55 flat, 0.45 hard arched and 0.68 de-arched', () => {
    expect(bellyCdA(0, 1)).toBeCloseTo(0.55, 12);
    expect(bellyCdA(1, 1)).toBeCloseTo(0.45, 12);
    expect(bellyCdA(-1, 1)).toBeCloseTo(0.68, 12);
  });

  it('follows the arch input in between and scales with the body', () => {
    expect(bellyCdA(0.5, 1)).toBeCloseTo(0.5, 12);
    expect(bellyCdA(-0.5, 1)).toBeCloseTo(0.615, 12);
    expect(bellyCdA(0, 2)).toBeCloseTo(1.1, 12);
  });
});

describe('freefall aerodynamics', () => {
  it('falls at 120 mph in a neutral belly box, without drift', () => {
    const run = runFreefall({ mode: 'belly', startVel: { x: 0, y: -50, z: 0 } });
    expect(run.verticalMs / MPH).toBeGreaterThan(114);
    expect(run.verticalMs / MPH).toBeLessThan(126);
    expect(run.horizontalMs / MPH).toBeLessThan(1);
  });

  it('falls faster in a hard arch', () => {
    const run = runFreefall({
      mode: 'belly',
      fallRate: 1,
      startVel: { x: 0, y: -50, z: 0 },
    });
    expect(run.verticalMs / MPH).toBeGreaterThan(123.5);
    expect(run.verticalMs / MPH).toBeLessThan(141.8);
  });

  it('falls slower de-arched', () => {
    const run = runFreefall({
      mode: 'belly',
      fallRate: -1,
      startVel: { x: 0, y: -50, z: 0 },
    });
    expect(run.verticalMs / MPH).toBeGreaterThan(99.8);
    expect(run.verticalMs / MPH).toBeLessThan(115.5);
  });

  it('turns speed into a glide along the head at full forward drive', () => {
    const run = runFreefall({
      mode: 'belly',
      pitchRad: BELLY.maxPitchRad,
      startVel: { x: 0, y: -50, z: 0 },
    });
    expect(run.verticalMs / MPH).toBeGreaterThan(114);
    expect(run.verticalMs / MPH).toBeLessThan(126);
    expect(run.horizontalMs / MPH).toBeGreaterThan(9.5);
    expect(run.horizontalMs / MPH).toBeLessThan(15.8);
    expect(run.alongHeadMs).toBeGreaterThan(0);
    expect(run.glide).toBeGreaterThan(0.08);
    expect(run.glide).toBeLessThan(0.13);
  });

  it('glides in a flat jumpsuit track', () => {
    const run = runFreefall({ mode: 'track', startVel: { x: 0, y: -45, z: -30 } });
    expect(run.verticalMs / MPH).toBeGreaterThan(90);
    expect(run.verticalMs / MPH).toBeLessThan(115.5);
    expect(run.horizontalMs / MPH).toBeGreaterThan(52);
    expect(run.horizontalMs / MPH).toBeLessThan(73.5);
    expect(run.glide).toBeGreaterThan(0.57);
    expect(run.glide).toBeLessThan(0.74);
  });

  it('falls faster the heavier the jumper is', () => {
    const light = runFreefall({
      mode: 'belly',
      bodyMassKg: 55,
      startVel: { x: 0, y: -50, z: 0 },
    });
    const middle = runFreefall({ mode: 'belly', bodyMassKg: 85, startVel: { x: 0, y: -50, z: 0 } });
    const heavy = runFreefall({
      mode: 'belly',
      bodyMassKg: 110,
      startVel: { x: 0, y: -50, z: 0 },
    });
    for (const run of [light, middle, heavy]) {
      expect(Number.isFinite(run.verticalMs)).toBe(true);
      expect(Number.isFinite(run.horizontalMs)).toBe(true);
    }
    expect(light.verticalMs).toBeLessThan(middle.verticalMs);
    expect(middle.verticalMs).toBeLessThan(heavy.verticalMs);
  });
});
