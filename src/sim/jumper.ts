/**
 * The jumper: how much there is of them and how big they are.
 *
 * The body mass is the one number the player sets; the gear is the rig, the
 * container and everything else that comes along. Heavier jumpers fall
 * faster and load their canopies more, and both of those fall out of the
 * two relations below rather than out of a table of numbers. This module
 * imports nothing from three.js or the DOM.
 */

/** The body mass the table numbers of the spec are based on, in kg. */
export const REFERENCE_BODY_MASS_KG = 85;

/** The smallest body mass the settings allow, in kg. */
export const MIN_BODY_MASS_KG = 55;

/** The largest body mass the settings allow, in kg. */
export const MAX_BODY_MASS_KG = 110;

/** The mass and the size of one jumper. */
export interface JumperParams {
  bodyMassKg: number;
  gearMassKg: number;
}

/** The default jumper: 85 kg of body and 12 kg of gear. */
export const DEFAULT_JUMPER: JumperParams = {
  bodyMassKg: 85,
  gearMassKg: 12,
};

/** Keeps a body mass inside the range the settings allow. */
export function clampBodyMass(kg: number): number {
  if (!Number.isFinite(kg)) return DEFAULT_JUMPER.bodyMassKg;
  return Math.min(MAX_BODY_MASS_KG, Math.max(MIN_BODY_MASS_KG, kg));
}

/** The mass the jumper leaves the aircraft with, in kg. */
export function exitMassKg(j: JumperParams): number {
  return j.bodyMassKg + j.gearMassKg;
}

/**
 * How much bigger a jumper's area is than the reference jumper's.
 *
 * A body is modelled as something between a cube and a slab, so its area
 * grows with the two thirds power of its mass: the same jumper seen from
 * the side is the same jumper seen from the front. The reference jumper has
 * a scale of one.
 */
export function bodyAreaScale(j: JumperParams): number {
  const mass = j.bodyMassKg;
  if (!Number.isFinite(mass) || mass <= 0) return 0;
  return Math.pow(mass / REFERENCE_BODY_MASS_KG, 2 / 3);
}
