/**
 * The polar of a canopy: how much lift and how much drag it makes at each
 * brake setting.
 *
 * The polar is not a table of coefficients in the source. It is worked out
 * from the two numbers the canopy is sold on, the speed and the sink at full
 * flight and at half brakes, for the reference jumper at sea level:
 *
 *     sin γ = w / V
 *     CL   = 2 m g cos γ / (ρ₀ S V²)
 *     CD   = CL tan γ
 *
 * The brake travel is then linear between the three points of the stroke:
 * the brakes released, the brakes at half travel, and the brakes at full
 * travel, where the lift and the drag have their own multiples of the half
 * brake values. A heavier jumper flies the same coefficients faster, so
 * nothing here scales with the mass.
 *
 * This module imports nothing from three.js or the DOM.
 */

import { SEA_LEVEL_DENSITY } from '@/sim/atmosphere';
import type { CanopySpec } from '@/data/canopies';
import { FPM, FT, G, MPH } from '@/sim/units';

/** The numbers the canopy model is built on. */
export const POLAR = {
  /** The mass the tables of the canopies are written for, in kg. */
  referenceMassKg: 97,
  /** How much more lift the canopy makes at full brakes than at half. */
  fullBrakeLift: 2.2,
  /** How much more drag the canopy makes at full brakes than at half. */
  fullBrakeDrag: 2.6,
  /** How long the lift takes to follow the brakes, in seconds. */
  liftLagS: 0.15,
  /**
   * How long the drag takes to follow the brakes down, in seconds: the canopy
   * rotates into its deep-brake attitude slowly, which is what lets a flare
   * plane out before the drag catches up.
   */
  dragLagS: 3.0,
  /**
   * How long the drag takes to follow the brakes up, in seconds: released,
   * the canopy surges forward and is flying again in a couple of seconds.
   */
  dragReleaseLagS: 0.5,
  /** The brake travel at which the canopy starts to stall. */
  stallBrake: 0.95,
  /** The share of the full flight speed below which a deep stall happens. */
  stallSpeedShare: 0.55,
  /** How long the canopy has to be slow and deep before it stalls, in seconds. */
  stallHoldS: 1.0,
  /** The lift coefficient of a stalled canopy. */
  stallCL: 0.25,
  /** The drag coefficient of a stalled canopy. */
  stallCD: 1.1,
  /** How much drag a turn adds, per unit of toggle. */
  turnDrag: 0.05,
  /** How much lift the front risers take away at full travel. */
  frontRiserLift: 0.6,
  /** How much drag the front risers take away at full travel. */
  frontRiserDrag: 0.2,
  /** How much lift the rear risers add at full travel. */
  rearRiserLift: 0.12,
  /** How much drag the rear risers add at full travel. */
  rearRiserDrag: 0.04,
  /** The brake travel of a canopy whose brakes are stowed. */
  stowedBrake: 0.25,
  /** The length of the risers, in metres: the pendulum of the jumper. */
  linesM: 6,
  /** How quickly the swinging of the jumper dies away, per second. */
  swingDamping: 0.8,
} as const;

/** The lift and the drag of a canopy at each brake setting. */
export interface Polar {
  /** The lift coefficient at a brake travel from 0 to 1. */
  cl(brake: number): number;
  /** The drag coefficient at a brake travel from 0 to 1. */
  cd(brake: number): number;
  /** The airspeed of the canopy in full flight, for the reference jumper at sea level. */
  fullFlightAirspeedMs: number;
}

/** Keeps a brake travel inside the stroke. */
function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/**
 * The lift or the drag at a brake travel: linear from the brakes released
 * to the brakes at half travel, and linear from there to the brakes at full
 * travel.
 */
function alongStroke(brake: number, released: number, half: number, full: number): number {
  const travel = clamp01(brake);
  if (travel <= 0.5) return released + (half - released) * (travel / 0.5);
  return half + (full - half) * ((travel - 0.5) / 0.5);
}

/** The lift and the drag coefficient of one point of the canopy's table. */
interface Point {
  cl: number;
  cd: number;
}

/**
 * The coefficients of one point of the table, from the speed and the sink
 * the canopy makes there for the reference jumper at sea level.
 */
function coefficients(speedMs: number, sinkMs: number, areaM2: number): Point {
  const gamma = Math.asin(sinkMs / speedMs);
  const cl = (2 * POLAR.referenceMassKg * G * Math.cos(gamma)) / (SEA_LEVEL_DENSITY * areaM2 * speedMs * speedMs);
  return { cl, cd: cl * Math.tan(gamma) };
}

/**
 * The polar of a canopy, worked out from its full flight and half brake
 * figures.
 */
export function polarFor(spec: CanopySpec): Polar {
  const areaM2 = spec.areaFt2 * FT * FT;
  const fullFlightAirspeedMs = spec.fullFlight.mph * MPH;

  const released = coefficients(fullFlightAirspeedMs, spec.fullFlight.fpm * FPM, areaM2);
  const half = coefficients(spec.halfBrakes.mph * MPH, spec.halfBrakes.fpm * FPM, areaM2);
  const full: Point = {
    cl: POLAR.fullBrakeLift * half.cl,
    cd: POLAR.fullBrakeDrag * half.cd,
  };

  return {
    cl: (brake: number) => alongStroke(brake, released.cl, half.cl, full.cl),
    cd: (brake: number) => alongStroke(brake, released.cd, half.cd, full.cd),
    fullFlightAirspeedMs,
  };
}
