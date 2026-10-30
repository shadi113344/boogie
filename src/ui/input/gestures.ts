/**
 * The touch gestures, as the numbers the simulation reads.
 *
 * A finger on the glass is measured in pixels, and the phone is not always
 * the same size, so every gesture is measured against the width or the
 * height of the screen: the same thumb movement means the same thing on
 * every phone.
 */

/** Where a finger was, and when. */
export interface PointerSample {
  /** The horizontal position, in pixels from the left of the screen. */
  x: number;
  /** The vertical position, in pixels from the top of the screen. */
  y: number;
  /** The time of the sample, in milliseconds. */
  tMs: number;
}

/** How far the pull handle has to be swiped, as a fraction of the width. */
const PULL_SWIPE_WIDTH_FRACTION = 0.08;

/** How long the pull swipe may take, in milliseconds. */
const PULL_SWIPE_MAX_MS = 600;

/** The drag that asks for the whole fall rate, as a fraction of the height. */
const FALL_RATE_HEIGHT_FRACTION = 0.15;

/** The thumb pad deflection that asks for everything, as a fraction of the width. */
const PAD_WIDTH_FRACTION = 0.12;

/** The drag that pulls a toggle all the way, as a fraction of the height. */
const TOGGLE_HEIGHT_FRACTION = 0.35;

/** How fast the phone has to be rolled to be a landing fall, in degrees a second. */
const PLF_ROLL_RATE_DEG_S = 120;

function clamp(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  // Keep the zero positive, so the numbers read cleanly in the input log.
  return value === 0 ? 0 : value;
}

/**
 * Whether a swipe pulls.
 *
 * The pull handle is at the lower right, where the hackey sits on the right
 * hip, and it is thrown by swiping it outward: to the right, across at
 * least 8 percent of the screen and within 600 ms.
 */
export function isPullSwipe(start: PointerSample, end: PointerSample, viewportW: number): boolean {
  if (viewportW <= 0) return false;
  const dx = end.x - start.x;
  if (dx <= 0) return false;
  const dtMs = end.tMs - start.tMs;
  if (dtMs < 0 || dtMs > PULL_SWIPE_MAX_MS) return false;
  return dx >= PULL_SWIPE_WIDTH_FRACTION * viewportW;
}

/**
 * The fall rate a drag asks for, from -1 (de-arched, slow) to 1 (arched,
 * fast).
 *
 * The drag is up or down: up slows the fall, down speeds it up. The whole
 * range is 15 percent of the height of the screen.
 */
export function dragToFallRate(dyPx: number, viewportH: number): number {
  if (viewportH <= 0) return 0;
  return clamp(dyPx / (FALL_RATE_HEIGHT_FRACTION * viewportH), -1, 1);
}

/**
 * The body commands a thumb pad asks for.
 *
 * The thumb moves sideways to turn and up or down to drive: up is forward,
 * down is back. The whole range is 12 percent of the width of the screen.
 */
export function padToBody(
  dxPx: number,
  dyPx: number,
  viewportW: number,
): { turn: number; drive: number } {
  if (viewportW <= 0) return { turn: 0, drive: 0 };
  const full = PAD_WIDTH_FRACTION * viewportW;
  return {
    turn: clamp(dxPx / full, -1, 1),
    drive: clamp(-dyPx / full, -1, 1),
  };
}

/**
 * How far a toggle is pulled, from 0 (released) to 1 (all the way).
 *
 * The finger drags the toggle down; the whole stroke is 35 percent of the
 * height of the screen.
 */
export function toggleDepth(dyPx: number, viewportH: number): number {
  if (viewportH <= 0) return 0;
  return clamp(dyPx / (TOGGLE_HEIGHT_FRACTION * viewportH), 0, 1);
}

/**
 * Whether the phone is being rolled fast enough to be a parachute landing
 * fall. A roll either way counts.
 */
export function isPlfRoll(rollRateDegS: number): boolean {
  return Math.abs(rollRateDegS) > PLF_ROLL_RATE_DEG_S;
}
