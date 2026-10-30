import { describe, expect, it } from 'vitest';
import { defaultExit } from '@/sim/spot';
import { Rng } from '@/sim/rng';
import { FT, KT } from '@/sim/units';
import { WIND_PRESETS, Wind } from '@/sim/wind';

/** Interlaken: the landing area is 568 m above mean sea level. */
const GROUND_M = 568;

/** The exit is 13,500 ft above the landing area. */
const EXIT_FT = 13500;

/** The speed of the aircraft at the exit: 95 knots true. */
const EXIT_SPEED_MS = 95 * KT;

/** A calm wind over the drop zone. */
function calmWind(): Wind {
  return new Wind(WIND_PRESETS.calm, new Rng(1));
}

/** The typical wind over the drop zone. */
function typicalWind(): Wind {
  return new Wind(WIND_PRESETS.typical, new Rng(1));
}

describe('the default exit', () => {
  it('puts the exit about 400 m south of the landing area on a north jump run', () => {
    const exit = defaultExit({
      lzGroundY: GROUND_M,
      exitAltitudeAglM: EXIT_FT * FT,
      wind: calmWind(),
      aircraftTasMs: EXIT_SPEED_MS,
      jumpRunHeadingDeg: 0,
    });

    // The run is north, so the exit is 400 m south of the landing area,
    // less the little the jumper drifts in the calm air.
    expect(exit.pos.z).toBeGreaterThan(300);
    expect(exit.pos.z).toBeLessThan(500);
    expect(exit.pos.y).toBeCloseTo(GROUND_M + EXIT_FT * FT, 9);
    expect(exit.headingRad).toBeCloseTo(0, 12);
  });

  it('runs the jump into the wind at 3,000 m when no run heading is given', () => {
    const exit = defaultExit({
      lzGroundY: GROUND_M,
      exitAltitudeAglM: EXIT_FT * FT,
      wind: typicalWind(),
      aircraftTasMs: EXIT_SPEED_MS,
    });

    // The typical wind is from 270 degrees at the surface and has veered
    // 30 degrees by 3,000 m, so the run is on 300.
    expect(exit.headingRad).toBeCloseTo((300 * Math.PI) / 180, 12);
  });

  it('puts the exit upwind of the landing area in the typical wind', () => {
    const exit = defaultExit({
      lzGroundY: GROUND_M,
      exitAltitudeAglM: EXIT_FT * FT,
      wind: typicalWind(),
      aircraftTasMs: EXIT_SPEED_MS,
    });

    // The surface wind blows towards the east, so upwind is west.
    expect(exit.pos.x).toBeLessThan(-500);
  });

  it('puts the opening point on the landing area itself in calm air', () => {
    // In calm air the jumper drifts hardly at all, so the exit sits over
    // the landing area and the jump run carries it 400 m back.
    const exit = defaultExit({
      lzGroundY: GROUND_M,
      exitAltitudeAglM: EXIT_FT * FT,
      wind: calmWind(),
      aircraftTasMs: EXIT_SPEED_MS,
      jumpRunHeadingDeg: 0,
    });

    expect(Math.abs(exit.pos.x)).toBeLessThan(200);
  });
});
