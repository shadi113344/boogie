/**
 * The debrief.
 *
 * The debrief is the honest account of a jump: the numbers that go into the
 * logbook and the flags the jumper has to think about on the way home. It is
 * worked out from a jump that has already been flown - its config, its
 * events, its track, its touchdown and the plan of its opening - and it
 * never steps the jump, so the same jump always gives the same debrief.
 *
 * The turns of the pattern are read off the track: the canopy turns when the
 * heading of the air it is flying through changes faster than ten degrees a
 * second, and the stretches of turning that are less than a second apart are
 * one turn.
 *
 * This module imports nothing from three.js or the DOM.
 */

import type { Jump, TrackSample } from '@/sim/Jump';
import type { LandingOutcome } from '@/sim/landing';
import { FT } from '@/sim/units';
import { length, sub } from '@/sim/vec3';

/** The things the debrief can flag. */
export type DebriefFlag =
  | 'low-turn'
  | 'late-pull'
  | 'no-pull'
  | 'downwind-landing'
  | 'hard-opening'
  | 'aad-fire'
  | 'impact';

/** One turn of the pattern. */
export interface PatternTurn {
  /** The height above the landing area where the turn started, in metres. */
  startAglM: number;
  /** The height above the landing area where the turn ended, in metres. */
  endAglM: number;
  /** How far the canopy turned, in degrees: positive is a turn to the right. */
  headingChangeDeg: number;
}

/** The debrief of a jump. */
export interface DebriefData {
  /** The height of the exit above the landing area, in metres. */
  exitAltitudeAglM: number;
  /** The time from the exit to the deployment, in seconds. */
  freefallTimeS: number;
  /** The height of the deployment above the landing area, in metres. */
  deploymentAltitudeAglM: number | null;
  /** The fastest the jumper fell, in metres per second. */
  maxVerticalMs: number;
  /** The average fall from twelve seconds after the exit to the throw. */
  avgVerticalMs: number;
  /** The largest load of the opening, in g. */
  maxOpeningG: number;
  /** The time the canopy was flying, in seconds. */
  canopyTimeS: number;
  /** The turns of the pattern: the ones over 60 degrees that ended low. */
  patternTurns: PatternTurn[];
  /** The landing, when the jumper got to the ground. */
  landing: null | {
    /** How the landing came out. */
    outcome: LandingOutcome;
    /** How fast the jumper hit the ground, in metres per second. */
    verticalMs: number;
    /** How fast the jumper was going over the ground, in metres per second. */
    groundSpeedMs: number;
    /** How far the jumper landed from the centre of the landing area. */
    distanceFromTargetM: number;
    /** The compass bearing from the landing area to the touchdown. */
    bearingFromTargetDeg: number;
    /** The wind at the touchdown, in metres per second. */
    windMs: number;
    /** The direction the wind came from at the touchdown, in degrees true. */
    windFromDeg: number;
  };
  /** The flags: the things the jumper has to think about. */
  flags: DebriefFlag[];
}

/** The thresholds of the debrief. */
const DEBRIEF = {
  /** The rate of turn above which the canopy is turning, in degrees per second. */
  turnRateDegS: 10,
  /** The gap under which two stretches of turning are one turn, in seconds. */
  turnJoinGapS: 1,
  /** A turn of more than this many degrees is a turn of the pattern. */
  patternTurnDeg: 60,
  /** A turn of the pattern has to end below this height, in feet. */
  patternTurnFt: 1500,
  /** A turn of more than this many degrees is a low turn. */
  lowTurnDeg: 90,
  /** A low turn has to reach below this height, in feet. */
  lowTurnFt: 500,
  /** A throw this many feet below the plan is a late pull. */
  latePullFt: 500,
  /** A tailwind over this speed is a downwind landing, in metres per second. */
  downwindMs: 1.5,
  /** The time the jumper needs to reach the terminal speed, in seconds. */
  terminalS: 12,
} as const;

/**
 * Puts a number of degrees into the range -180 to 180.
 *
 * @param deg a difference of two headings
 */
function wrapDeg(deg: number): number {
  let wrapped = deg;
  while (wrapped > 180) wrapped -= 360;
  while (wrapped < -180) wrapped += 360;
  return wrapped;
}

/**
 * The compass bearing of a point from the landing area, clockwise from north.
 *
 * @param x how far east of the landing area the point is, in metres
 * @param z how far south of the landing area the point is, in metres
 */
