/**
 * The attitude controller and the freefall integrator.
 *
 * The jumper's body is presented to the relative wind: the belly faces the
 * air, and the head, the pitch and the bank are the player's commands,
 * filtered through a lag and a rate limit. Past the stability envelope the
 * body tumbles, the drag drops and the jumper has to arch to get it back.
 *
 * The integrator is semi-implicit Euler at the fixed 120 Hz step, and every
 * random number comes from the seeded generator, so a jump replays exactly.
 * This module imports nothing from three.js or the DOM.
 */

import { type FreefallInput } from '../inputs';
import { bodyAreaScale, exitMassKg, type JumperParams } from '../jumper';
import type { Rng } from '../rng';
import { G } from '../units';
import {
  type Quat,
  type Vec3,
  add,
  cross,
  dot,
  length,
  normalize,
  quatFromAxisAngle,
  quatFromBasis,
  quatFromUnitVectors,
  quatMultiply,
  quatRotate,
  scale,
  sub,
  vec3,
} from '../vec3';
import { BELLY, JUMPSUIT_TRACK, freefallForce, type BodyFrame } from './aero';

/** The head of the canonical body frame: it points north. */
const CANONICAL_FORWARD: Vec3 = vec3(0, 0, -1);

/** The back of the canonical body frame: it points up. */
const CANONICAL_UP: Vec3 = vec3(0, 1, 0);

/** The right hand of the canonical body frame: it points east. */
const CANONICAL_RIGHT: Vec3 = vec3(1, 0, 0);

/** The world up. */
const WORLD_UP: Vec3 = vec3(0, 1, 0);

/** North. */
const NORTH: Vec3 = vec3(0, 0, -1);

const DEG_TO_RAD = Math.PI / 180;
const TWO_PI = Math.PI * 2;

/** What the attitude controller is set up to do. */
export const ATTITUDE = {
  /** How long the attitude takes to follow the input, in seconds. */
  lagS: 0.3,
  /** The fastest a belly turn twists the body, in degrees per second. */
  maxYawRateDeg: 220,
  /** The fastest the pitch and the bank move, in degrees per second. */
  maxPitchBankRateDeg: 90,
  /** Past this pitch or bank the body tumbles, in degrees. */
  tumbleLimitDeg: 70,
  /** How long the jumper has to hold the arch to stop tumbling, in seconds. */
  recoverArchS: 2,
  /** The drag area of a tumbling body, in m². */
  tumbleCdA: 0.40,
  /** How long the jumpsuit track takes to come in, in seconds. */
  trackBlendS: 1.0,
  /** The bank of a full turn in the track, in degrees. */
  trackTurnBankDeg: 40,
  /** The bank of a full turn in the belly, in degrees. */
  bellyTurnBankDeg: 10,
};

/** The pitch of the track at its trim: the head is ten degrees off the wind. */
const TRACK_TRIM_PITCH_RAD = Math.PI / 2 - JUMPSUIT_TRACK.trimAlphaRad;

/** How far the drive input moves the track's pitch, in radians. */
const TRACK_DRIVE_PITCH_RAD = 4 * DEG_TO_RAD;

/** How fast the tumble spin wanders, in radians per second squared. */
const TUMBLE_DRIFT = 0.15;

/** The slowest a tumbling body may spin, in radians per second. */
const TUMBLE_MIN_RATE = 0.5;

/** The fastest a tumbling body may spin, in radians per second. */
const TUMBLE_MAX_RATE = 4;

/** What the freefall needs to know about the world it is falling through. */
export interface FreefallEnv {
  /** The density of the air at a height above mean sea level, in kg/m³. */
  rho: (yMslM: number) => number;
  /** Where the air moves to at a place and a time, in metres per second. */
  wind: (pos: Vec3, tS: number) => Vec3;
  /** How much there is of the jumper. */
  jumper: JumperParams;
}

/** The state of a freefalling body. */
export interface FreefallState {
  /** The place of the jumper, in metres above mean sea level. */
  pos: Vec3;
  /** The velocity of the jumper over the ground, in metres per second. */
  vel: Vec3;
  /** The time since the exit, in seconds. */
  tS: number;
  /**
   * The body orientation presented to the relative wind, with the belly
   * along the wind and the heading in it, before the pitch and the bank.
   */
  base: Quat;
  /** The pitch of the body against the presented frame, in radians. */
  pitch: number;
  /** The bank of the body against the presented frame, in radians. */
  bank: number;
  /** The rate the body twists about the wind, in radians per second. */
  yawRate: number;
  /** How much of the jumpsuit track is mixed in: 0 belly, 1 track. */
  trackBlend: number;
  /** True while the body is out of control. */
  tumbling: boolean;
  /** The axis and the rate the body spins at while tumbling. */
  tumbleSpin: Vec3;
  /** How long the jumper has been holding the arch, in seconds. */
  archFor: number;
}

/** Keeps a number inside a range. */
function clamp(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), high);
}

