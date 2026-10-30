/**
 * The landing.
 *
 * A landing is two numbers: how fast the jumper hits the ground and how
 * fast they are going over it. The two decide how the jumper gets up, and
 * the parachute landing fall (PLF) decides it when the vertical speed is in
 * the band where rolling on the lines would have helped.
 *
 * The bands come from the spec's table. The table leaves the speeds between
 * 1.5 and 2.5 metres per second open, and this module reads them as a firm
 * stand-up or a run-out. This module imports nothing from three.js or the
 * DOM.
 */

/** How the jumper came out of the landing. */
export type LandingOutcome =
  | 'stand-up'
  | 'run-out'
  | 'slide'
  | 'plf'
  | 'sprain'
  | 'injury'
  | 'fatal';

/**
 * How long the parachute landing fall may be timed, in seconds.
 *
 * The roll has to start before the feet touch and be finished before the
 * jumper is carrying the canopy's forward speed, so the window runs a little
 * either side of the touchdown.
 */
export const PLF_WINDOW_S = 0.4;

/** The vertical speeds of the bands, in metres per second. */
const VERTICAL = {
  /** Above this the landing is fatal. */
  fatal: 9,
  /** Above this the landing is an injury. */
  injury: 5,
  /** From this up the landing wants a PLF. */
  plf: 2.5,
} as const;

/** The ground speeds of the bands, in metres per second. */
const GROUND = {
  /** Above this the landing is an injury. */
  injury: 15,
  /** Above this the jumper slides. */
  slide: 8,
  /** From this up the jumper has to run it out. */
  runOut: 5,
} as const;

/**
 * Works out how the jumper came out of the landing.
 *
 * @param verticalMs how fast the jumper hit the ground, in metres per second
 * @param groundSpeedMs how fast the jumper was going over the ground, in metres per second
 * @param plfInTime true when the PLF was rolled in time
 */
export function classifyLanding(
  verticalMs: number,
  groundSpeedMs: number,
  plfInTime: boolean,
): LandingOutcome {
  if (verticalMs > VERTICAL.fatal) return 'fatal';
  if (verticalMs > VERTICAL.injury || groundSpeedMs > GROUND.injury) return 'injury';
  if (verticalMs >= VERTICAL.plf) return plfInTime ? 'plf' : 'sprain';
  if (groundSpeedMs > GROUND.slide) return 'slide';
  if (groundSpeedMs >= GROUND.runOut) return 'run-out';
  return 'stand-up';
}
