/**
 * The wind over a drop zone.
 *
 * The mean wind grows and veers with height: the air drags over the
 * ground, so it is slower and turned near the surface than it is a few
 * thousand metres up. On top of the mean ride the gusts, which are
 * strongest close to the ground and fade out by 300 m, so a canopy on
 * final drifts in the gust rather than in the mean.
 *
 * The profile is a pure function of the height and the time, and the gust
 * phases come from a seeded generator, so a jump replays exactly. This
 * module imports nothing from three.js or the DOM.
 */

import { vec3 } from '@/sim/vec3';
import type { Vec3 } from '@/sim/vec3';
import type { Rng } from '@/sim/rng';

/** How the wind behaves at a drop zone. */
export interface WindProfile {
  /** The mean speed at 10 m above the ground, in metres per second. */
  surfaceSpeedMs: number;
  /** The direction the wind blows from at 10 m above the ground, in degrees true. */
  surfaceFromDeg: number;
  /** The factor the speed reaches at 3,000 m above the ground (2 to 3). */
  aloftFactor: number;
  /** The clockwise change of direction from 10 m to 3,000 m, in degrees. */
  veerDeg: number;
  /** The standard deviation of the gusts over the mean speed near the ground. */
  gustFraction: number;
}

/** The three winds a drop zone can have. */
export type WindPreset = 'calm' | 'typical' | 'sporty';

/** The wind of each preset. */
export const WIND_PRESETS: Record<WindPreset, WindProfile> = {
  calm: {
    surfaceSpeedMs: 1,
    surfaceFromDeg: 270,
    aloftFactor: 2.0,
    veerDeg: 20,
    gustFraction: 0.05,
  },
  typical: {
    surfaceSpeedMs: 4,
    surfaceFromDeg: 270,
    aloftFactor: 2.5,
    veerDeg: 30,
    gustFraction: 0.15,
  },
  sporty: {
    surfaceSpeedMs: 8,
    surfaceFromDeg: 250,
    aloftFactor: 2.5,
    veerDeg: 35,
    gustFraction: 0.25,
  },
};

/** The height above the ground the surface speed and direction are given at. */
const REFERENCE_HEIGHT_M = 10;

/** The height above the ground the wind reaches its aloft speed and direction. */
const ALOFT_HEIGHT_M = 3000;

/** The height above the ground below which the gust is at full strength. */
const GUST_FULL_HEIGHT_M = 50;

/** The height above the ground at which the gust is gone. */
const GUST_FADE_HEIGHT_M = 300;

/** The frequencies of the four sines that make a gust, in hertz. */
const GUST_HZ = [0.05, 0.11, 0.23, 0.47] as const;

/** The phase of each of the four sines, on one horizontal axis. */
type GustPhases = readonly [number, number, number, number];

const TWO_PI = Math.PI * 2;
const DEG_TO_RAD = Math.PI / 180;

/**
 * The logarithm that puts the shape of the profile at one at 3,000 m: the
 * log profile rises fastest just above the ground and then straightens
 * out, which is what the wind over a landscape does.
 */
const LOG_ALOFT = Math.log(1 + ALOFT_HEIGHT_M / REFERENCE_HEIGHT_M);

/** Where the shape of the profile sits at the reference height of 10 m. */
const SHAPE_AT_REFERENCE = Math.log(2) / LOG_ALOFT;

/** Keeps a number inside a range. */
function clamp(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), high);
}

/**
 * How far along the profile a height is: zero at the reference height of
 * 10 m, one at 3,000 m, and flat above and below.
 *
 * The raw log profile rises from zero at the ground, but the profile of a
 * drop zone is written down at 10 m: the surface speed and the surface
 * direction are the wind at 10 m, and the aloft factor is reached at
 * 3,000 m. So the shape is measured from the reference height, which puts
 * both anchors where the profile says they are.
 */
function shapeFactor(aglM: number): number {
  const h = Math.max(aglM, 0);
  const raw = Math.log(1 + h / REFERENCE_HEIGHT_M) / LOG_ALOFT;
  return clamp((raw - SHAPE_AT_REFERENCE) / (1 - SHAPE_AT_REFERENCE), 0, 1);
}

/**
 * How much of the gust is left at a height: all of it below 50 m, fading
 * linearly to nothing at 300 m.
 */
function gustFade(aglM: number): number {
  if (aglM <= GUST_FULL_HEIGHT_M) return 1;
  if (aglM >= GUST_FADE_HEIGHT_M) return 0;
  return (GUST_FADE_HEIGHT_M - aglM) / (GUST_FADE_HEIGHT_M - GUST_FULL_HEIGHT_M);
}

/** Draws the four phases of one horizontal axis from the seeded generator. */
function drawPhases(rng: Rng): GustPhases {
  return [
    rng.range(0, TWO_PI),
    rng.range(0, TWO_PI),
    rng.range(0, TWO_PI),
    rng.range(0, TWO_PI),
  ];
}

export class Wind {
  private readonly profile: WindProfile;
  private readonly phasesX: GustPhases;
  private readonly phasesZ: GustPhases;

  /**
   * @param profile how the wind behaves at this drop zone
   * @param rng the seeded generator the gust phases come from
   */
  constructor(profile: WindProfile, rng: Rng) {
    this.profile = { ...profile };
    this.phasesX = drawPhases(rng);
    this.phasesZ = drawPhases(rng);
  }

  /** The mean wind at a height above the ground: where the air moves to. */
  mean(aglM: number): Vec3 {
    const speed = this.speedAt(aglM);
    const towards = (this.fromDegAt(aglM) + 180) * DEG_TO_RAD;
    return vec3(speed * Math.sin(towards), 0, -speed * Math.cos(towards));
  }

  /** The mean wind with the gust on top of it, at a height and a time. */
  at(aglM: number, tS: number): Vec3 {
    const mean = this.mean(aglM);
    const amplitude = this.gustAmplitude(aglM);
    if (amplitude === 0) return mean;
    return vec3(
      mean.x + amplitude * this.gustAxis(tS, this.phasesX),
      0,
      mean.z + amplitude * this.gustAxis(tS, this.phasesZ),
    );
  }

  /** The direction the wind blows from at a height, in degrees true. */
  fromDegAt(aglM: number): number {
    const deg = this.profile.surfaceFromDeg + this.profile.veerDeg * shapeFactor(aglM);
    return ((deg % 360) + 360) % 360;
  }

  /** The mean speed at a height above the ground, in metres per second. */
  private speedAt(aglM: number): number {
    const shape = shapeFactor(aglM);
    return this.profile.surfaceSpeedMs * (1 + (this.profile.aloftFactor - 1) * shape);
  }

  /**
   * The amplitude of each sine of the gust, in metres per second.
   *
   * Four sines of amplitude a have a standard deviation of a times the
   * square root of two over a long window, so the amplitude that gives the
   * wanted standard deviation is that standard deviation over the square
   * root of two.
   */
  private gustAmplitude(aglM: number): number {
    const sigma = this.profile.gustFraction * this.speedAt(aglM);
    return (sigma / Math.SQRT2) * gustFade(aglM);
  }

  /** The gust on one horizontal axis: the sum of the four sines. */
  private gustAxis(tS: number, phases: GustPhases): number {
    const [p0, p1, p2, p3] = phases;
    const [f0, f1, f2, f3] = GUST_HZ;
    return (
      Math.sin(TWO_PI * f0 * tS + p0) +
      Math.sin(TWO_PI * f1 * tS + p1) +
      Math.sin(TWO_PI * f2 * tS + p2) +
      Math.sin(TWO_PI * f3 * tS + p3)
    );
  }
}
