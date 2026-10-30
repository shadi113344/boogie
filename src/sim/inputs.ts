/**
 * The inputs every phase and every control scheme share.
 *
 * Tilt, touch and the keyboard all end up in these types, so the simulation
 * never learns how it is being flown. The inputs that do not apply to the
 * phase the jumper is in are ignored by the simulation, but they are logged
 * as they were given. This module imports nothing from three.js or the DOM.
 */

/** The commands of the freefall phase. */
export interface FreefallInput {
  /** Turn, from -1 (left) to +1 (right). */
  turn: number;
  /** Drive, from -1 (back) to +1 (forward). */
  drive: number;
  /** Fall rate, from -1 (de-arch, slow) to +1 (arch, fast). */
  fallRate: number;
  /** True while the jumper holds the track position. */
  track: boolean;
}

/** The commands of the canopy phase. */
export interface CanopyInput {
  /** The left toggle (brake line), 0 released to 1 full arm extension. */
  left: number;
  /** The right toggle (brake line), 0 released to 1 full arm extension. */
  right: number;
  /** The left front riser pulled down, 0 to 1. */
  frontLeft: number;
  /** The right front riser pulled down, 0 to 1. */
  frontRight: number;
  /** Both rear risers pulled down, 0 to 1. */
  rear: number;
  /** True on the step the jumper unstows the brakes. */
  unstow: boolean;
}

/** Everything the jumper can do, in every phase. */
export interface JumpInput {
  /** The commands of the freefall phase. */
  freefall: FreefallInput;
  /** True on the step the jumper pulls. */
  pull: boolean;
  /** The commands of the canopy phase. */
  canopy: CanopyInput;
  /** True on the step the jumper rolls into a parachute landing fall (PLF). */
  plf: boolean;
}

/** The input of a jumper who is not touching anything. */
export const NEUTRAL_INPUT: JumpInput = Object.freeze({
  freefall: Object.freeze({ turn: 0, drive: 0, fallRate: 0, track: false }),
  pull: false,
  canopy: Object.freeze({
    left: 0,
    right: 0,
    frontLeft: 0,
    frontRight: 0,
    rear: 0,
    unstow: false,
  }),
  plf: false,
});