/** Interpolates between two numbers. */
function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/**
 * Moves a value towards its target with a first-order lag and a rate limit.
 *
 * The lag is the time the value takes to close most of the gap, and the
 * rate limit is how fast it may move while it does.
 */
function lagTo(
  value: number,
  target: number,
  tauS: number,
  dt: number,
  ratePerS: number,
): number {
  const step = (target - value) * (1 - Math.exp(-dt / tauS));
  const limit = ratePerS * dt;
  return value + clamp(step, -limit, limit);
}

/** A unit vector at random, spread evenly over the sphere. */
function randomUnit(rng: Rng): Vec3 {
  const z = rng.range(-1, 1);
  const angle = rng.range(0, TWO_PI);
  const r = Math.sqrt(Math.max(0, 1 - z * z));
  return vec3(r * Math.cos(angle), r * Math.sin(angle), z);
}

/** The spin of a tumbling body: a random axis at 90 to 180 degrees a second. */
function tumbleSpin(rng: Rng): Vec3 {
  return scale(randomUnit(rng), rng.range(90, 180) * DEG_TO_RAD);
}

/**
 * A unit vector perpendicular to `d`, or the zero vector if there is none.
 *
 * The first choice is north, because that is where the head of a jumper
 * who is not turning is; the second is any horizontal direction; the last
 * is anything at all.
 */
function perpendicularTo(d: Vec3): Vec3 {
  const north = sub(NORTH, scale(d, dot(NORTH, d)));
  if (length(north) > 1e-6) return normalize(north);
  const horizontal = vec3(-d.z, 0, d.x);
  if (length(horizontal) > 1e-6) return normalize(horizontal);
  const sideways = cross(d, WORLD_UP);
  if (length(sideways) > 1e-6) return normalize(sideways);
  return normalize(cross(d, CANONICAL_RIGHT));
}

/**
 * Starts a freefall.
 *
 * The body is presented to the relative wind: the belly faces the air and
 * the back is along the wind. `headUp` is the exit, where the head points
 * at the sky and the chest takes the jump run; without it the head lies
 * along the horizontal velocity and the belly faces straight down. A pitch
 * or a bank past the stability envelope starts a tumble, which is what a
 * poor exit looks like.
 */
export function createFreefallState(o: {
  pos: Vec3;
  vel: Vec3;
  wind: Vec3;
  headUp?: boolean;
  pitch?: number;
  bank?: number;
}): FreefallState {
  const air = sub(o.vel, o.wind);
  const d = normalize(air);
  const up = scale(d, -1);

  let forward: Vec3;
  if (o.headUp) {
    forward = sub(WORLD_UP, scale(d, dot(WORLD_UP, d)));
  } else {
    const horizontal = vec3(air.x, 0, air.z);
    forward = sub(horizontal, scale(d, dot(horizontal, d)));
  }
  if (length(forward) < 1e-6) forward = perpendicularTo(d);

  const pitch = o.pitch ?? 0;
  const bank = o.bank ?? 0;
  const limit = ATTITUDE.tumbleLimitDeg * DEG_TO_RAD;

  return {
    pos: { ...o.pos },
    vel: { ...o.vel },
    tS: 0,
    base: quatFromBasis(normalize(forward), up),
    pitch,
    bank,
    yawRate: 0,
    trackBlend: 0,
    tumbling: Math.abs(pitch) > limit || Math.abs(bank) > limit,
    tumbleSpin: vec3(0, 0, 0),
    archFor: 0,
  };
}

/**
 * Where the body points: the head and the back in the world frame.
 *
 * The body is the presented frame with the pitch and the bank on top: the
 * pitch is head-low when it is positive and turns about the body's right
 * hand, the bank drops the right shoulder when it is positive and turns
 * about the head.
 */
export function bodyFrame(s: FreefallState): BodyFrame {
  const pitch = quatFromAxisAngle(CANONICAL_RIGHT, -s.pitch);
  const bank = quatFromAxisAngle(CANONICAL_FORWARD, s.bank);
  const q = quatMultiply(quatMultiply(s.base, pitch), bank);
  return {
    forward: quatRotate(q, CANONICAL_FORWARD),
    up: quatRotate(q, CANONICAL_UP),
  };
}

/** The direction the body moves through the air, in the world frame. */
export function airDirection(s: FreefallState, env: FreefallEnv): Vec3 {
  return normalize(sub(s.vel, env.wind(s.pos, s.tS)));
}

/**
 * The pitch the track holds at a drive input.
 *
 * In the track the head lies along the flight path, so the body has to be
 * turned most of the way over from the belly box. The pitch is the angle
 * the head is turned down, and the angle of attack is what is left of the
 * ninety degrees between the head and the wind: the trim leaves ten
 * degrees of attack, a head-low drive takes six and legs out fourteen.
 *
 * The plan writes this pitch as `−(90° − trim + drive · 4°)`, which counts
 * the same turn the other way round. With the head-low-positive pitch of
 * the belly box the turn is `+(90° − trim + drive · 4°)`, and the angle of
 * attack is then `90° − pitch`.
 */
