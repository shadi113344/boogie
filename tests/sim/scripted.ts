/**
 * The scripted jumps the tests fly.
 *
 * The setup of a jump - the drop zone, the exit, the wind and the way the
 * jumper flies the pattern - lives here, so that the tests fly the same jump
 * the plan describes instead of copying the script into every file.
 */

import { DEFAULT_AUDIBLE } from '@/sim/audible';
import type { Jump, JumpConfig } from '@/sim/Jump';
import { NEUTRAL_INPUT, type JumpInput } from '@/sim/inputs';
import { DEFAULT_JUMPER } from '@/sim/jumper';
import { Rng } from '@/sim/rng';
import { defaultExit } from '@/sim/spot';
import { FT, KT } from '@/sim/units';
import { WIND_PRESETS, Wind } from '@/sim/wind';

/** Interlaken: the landing area is 568 m above mean sea level. */
export const GROUND_M = 568;

/** The exit is 13,500 ft above the landing area. */
export const EXIT_FT = 13500;

/** The pull is at 3,500 ft above the landing area. */
export const PULL_FT = 3500;

/** The speed of the aircraft at the exit: 95 knots true. */
export const EXIT_SPEED_MS = 95 * KT;

/** The most steps a test will fly before it gives up. */
export const MAX_STEPS = 300 * 120;

/** The input of a jumper who is not touching anything. */
export const NEUTRAL = { ...NEUTRAL_INPUT };

/** A jump over flat ground at Interlaken. */
export function makeConfig(overrides: Partial<JumpConfig> = {}): JumpConfig {
  return {
    seed: 1,
    jumper: DEFAULT_JUMPER,
    wind: WIND_PRESETS.calm,
    temperatureOffsetC: 0,
    exitPos: { x: 0, y: GROUND_M + EXIT_FT * FT, z: 0 },
    exitHeadingRad: 0,
    aircraftTasMs: EXIT_SPEED_MS,
    lzGroundY: GROUND_M,
    ground: () => GROUND_M,
    canopyId: 'sport-210',
    pullAltitudeFt: PULL_FT,
    audible: DEFAULT_AUDIBLE,
    ...overrides,
  };
}

/**
 * The full jump: the exit of the spot, the typical wind and the pattern.
 *
 * The wind in the overrides is the wind the spot is worked out for, so a
 * test that changes the wind gets an exit that matches it.
 */
export function makeFullConfig(overrides: Partial<JumpConfig> = {}): JumpConfig {
  const wind = overrides.wind ?? WIND_PRESETS.typical;
  const exit = defaultExit({
    lzGroundY: GROUND_M,
    exitAltitudeAglM: EXIT_FT * FT,
    wind: new Wind(wind, new Rng(1)),
    aircraftTasMs: EXIT_SPEED_MS,
  });
  return makeConfig({
    wind,
    exitPos: exit.pos,
    exitHeadingRad: exit.headingRad,
    ...overrides,
  });
}

/** How the jumper steers the canopy in the pattern. */
export type SteerMode = 'into-wind' | 'downwind';

/** How the jumper flies the jump. */
export interface PatternOptions {
  /** Whether the jumper throws the canopy at the pull altitude. */
  pull?: boolean;
  /** The toggles held while the brakes are stowed. */
  stowedToggles?: number;
  /** Whether the jumper rolls into a PLF in the freefall. */
  plfInFreefall?: boolean;
  /** Which way the pattern is flown: into the wind or downwind. */
  steer?: SteerMode;
  /**
   * The height at which the jumper throws the canopy, in feet.
   *
   * The plan of the jump is in the config; this is where the jumper actually
   * pulls, which is how a late pull is scripted.
   */
  pullAtFt?: number;
  /**
   * The height from which the canopy holds the heading of the pattern, in
   * feet.
   *
   * The canopy opens on the ground speed of the jumper, which by the end of
   * the freefall points downwind, and the jump run is into the wind: so the
   * jumper holds the heading into the wind from the opening, and the pattern
   * below 1,000 ft is flown on that heading. A jumper who waits for the
   * pattern to start flies the heading the canopy opened with until then.
   */
  holdFromFt?: number;
  /** The height at which the jumper flies a 180 degree turn, in feet. */
  lowTurnAtFt?: number;
}

/** The height at which the flare starts, in feet above the landing area. */
const FLARE_FT = 12;

/** How long after the canopy opens the brakes are unstowed, in seconds. */
const UNSTOW_S = 3;

