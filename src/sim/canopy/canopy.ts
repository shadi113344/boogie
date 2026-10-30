/**
 * The canopy in flight: brakes, bank, dive, stall, risers and the swinging
 * of the jumper under the canopy.
 *
 * The canopy is a point mass with a quasi steady polar. The brakes change
 * the lift and the drag, the lift follows the brakes quickly and the drag
 * follows them over seconds, so a deep brake takes the speed out of the
 * canopy before it takes the sink out of it. A toggle banks the canopy, the
 * bank makes it dive, and the dive is what makes a turn cost height.
 *
 * The swinging of the jumper under the canopy is a pendulum on the risers:
 * braking swings the jumper ahead of the canopy, a turn swings him out of
 * it. It is an output for the camera and for the debrief; it does not feed
 * back into the forces.
 *
 * This module imports nothing from three.js or the DOM.
 */

import type { CanopySpec } from '@/data/canopies';
import { SEA_LEVEL_DENSITY } from '@/sim/atmosphere';
import type { CanopyInput } from '@/sim/inputs';
import { exitMassKg } from '@/sim/jumper';
import type { JumperParams } from '@/sim/jumper';
import { FT, G } from '@/sim/units';
import { add, cross, dot, length, normalize, scale, sub, vec3 } from '@/sim/vec3';
import type { Vec3 } from '@/sim/vec3';
import { POLAR } from './polar';
import type { Polar } from './polar';

/** The air the canopy flies through, and the jumper under it. */
export interface CanopyEnv {
  /** The density of the air at an altitude above mean sea level, in kg/m³. */
  rho: (yMslM: number) => number;
  /** The wind at a place and a time, in metres per second. */
  wind: (pos: Vec3, tS: number) => Vec3;
  /** The jumper hanging under the canopy. */
  jumper: JumperParams;
}

/** The state of the canopy and of the jumper under it. */
export interface CanopyState {
  /** Where the canopy is, in metres. */
  pos: Vec3;
  /** How fast the canopy is moving, in metres per second. */
  vel: Vec3;
  /** How long the canopy has been flying, in seconds. */
  tS: number;
  /** The bank of the canopy, in radians; positive turns right. */
  bank: number;
  /** The brake travel the lift is following, from 0 to 1. */
  liftBrake: number;
  /** The brake travel the drag is following, from 0 to 1. */
  dragBrake: number;
  /** How deep the canopy is diving, from 0 to 1. */
  dive: number;
  /** True while the canopy is stalled. */
  stalled: boolean;
  /** How long the canopy has been deep and slow, in seconds. */
  deepFor: number;
  /** True while the brakes are stowed. */
  stowed: boolean;
  /** How far the jumper hangs ahead of the canopy, in radians. */
  swingFore: number;
  /** How fast the jumper swings fore and aft, in radians per second. */
  swingForeRate: number;
  /** How far the jumper hangs to the right of the canopy, in radians. */
  swingSide: number;
  /** How fast the jumper swings sideways, in radians per second. */
  swingSideRate: number;
  /** The left toggle that was applied, for the model and the debrief. */
  brakeLeft: number;
  /** The right toggle that was applied, for the model and the debrief. */
  brakeRight: number;
}

const UP: Vec3 = { x: 0, y: 1, z: 0 };
const DEG_TO_RAD = Math.PI / 180;

/** Keeps a brake travel inside the stroke. */
function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/** Keeps a number inside a range. */
function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

/**
 * Moves a number towards another one without going past it and without
 * moving faster than `maxStep`.
 */
function moveToward(current: number, target: number, maxStep: number): number {
  const gap = target - current;
  if (Math.abs(gap) <= maxStep) return target;
  return current + Math.sign(gap) * maxStep;
}

/**
 * A new canopy, flying at the speed and in the direction it was given.
 */
export function createCanopyState(pos: Vec3, vel: Vec3, stowed: boolean): CanopyState {
  const brake = stowed ? POLAR.stowedBrake : 0;
  return {
    pos: { ...pos },
    vel: { ...vel },
    tS: 0,
    bank: 0,
    liftBrake: brake,
    dragBrake: brake,
    dive: 0,
    stalled: false,
    deepFor: 0,
    stowed,
    swingFore: 0,
    swingForeRate: 0,
    swingSide: 0,
    swingSideRate: 0,
    brakeLeft: brake,
    brakeRight: brake,
  };
}

/**
 * The heading the canopy is flying, in radians clockwise from north: the
 * heading of the air velocity, which is the only heading a canopy has.
 */
export function canopyHeadingRad(s: CanopyState, env: CanopyEnv): number {
  const va = sub(s.vel, env.wind(s.pos, s.tS));
  return Math.atan2(va.x, -va.z);
}

/**
 * Flies the canopy one step of the simulation.
 */