function bearingDeg(x: number, z: number): number {
  const deg = (Math.atan2(x, -z) * 180) / Math.PI;
  return (deg + 360) % 360;
}

/**
 * The heading of the air the jumper is moving through, in degrees clockwise
 * from north.
 *
 * A canopy has no heading of its own: it flies through the air, so the
 * heading is that of the air speed, which is the ground speed less the wind.
 *
 * @param jump the jump the sample belongs to
 * @param sample a sample of the track
 */
function airHeadingDeg(jump: Jump, sample: TrackSample): number {
  const wind = jump.wind.at(Math.max(0, sample.aglM), sample.tS);
  const air = sub(sample.vel, wind);
  return (Math.atan2(air.x, -air.z) * 180) / Math.PI;
}

/** A stretch of the track where the canopy is turning. */
interface TurnSegment {
  /** The index of the first sample of the stretch. */
  first: number;
  /** The index of the last sample of the stretch. */
  last: number;
  /** How far the canopy turned over the stretch, in degrees. */
  headingChangeDeg: number;
  /** The lowest height the stretch reached, in metres above the landing area. */
  lowestAglM: number;
}

/**
 * The turns of the track under the canopy.
 *
 * The heading of the air is unwrapped first, so that a turn through north
 * is measured as a turn and not as a jump from one side to the other. The
 * stretches of turning that are less than a second apart are joined into one
 * turn.
 *
 * @param jump the jump that was flown
 * @param samples the samples of the track under the canopy
 */
function turnSegments(jump: Jump, samples: TrackSample[]): TurnSegment[] {
  if (samples.length < 2) return [];

  // The heading of the air at every sample, unwrapped.
  const headings = samples.map((sample) => airHeadingDeg(jump, sample));
  const unwrapped: number[] = [];
  let offset = 0;
  for (let i = 0; i < headings.length; i++) {
    if (i > 0) offset += wrapDeg((headings[i] ?? 0) - (headings[i - 1] ?? 0));
    unwrapped.push(offset);
  }

  // The stretches where the heading changes faster than the threshold.
  const stretches: { first: number; last: number }[] = [];
  for (let i = 1; i < samples.length; i++) {
    const sample = samples[i];
    const previous = samples[i - 1];
    if (!sample || !previous) continue;
    const dtS = sample.tS - previous.tS;
    const change = (unwrapped[i] ?? 0) - (unwrapped[i - 1] ?? 0);
    const rate = dtS > 0 ? change / dtS : 0;
    if (Math.abs(rate) <= DEBRIEF.turnRateDegS) continue;
    const last = stretches[stretches.length - 1];
    if (last && last.last === i - 1) last.last = i;
    else stretches.push({ first: i - 1, last: i });
  }

  // The stretches that are less than a second apart are one turn.
  const turns: { first: number; last: number }[] = [];
  for (const stretch of stretches) {
    const previous = turns[turns.length - 1];
    if (previous) {
      const gapS = (samples[stretch.first]?.tS ?? 0) - (samples[previous.last]?.tS ?? 0);
      if (gapS < DEBRIEF.turnJoinGapS) {
        previous.last = stretch.last;
        continue;
      }
    }
    turns.push({ ...stretch });
  }

  return turns.map((turn) => {
    let lowestAglM = Number.POSITIVE_INFINITY;
    for (let i = turn.first; i <= turn.last; i++) {
      const aglM = samples[i]?.aglM;
      if (aglM !== undefined && aglM < lowestAglM) lowestAglM = aglM;
    }
    return {
      first: turn.first,
      last: turn.last,
      headingChangeDeg: (unwrapped[turn.last] ?? 0) - (unwrapped[turn.first] ?? 0),
      lowestAglM: Number.isFinite(lowestAglM) ? lowestAglM : 0,
    };
  });
}

/**
 * The wind at the touchdown, projected on the heading the canopy was flying.
 *
 * A positive number is a tailwind: the wind is pushing the jumper along the
 * way the canopy is going, which is a downwind landing.
 *
 * @param jump the jump that was flown
 */
