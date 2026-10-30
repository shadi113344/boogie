/**
 * The spot: where the aircraft leaves the jumper out.
 *
 * A good spot is the one that leaves the jumper over the landing area with
 * the wind on their back at the opening. The aircraft runs into the wind,
 * so the jumper drifts downwind the whole way, and the exit has to be set
 * upwind of the landing area by the drift of the freefall and the opening.
 *
 * Three numbers make the spot: the drift of the freefall, the offset of the
 * expected opening point from the landing area, and the forward throw of
 * the jumper out of the aircraft.
 *
 * This module imports nothing from three.js or the DOM.
 */

import { FT } from './units';
import { type Vec3, vec3 } from './vec3';
import type { Wind } from './wind';

/** The height the wind profile's surface speed and direction are given at. */
const SURFACE_HEIGHT_M = 10;

/** The height the wind aloft is read at, in metres above the ground. */
const ALOFT_HEIGHT_M = 3000;

/** How far upwind of the landing area the expected opening point is. */
const OPENING_OFFSET_M = 500;

/**
 * The surface wind at or below which the expected opening point is the
 * landing area itself: there is no point in a spot for a wind that will not
 * carry the jumper anywhere. The calm preset blows at exactly 1 m/s, so it
 * is a wind without a spot.
 */
const NO_SPOT_WIND_MS = 1;

/** The height the jumper pulls at, in feet above the landing area. */
const PULL_ALTITUDE_FT = 3500;

/** How long the freefall lasts, in seconds: the drift of the jumper. */
const FREEFALL_TIME_S = 60;

/**
 * How far the jumper is thrown forward along the jump run, in metres: the
 * aircraft's speed at the exit carries the jumper on before the air takes
 * hold of them.
 */
const FORWARD_THROW_M = 400;

/** The step the mean wind of the freefall is sampled at, in metres. */
const DRIFT_SAMPLE_M = 100;

/** What the spot needs to know about the jump it is planning. */
export interface DefaultExitOptions {
  /** The height of the landing area above mean sea level, in metres. */
  lzGroundY: number;
  /** The height of the exit above the landing area, in metres. */
  exitAltitudeAglM: number;
  /** The wind over the drop zone. */
  wind: Wind;
  /** The speed of the aircraft at the exit, in metres per second. */
  aircraftTasMs: number;
  /** The heading of the jump run, in degrees true; into the wind if absent. */
  jumpRunHeadingDeg?: number;
}

/** The exit of a jump: where the jumper leaves the aircraft, and where it goes. */
export interface DefaultExit {
  /** The place of the exit, in metres above mean sea level. */
  pos: Vec3;
  /** The heading of the jump run, in radians clockwise from north. */
  headingRad: number;
}

/**
 * The mean wind of the column the jumper falls through, from the exit down
 * to the pull.
 *
 * The wind is sampled every 100 m and averaged, so the drift is the drift
 * of the whole column and not the drift of one layer of it.
 */
function meanWindColumn(wind: Wind, fromAglM: number, toAglM: number): Vec3 {
  const low = Math.min(fromAglM, toAglM);
  const high = Math.max(fromAglM, toAglM);
  let x = 0;
  let z = 0;
  let count = 0;
  for (let h = low; h <= high + 1e-9; h += DRIFT_SAMPLE_M) {
    const mean = wind.mean(h);
    x += mean.x;
    z += mean.z;
    count++;
  }
  if (count === 0) return vec3(0, 0, 0);
  return vec3(x / count, 0, z / count);
}

/**
 * The spot: the exit of a jump that lands the jumper on the landing area.
 *
 * The expected opening point is put 500 m upwind of the landing area, along
 * the surface wind, so that the canopy has room to drift the last of the
 * way in. The exit is then set back from that point by the drift of the
 * freefall and by the forward throw out of the aircraft.
 *
 * The aircraft's true airspeed is not part of the spot itself: the exit
 * point does not depend on it, but the caller needs the same numbers for
 * the velocity the jumper leaves the aircraft with.
 */
export function defaultExit(o: DefaultExitOptions): DefaultExit {
  const surface = o.wind.mean(SURFACE_HEIGHT_M);
  const surfaceSpeed = Math.hypot(surface.x, surface.z);

  // The expected opening point: 500 m upwind of the landing area, which is
  // on the landing area itself when the wind is not worth a spot.
  let openingX = 0;
  let openingZ = 0;
  if (surfaceSpeed > NO_SPOT_WIND_MS) {
    openingX -= (OPENING_OFFSET_M * surface.x) / surfaceSpeed;
    openingZ -= (OPENING_OFFSET_M * surface.z) / surfaceSpeed;
  }

  // The jump run: into the wind at 3,000 m, unless the caller has a run
  // of its own.
  const runDeg = o.jumpRunHeadingDeg ?? o.wind.fromDegAt(ALOFT_HEIGHT_M);
  const headingRad = (runDeg * Math.PI) / 180;
  const forwardX = Math.sin(headingRad);
  const forwardZ = -Math.cos(headingRad);

  // The drift of the freefall: the mean wind from the exit down to the
  // pull, for as long as the freefall lasts.
  const mean = meanWindColumn(o.wind, PULL_ALTITUDE_FT * FT, o.exitAltitudeAglM);
  const driftX = mean.x * FREEFALL_TIME_S;
  const driftZ = mean.z * FREEFALL_TIME_S;

  return {
    pos: vec3(
      openingX - FORWARD_THROW_M * forwardX - driftX,
      o.lzGroundY + o.exitAltitudeAglM,
      openingZ - FORWARD_THROW_M * forwardZ - driftZ,
    ),
    headingRad,
  };
}