/** The gain of the steering: the toggle travel per radian of heading error. */
const STEER_GAIN = 1.2;

/** The heading of a 180 degree turn, in degrees. */
const TURN_DEG = 180;

/** Puts a number of degrees into the range -180 to 180. */
function wrapDeg(deg: number): number {
  let wrapped = deg;
  while (wrapped > 180) wrapped -= 360;
  while (wrapped < -180) wrapped += 360;
  return wrapped;
}

/**
 * Points the canopy at the heading the jumper wants.
 *
 * The error is the difference between the heading the canopy is flying and
 * the heading wanted; the toggle travel is what is needed to turn that much,
 * and the toggle that is pulled is the one that turns the canopy the right
 * way.
 */
function steer(jump: Jump, input: JumpInput, mode: SteerMode): void {
  const fromDeg = jump.wind.fromDegAt(0);
  // Downwind, the canopy flies where the wind is going, not where it comes
  // from.
  const wanted = mode === 'downwind' ? fromDeg + 180 : fromDeg;
  const target = (wanted * Math.PI) / 180;
  let error = target - jump.canopyHeadingRad();
  while (error > Math.PI) error -= 2 * Math.PI;
  while (error < -Math.PI) error += 2 * Math.PI;
  const travel = Math.min(Math.max(Math.abs(error) * STEER_GAIN, 0), 0.6);
  input.canopy.left = error < 0 ? travel : 0;
  input.canopy.right = error > 0 ? travel : 0;
}

/**
 * Flies a jump with the pattern: the steering on the way down and the
 * standard stroke at the bottom.
 *
 * @param jump the jump to fly
 * @param options how the jumper flies it
 */
export function flyPattern(jump: Jump, options: PatternOptions = {}): void {
  const pull = options.pull ?? true;
  const pullAtFt = options.pullAtFt ?? jump.config.pullAltitudeFt;
  const stowedToggles = options.stowedToggles ?? 0;
  const mode = options.steer ?? 'into-wind';
  const holdFromFt = options.holdFromFt ?? Number.POSITIVE_INFINITY;
  const lowTurnAtFt = options.lowTurnAtFt;
  let steps = 0;
  let unstowed = false;
  let flareStartS = -1;
  let turning = false;
  let turnDone = false;
  let turnChangeDeg = 0;
  let turnPrevDeg = 0;
  while (jump.phase !== 'landed' && steps < MAX_STEPS) {
    const input: JumpInput = {
      freefall: { ...NEUTRAL.freefall },
      pull:
        pull &&
        jump.phase === 'freefall' &&
        jump.altitudeAglM() <= pullAtFt * FT,
      canopy: { ...NEUTRAL.canopy },
      plf: options.plfInFreefall === true && jump.phase === 'freefall',
    };
    if (jump.phase === 'canopy') {
      const opened = jump.events.find((event) => event.type === 'open');
      if (opened && !unstowed && jump.tS >= opened.tS + UNSTOW_S) {
        input.canopy.unstow = true;
        unstowed = true;
      }
      if (!unstowed) {
        input.canopy.left = stowedToggles;
        input.canopy.right = stowedToggles;
      }
      const aglFt = jump.heightAboveGround() / FT;

      // The low turn: a full toggle, held until the canopy has turned 180
      // degrees. The jumper does not steer while the turn is on.
      if (lowTurnAtFt !== undefined && aglFt <= lowTurnAtFt && !turnDone) {
        const headingDeg = (jump.canopyHeadingRad() * 180) / Math.PI;
        if (!turning) {
          turning = true;
          turnPrevDeg = headingDeg;
          turnChangeDeg = 0;
        }
        turnChangeDeg += wrapDeg(headingDeg - turnPrevDeg);
        turnPrevDeg = headingDeg;
        if (Math.abs(turnChangeDeg) >= TURN_DEG) turnDone = true;
        else input.canopy.right = 1;
      }
      if (!turning && aglFt <= holdFromFt) steer(jump, input, mode);

      // The flare: the standard stroke.
      if (aglFt <= FLARE_FT) {
        if (flareStartS < 0) flareStartS = jump.tS;
        const t = jump.tS - flareStartS;
        const travel =
          t < 0.3
            ? (t / 0.3) * 0.5
            : t < 1.1
              ? 0.5 + ((t - 0.3) / 0.8) * 0.4
              : 0.9;
        input.canopy.left = travel;
        input.canopy.right = travel;
      }
    }
    jump.step(input);
    steps++;
  }
}