export function stepCanopy(
  s: CanopyState,
  spec: CanopySpec,
  polar: Polar,
  input: CanopyInput,
  env: CanopyEnv,
  dt: number,
): void {
  const mass = exitMassKg(env.jumper);
  const areaM2 = spec.areaFt2 * FT * FT;

  // The brakes. While they are stowed the toggles are ignored, and the
  // canopy flies with the brakes at their stowed travel until the jumper
  // unstows them.
  if (s.stowed && input.unstow) s.stowed = false;
  if (s.stowed) {
    s.brakeLeft = POLAR.stowedBrake;
    s.brakeRight = POLAR.stowedBrake;
  } else {
    s.brakeLeft = clamp01(input.left);
    s.brakeRight = clamp01(input.right);
  }

  const sym = Math.min(s.brakeLeft, s.brakeRight);
  const diff = s.brakeRight - s.brakeLeft;
  const frontLeft = clamp01(input.frontLeft);
  const frontRight = clamp01(input.frontRight);
  const frontSym = Math.min(frontLeft, frontRight);
  const frontDiff = frontRight - frontLeft;
  const rear = clamp01(input.rear);

  // The lift follows the brakes in a moment; the drag takes seconds, so the
  // canopy loses its speed before it loses its sink.
  s.liftBrake += (sym - s.liftBrake) * (1 - Math.exp(-dt / POLAR.liftLagS));
  const dragLag = sym < s.dragBrake ? POLAR.dragReleaseLagS : POLAR.dragLagS;
  s.dragBrake += (sym - s.dragBrake) * (1 - Math.exp(-dt / dragLag));

  // The bank: into a turn at the roll rate, out of one at the roll out rate.
  const bankTarget = clamp(diff + 0.8 * frontDiff, -1, 1) * spec.bankMaxDeg * DEG_TO_RAD;
  const rollingIn = Math.abs(bankTarget) > Math.abs(s.bank);
  const rollRate = (rollingIn ? spec.rollRateDegS : spec.rollOutDegS) * DEG_TO_RAD;
  s.bank = moveToward(s.bank, bankTarget, rollRate * dt);

  // The dive: the nose drops while the canopy is banked, and comes back up
  // when the bank comes off.
  const diveTarget = Math.sin(s.bank) ** 2;
  const diveLag = diveTarget > s.dive ? spec.diveBuildS : spec.diveRecoverS;
  s.dive += (diveTarget - s.dive) * (1 - Math.exp(-dt / diveLag));

  // The air the canopy is flying through.
  const airVel = sub(s.vel, env.wind(s.pos, s.tS));
  const airspeed = length(airVel);
  const dir: Vec3 = airspeed > 1e-6 ? scale(airVel, 1 / airspeed) : vec3(0, -1, 0);
  const rho = env.rho(s.pos.y);
  const q = 0.5 * rho * airspeed * airspeed * areaM2;

  // The stall: deep brakes and too much speed taken out of the canopy.
  const fullFlightHere =
    polar.fullFlightAirspeedMs *
    Math.sqrt((mass / POLAR.referenceMassKg) * (SEA_LEVEL_DENSITY / rho));
  const tooSlow = airspeed < POLAR.stallSpeedShare * fullFlightHere;
  if (s.liftBrake >= POLAR.stallBrake && tooSlow) s.deepFor += dt;
  else s.deepFor = 0;
  if (!s.stalled && s.deepFor >= POLAR.stallHoldS) s.stalled = true;
  if (s.stalled && s.liftBrake < 0.5) s.stalled = false;

  // The lift and the drag of this step.
  let cl =
    polar.cl(s.liftBrake) *
    (1 - spec.diveGain * s.dive) *
    (1 - POLAR.frontRiserLift * frontSym) *
    (1 + POLAR.rearRiserLift * rear);
  let cd =
    (polar.cd(s.dragBrake) + POLAR.turnDrag * Math.abs(diff)) *
    (1 - POLAR.frontRiserDrag * frontSym) *
    (1 + POLAR.rearRiserDrag * rear);
  if (s.stalled) {
    cl = POLAR.stallCL;
    cd = POLAR.stallCD;
  }

  // The lift points up, perpendicular to the flight path, and the bank
  // tips it to the right.
  const horizontal = vec3(dir.x, 0, dir.z);
  const trackDir = length(horizontal) > 1e-6 ? normalize(horizontal) : vec3(0, 0, -1);
  let lift0 = normalize(sub(UP, scale(dir, dot(UP, dir))));
  let right = cross(dir, lift0);
  if (length(lift0) < 1e-6) {
    // The canopy is falling straight down: there is no up to be
    // perpendicular to, so the lift points up and the bank is about the
    // horizontal right axis.
    lift0 = UP;
    right = cross(trackDir, UP);
  }
  const lift = add(scale(lift0, Math.cos(s.bank)), scale(right, Math.sin(s.bank)));

  // The force on the canopy, and what it does to the flight.
  const force = add(scale(lift, q * cl), scale(dir, -q * cd));
  const accel = add(scale(force, 1 / mass), vec3(0, -G, 0));
  s.vel = add(s.vel, scale(accel, dt));
  s.pos = add(s.pos, scale(s.vel, dt));

  // The swinging of the jumper under the canopy: a pendulum on the risers,
  // pushed along the track by the acceleration of the canopy.
  const trackRight = cross(trackDir, UP);
  const alongTrack = dot(accel, trackDir);
  const acrossTrack = dot(accel, trackRight);
  const lines = POLAR.linesM;
  const damping = POLAR.swingDamping;
  const foreAccel =
    -(G / lines) * Math.sin(s.swingFore) -
    damping * s.swingForeRate -
    (alongTrack / lines) * Math.cos(s.swingFore);
  s.swingForeRate += foreAccel * dt;
  s.swingFore += s.swingForeRate * dt;
  const sideAccel =
    -(G / lines) * Math.sin(s.swingSide) -
    damping * s.swingSideRate -
    (acrossTrack / lines) * Math.cos(s.swingSide);
  s.swingSideRate += sideAccel * dt;
  s.swingSide += s.swingSideRate * dt;

  s.tS += dt;
}