function trackPitch(drive: number): number {
  return TRACK_TRIM_PITCH_RAD + drive * TRACK_DRIVE_PITCH_RAD;
}

/**
 * Moves the freefall on by one step.
 *
 * The order of the step is the order of the physics: the body follows the
 * relative wind, the track comes in, the attitude controller sets the
 * twist, the pitch and the bank, and only then do the air and the ground
 * move.
 */
export function stepFreefall(
  s: FreefallState,
  input: FreefallInput,
  env: FreefallEnv,
  dt: number,
  rng: Rng,
): void {
  const wind = env.wind(s.pos, s.tS);
  const airVel = sub(s.vel, wind);
  const d = normalize(airVel);
  const rho = env.rho(s.pos.y);
  const mass = exitMassKg(env.jumper);
  const areaScale = bodyAreaScale(env.jumper);

  if (!s.tumbling) {
    // The body follows the relative wind without yawing: the back of the
    // presented frame stays along the wind, and the heading of the body
    // is left where it is. A tumbling body is not presented to the wind
    // at all, so the frame is left to the spin.
    const dOld = scale(quatRotate(s.base, CANONICAL_UP), -1);
    s.base = quatMultiply(quatFromUnitVectors(dOld, d), s.base);
  }

  s.trackBlend = lagTo(
    s.trackBlend,
    input.track ? 1 : 0,
    ATTITUDE.trackBlendS,
    dt,
    Number.POSITIVE_INFINITY,
  );

  const maxPitchBankRate = ATTITUDE.maxPitchBankRateDeg * DEG_TO_RAD;
  const tumbleLimit = ATTITUDE.tumbleLimitDeg * DEG_TO_RAD;

  if (!s.tumbling) {
    // A belly turn twists the body; in the track the turn is a bank.
    const yawTarget =
      (1 - s.trackBlend) * input.turn * ATTITUDE.maxYawRateDeg * DEG_TO_RAD;
    s.yawRate = lagTo(s.yawRate, yawTarget, ATTITUDE.lagS, dt, Number.POSITIVE_INFINITY);
    s.base = quatMultiply(quatFromAxisAngle(d, s.yawRate * dt), s.base);

    const pitchTarget =
      (1 - s.trackBlend) * input.drive * BELLY.maxPitchRad +
      s.trackBlend * trackPitch(input.drive);
    const bankTarget =
      input.turn *
      lerp(
        ATTITUDE.bellyTurnBankDeg * DEG_TO_RAD,
        ATTITUDE.trackTurnBankDeg * DEG_TO_RAD,
        s.trackBlend,
      );
    s.pitch = lagTo(s.pitch, pitchTarget, ATTITUDE.lagS, dt, maxPitchBankRate);
    s.bank = lagTo(s.bank, bankTarget, ATTITUDE.lagS, dt, maxPitchBankRate);

    if (
      s.trackBlend < 0.5 &&
      (Math.abs(s.pitch) > tumbleLimit || Math.abs(s.bank) > tumbleLimit)
    ) {
      s.tumbling = true;
      s.tumbleSpin = tumbleSpin(rng);
      s.archFor = 0;
    }
  } else {
    if (length(s.tumbleSpin) === 0) s.tumbleSpin = tumbleSpin(rng);
    s.base = quatMultiply(
      quatFromAxisAngle(s.tumbleSpin, length(s.tumbleSpin) * dt),
      s.base,
    );
    s.tumbleSpin = add(s.tumbleSpin, scale(randomUnit(rng), TUMBLE_DRIFT * dt));
    const rate = length(s.tumbleSpin);
    if (rate > 0) {
      s.tumbleSpin = scale(s.tumbleSpin, clamp(rate, TUMBLE_MIN_RATE, TUMBLE_MAX_RATE) / rate);
    }

    if (input.fallRate >= 0.8) s.archFor += dt;
    else s.archFor = 0;

    if (s.archFor >= ATTITUDE.recoverArchS) {
      // The jumper has the body back: it is presented to the wind again,
      // belly to the wind, keeping the heading of the head.
      const head = quatRotate(s.base, CANONICAL_FORWARD);
      let forward = sub(head, scale(d, dot(head, d)));
      if (length(forward) < 1e-6) forward = perpendicularTo(d);
      s.tumbling = false;
      s.pitch = 0;
      s.bank = 0;
      s.yawRate = 0;
      s.archFor = 0;
      s.base = quatFromBasis(normalize(forward), scale(d, -1));
    }
  }

  const speed = length(airVel);
  const q = 0.5 * rho * speed * speed;
  const force = s.tumbling
    ? scale(d, -q * ATTITUDE.tumbleCdA * areaScale)
    : freefallForce({
        airVel,
        rho,
        body: bodyFrame(s),
        fallRate: input.fallRate,
        trackBlend: s.trackBlend,
        areaScale,
      });

  const accel = add(scale(force, 1 / mass), vec3(0, -G, 0));
  s.vel = add(s.vel, scale(accel, dt));
  s.pos = add(s.pos, scale(s.vel, dt));
  s.tS += dt;
}
