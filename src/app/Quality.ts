/**
 * The quality tiers of the app and the adaptive step-down.
 *
 * A tier says how much the renderer is allowed to spend: how many pixels it
 * draws, how sharp the terrain may be and how many textures it keeps. The
 * tier the app starts on is chosen from the device, and it steps down once,
 * slowly, when the frames are too slow: a phone that cannot hold the rate
 * gives up the sharpness of the ground rather than the smoothness of the
 * flight.
 */

/** The three tiers, from the cheapest to the richest. */
export type QualityTier = 'low' | 'medium' | 'high';

/** What each tier allows. */
export interface QualitySettings {
  /** The highest device pixel ratio the renderer draws at. */
  maxPixelRatio: number;
  /** Texels per screen pixel before a tile is split: smaller is sharper. */
  tau: number;
  /** Anisotropic filtering on the imagery. */
  anisotropy: number;
  /** Imagery textures kept on the GPU at once. */
  maxTextures: number;
  /** Tiles of ground on screen at once: the budget of the selection too. */
  maxLeaves: number;
}

/** The numbers of the tiers. */
export const QUALITY: Record<QualityTier, QualitySettings> = {
  low: { maxPixelRatio: 1.0, tau: 2.4, anisotropy: 2, maxTextures: 192, maxLeaves: 96 },
  medium: { maxPixelRatio: 1.5, tau: 1.8, anisotropy: 4, maxTextures: 256, maxLeaves: 160 },
  high: { maxPixelRatio: 2.0, tau: 1.2, anisotropy: 8, maxTextures: 384, maxLeaves: 240 },
};

/** The tiers, from the richest to the cheapest. */
const LADDER: QualityTier[] = ['high', 'medium', 'low'];

/**
 * The tier a device starts on.
 *
 * A phone never starts on the high tier: a touch screen, a dense screen and
 * a small machine all put the app in the middle, where the ground is a little
 * coarser and fewer tiles are on screen. The high tier is for the machines
 * that ask for none of that.
 */
export function defaultTier(
  dpr: number,
  hardwareConcurrency: number,
  maxTouchPoints: number,
): QualityTier {
  if (dpr >= 2 || hardwareConcurrency <= 4 || maxTouchPoints > 0) return 'medium';
  return 'high';
}

/** How much of the newest frame the average keeps, from 0 to 1. */
const EMA_ALPHA = 0.1;

/** A frame slower than this, in milliseconds, is too slow. */
const DEFAULT_THRESHOLD_MS = 20;

/** How long the frames have to be too slow, in milliseconds. */
const DEFAULT_SUSTAIN_MS = 2000;

/** How long the app waits after a change before it changes again, in ms. */
const DEFAULT_COOLDOWN_MS = 5000;

/** The options of the adaptive quality. */
export interface AdaptiveQualityOptions {
  /** The frame time above which the app is too slow, in milliseconds. */
  thresholdMs?: number;
  /** How long the frames have to be too slow, in milliseconds. */
  sustainMs?: number;
  /** The quiet time after a change, in milliseconds. */
  cooldownMs?: number;
}

/**
 * The tier of the app, and the slow machine that watches the frame times.
 *
 * The frame times are averaged, so one hitch does not change the tier: the
 * tier only steps down when the app is *continuously* too slow. It never
 * steps up again, because a tier that was too rich once is too rich twice.
 */
export class AdaptiveQuality {
  /** The tier the app is on. */
  private current: QualityTier;

  /** True when the tier is fixed and never changes. */
  locked = false;

  /** The average of the frame times, or null before the first frame. */
  private ema: number | null = null;

  /** When the frames last became too slow, or null while they are quick. */
  private slowSince: number | null = null;

  /** When the tier last changed, in frame time. */
  private lastChangeAt = Number.NEGATIVE_INFINITY;

  private readonly thresholdMs: number;
  private readonly sustainMs: number;
  private readonly cooldownMs: number;

  constructor(initial: QualityTier, opts: AdaptiveQualityOptions = {}) {
    this.current = initial;
    this.thresholdMs = opts.thresholdMs ?? DEFAULT_THRESHOLD_MS;
    this.sustainMs = opts.sustainMs ?? DEFAULT_SUSTAIN_MS;
    this.cooldownMs = opts.cooldownMs ?? DEFAULT_COOLDOWN_MS;
  }

  /** The tier the app is on. */
  get tier(): QualityTier {
    return this.current;
  }

  /**
   * One frame of evidence.
   *
   * Returns the new tier when the tier changed, and null when it did not.
   */
  pushFrame(frameMs: number, nowMs: number): QualityTier | null {
    if (this.locked) return null;

    // The average of the frame times, weighted towards the recent ones.
    this.ema = this.ema === null ? frameMs : this.ema + EMA_ALPHA * (frameMs - this.ema);

    if (this.ema <= this.thresholdMs) {
      this.slowSince = null;
      return null;
    }

    // The frames have been too slow since this moment.
    if (this.slowSince === null) this.slowSince = nowMs;
    if (nowMs - this.slowSince < this.sustainMs) return null;
    if (nowMs - this.lastChangeAt < this.cooldownMs) return null;

    const next = this.stepDown();
    if (next === null) return null;

    this.current = next;
    this.lastChangeAt = nowMs;
    this.slowSince = null;
    return next;
  }

  /** The tier below the current one, or null when there is none. */
  private stepDown(): QualityTier | null {
    const index = LADDER.indexOf(this.current);
    const lower = LADDER[index + 1];
    return lower ?? null;
  }
}