function tailwindComponentMs(jump: Jump): number {
  const touchdown = jump.touchdown;
  if (!touchdown) return 0;

  // The last sample under the canopy: the heading the canopy was flying when
  // it came down.
  let last: TrackSample | null = null;
  for (const sample of jump.track) {
    if (sample.phase === 'canopy') last = sample;
  }
  if (!last) return 0;

  const wind = jump.wind.at(Math.max(0, last.aglM), last.tS);
  const air = sub(last.vel, wind);
  const airspeed = length(air);
  if (airspeed < 1e-6) return 0;
  return (touchdown.wind.x * air.x + touchdown.wind.z * air.z) / airspeed;
}

/**
 * The debrief of a jump.
 *
 * @param jump the jump that was flown
 */
export function computeDebrief(jump: Jump): DebriefData {
  const pull = jump.events.find((event) => event.type === 'pull');
  const aad = jump.events.find((event) => event.type === 'aad');
  const open = jump.events.find((event) => event.type === 'open');
  const touchdown = jump.touchdown;

  // The deployment: the throw of the jumper, or the reserve the AAD fired.
  const deployment = pull ?? aad ?? null;
  const freefallTimeS = deployment
    ? deployment.tS
    : (touchdown?.tS ?? jump.tS);

  // The vertical speeds: the fastest of the jump, and the average of the
  // fall once the jumper is at the terminal speed.
  let maxVerticalMs = 0;
  let verticalSum = 0;
  let verticalCount = 0;
  for (const sample of jump.track) {
    const verticalMs = -sample.vel.y;
    if (verticalMs > maxVerticalMs) maxVerticalMs = verticalMs;
    if (sample.tS >= DEBRIEF.terminalS && sample.tS <= freefallTimeS) {
      verticalSum += verticalMs;
      verticalCount++;
    }
  }
  const avgVerticalMs = verticalCount > 0 ? verticalSum / verticalCount : 0;

  // The turns of the pattern, read off the track under the canopy.
  const canopySamples = jump.track.filter((sample) => sample.phase === 'canopy');
  const segments = turnSegments(jump, canopySamples);
  const patternTurns: PatternTurn[] = segments
    .filter(
      (segment) =>
        Math.abs(segment.headingChangeDeg) > DEBRIEF.patternTurnDeg &&
        segment.lowestAglM < DEBRIEF.patternTurnFt * FT,
    )
    .map((segment) => ({
      startAglM: canopySamples[segment.first]?.aglM ?? 0,
      endAglM: canopySamples[segment.last]?.aglM ?? 0,
      headingChangeDeg: segment.headingChangeDeg,
    }));

  // The landing.
  const landing = touchdown
    ? {
        outcome: touchdown.outcome,
        verticalMs: touchdown.verticalMs,
        groundSpeedMs: touchdown.groundSpeedMs,
        distanceFromTargetM: Math.hypot(touchdown.pos.x, touchdown.pos.z),
        bearingFromTargetDeg: bearingDeg(touchdown.pos.x, touchdown.pos.z),
        windMs: length(touchdown.wind),
        windFromDeg: jump.wind.fromDegAt(
          Math.max(0, touchdown.pos.y - jump.config.lzGroundY),
        ),
      }
    : null;

  // The flags.
  const flags: DebriefFlag[] = [];
  const lowTurn = segments.some(
    (segment) =>
      Math.abs(segment.headingChangeDeg) > DEBRIEF.lowTurnDeg &&
      segment.lowestAglM < DEBRIEF.lowTurnFt * FT,
  );
  if (lowTurn) flags.push('low-turn');
  if (pull && pull.aglM / FT < jump.config.pullAltitudeFt - DEBRIEF.latePullFt) {
    flags.push('late-pull');
  }
  if (jump.aadFired || !pull) flags.push('no-pull');
  if (tailwindComponentMs(jump) > DEBRIEF.downwindMs) flags.push('downwind-landing');
  if (jump.opening?.plan.hard === true) flags.push('hard-opening');
  if (jump.aadFired) flags.push('aad-fire');
  if (jump.events.some((event) => event.type === 'impact')) flags.push('impact');

  return {
    exitAltitudeAglM: jump.config.exitPos.y - jump.config.lzGroundY,
    freefallTimeS,
    deploymentAltitudeAglM: deployment ? deployment.aglM : null,
    maxVerticalMs,
    avgVerticalMs,
    maxOpeningG: jump.maxOpeningG,
    canopyTimeS: open && touchdown ? touchdown.tS - open.tS : 0,
    patternTurns,
    landing,
    flags,
  };
}
