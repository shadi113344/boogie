import { describe, it, expect } from 'vitest';
import { Rng } from '@/sim/rng';
import type { Vec3 } from '@/sim/vec3';
import { WIND_PRESETS, Wind } from '@/sim/wind';

/** A bearing in degrees true, counted from 0 to 360. */
function normalizeDeg(deg: number): number {
  return (((deg % 360) + 360) % 360);
}

/** The bearing, in degrees true, that a horizontal vector points towards. */
function bearingOf(v: Vec3): number {
  return normalizeDeg((Math.atan2(v.x, -v.z) * 180) / Math.PI);
}

/** The length of the horizontal part of a vector. */
function horizontalSpeed(v: Vec3): number {
  return Math.hypot(v.x, v.z);
}

/** How far a value is from another, as a fraction of the second one. */
function relativeError(actual: number, expected: number): number {
  return Math.abs(actual - expected) / expected;
}

describe('wind presets', () => {
  it('holds the three profiles the plan names', () => {
    expect(WIND_PRESETS.calm).toEqual({
      surfaceSpeedMs: 1,
      surfaceFromDeg: 270,
      aloftFactor: 2.0,
      veerDeg: 20,
      gustFraction: 0.05,
    });
    expect(WIND_PRESETS.typical).toEqual({
      surfaceSpeedMs: 4,
      surfaceFromDeg: 270,
      aloftFactor: 2.5,
      veerDeg: 30,
      gustFraction: 0.15,
    });
    expect(WIND_PRESETS.sporty).toEqual({
      surfaceSpeedMs: 8,
      surfaceFromDeg: 250,
      aloftFactor: 2.5,
      veerDeg: 35,
      gustFraction: 0.25,
    });
  });
});

describe('Wind', () => {
  it('blows at the surface speed, towards the far side of the surface direction', () => {
    const profile = WIND_PRESETS.typical;
    const wind = new Wind(profile, new Rng(1));
    const mean = wind.mean(10);

    expect(relativeError(horizontalSpeed(mean), profile.surfaceSpeedMs)).toBeLessThanOrEqual(0.02);
    expect(mean.y).toBe(0);
    // A wind from 270° blows towards 90°, which is east, which is +x here.
    expect(bearingOf(mean)).toBeCloseTo(90, 1);
    expect(mean.x).toBeGreaterThan(0);
    expect(Math.abs(mean.z)).toBeLessThan(1e-12);
  });

  it('rises to the aloft factor and veers by the veer angle at 3,000 m', () => {
    const profile = WIND_PRESETS.typical;
    const wind = new Wind(profile, new Rng(1));
    const mean = wind.mean(3000);

    const aloftSpeed = profile.aloftFactor * profile.surfaceSpeedMs;
    expect(relativeError(horizontalSpeed(mean), aloftSpeed)).toBeLessThanOrEqual(0.02);
    expect(wind.fromDegAt(3000)).toBeCloseTo(profile.surfaceFromDeg + profile.veerDeg, 1);
    expect(bearingOf(mean)).toBeCloseTo(
      normalizeDeg(profile.surfaceFromDeg + profile.veerDeg + 180),
      1,
    );
  });

  it('gives the surface direction at the reference height', () => {
    const profile = WIND_PRESETS.sporty;
    const wind = new Wind(profile, new Rng(4));
    expect(wind.fromDegAt(10)).toBeCloseTo(profile.surfaceFromDeg, 1);
    expect(bearingOf(wind.mean(10))).toBeCloseTo(normalizeDeg(profile.surfaceFromDeg + 180), 1);
  });

  it('holds the aloft values above 3,000 m', () => {
    const wind = new Wind(WIND_PRESETS.sporty, new Rng(3));
    const aloft = wind.mean(3000);
    const higher = wind.mean(5000);

    expect(higher.x).toBeCloseTo(aloft.x, 9);
    expect(higher.y).toBe(aloft.y);
    expect(higher.z).toBeCloseTo(aloft.z, 9);
    expect(wind.fromDegAt(5000)).toBeCloseTo(wind.fromDegAt(3000), 9);
  });

  it('gusts about the mean near the ground', () => {
    const profile = WIND_PRESETS.typical;
    const wind = new Wind(profile, new Rng(2026));
    const mean = wind.mean(20);

    const samples: Vec3[] = [];
    for (let i = 0; i < 6000; i++) samples.push(wind.at(20, i / 10));

    const meanX = samples.reduce((sum, v) => sum + v.x, 0) / samples.length;
    const meanZ = samples.reduce((sum, v) => sum + v.z, 0) / samples.length;

    // The gust rides on the mean, it does not replace it.
    expect(horizontalSpeed({ x: meanX - mean.x, y: 0, z: meanZ - mean.z })).toBeLessThan(
      0.1 * horizontalSpeed(mean),
    );

    // Four sines of amplitude a have a standard deviation of a * sqrt(2).
    const expectedStd = profile.gustFraction * horizontalSpeed(mean);
    const stdX = Math.sqrt(
      samples.reduce((sum, v) => sum + (v.x - meanX) * (v.x - meanX), 0) / samples.length,
    );
    const stdZ = Math.sqrt(
      samples.reduce((sum, v) => sum + (v.z - meanZ) * (v.z - meanZ), 0) / samples.length,
    );
    expect(relativeError(stdX, expectedStd)).toBeLessThanOrEqual(0.3);
    expect(relativeError(stdZ, expectedStd)).toBeLessThanOrEqual(0.3);
  });

  it('gusts near the ground and is smooth above the fade height', () => {
    const wind = new Wind(WIND_PRESETS.typical, new Rng(11));
    const mean = wind.mean(20);

    const gusted = [
      wind.at(20, 0),
      wind.at(20, 7.3),
      wind.at(20, 19.5),
      wind.at(20, 41.75),
    ].some((v) => horizontalSpeed(v) !== horizontalSpeed(mean));

    expect(gusted).toBe(true);
  });

  it('has no gust above 300 m', () => {
    const wind = new Wind(WIND_PRESETS.sporty, new Rng(7));
    for (const t of [0, 1.5, 42, 300.25]) {
      const gusted = wind.at(400, t);
      const mean = wind.mean(400);
      expect(gusted.x).toBeCloseTo(mean.x, 12);
      expect(gusted.y).toBe(0);
      expect(gusted.z).toBeCloseTo(mean.z, 12);
    }
  });

  it('is the same wind for the same seed', () => {
    const a = new Wind(WIND_PRESETS.typical, new Rng(99));
    const b = new Wind(WIND_PRESETS.typical, new Rng(99));

    for (const [aglM, tS] of [
      [0, 0],
      [20, 3.3],
      [120, 17.5],
      [1000, 61.25],
      [3000, 12.75],
    ] as const) {
      const va = a.at(aglM, tS);
      const vb = b.at(aglM, tS);
      expect(Math.abs(va.x - vb.x)).toBeLessThan(1e-12);
      expect(Math.abs(va.y - vb.y)).toBeLessThan(1e-12);
      expect(Math.abs(va.z - vb.z)).toBeLessThan(1e-12);
    }
  });

  it('gusts differently for a different seed', () => {
    const a = new Wind(WIND_PRESETS.typical, new Rng(99));
    const b = new Wind(WIND_PRESETS.typical, new Rng(100));

    const differs = [0, 3.3, 17.5, 61.25].some(
      (tS) => Math.abs(a.at(20, tS).x - b.at(20, tS).x) > 1e-6,
    );
    expect(differs).toBe(true);
  });

  it('never blows along the ground', () => {
    const wind = new Wind(WIND_PRESETS.sporty, new Rng(5));
    for (const aglM of [0, 10, 50, 300, 3000]) {
      expect(wind.mean(aglM).y).toBe(0);
      expect(wind.at(aglM, 12.5).y).toBe(0);
    }
  });
});
