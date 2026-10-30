import { describe, expect, it } from 'vitest';
import { isaDensity } from '@/sim/atmosphere';
import { BELLY } from '@/sim/freefall/aero';
import { DEFAULT_JUMPER, exitMassKg } from '@/sim/jumper';
import { Opening, OPENING, OPENING_CANOPY_DRAG_M2, planOpening, type OpeningPlan, type OpeningStage } from '@/sim/opening';
import { Rng } from '@/sim/rng';
import { FT, G, MPH } from '@/sim/units';

/**
 * The opening of a main canopy, flown from 3,500 ft above Interlaken.
 *
 * The jumper leaves the plane at the belly-neutral terminal speed for that
 * altitude, throws, and the opening is integrated until the canopy is open:
 * the exit mass under gravity, the body's own drag (belly flat until the
 * lines come tight, upright afterwards) and the drag of the opening itself.
 *
 * The canopy's own flight force (task 13) is stood in for here by a drag
 * area of 9.5 m² that comes in with the flight blend, so the opening can
 * be measured without waiting for the canopy model.
 */

/** The height of the Interlaken landing area above mean sea level, in metres. */
const LZ_ELEVATION_M = 568;

/** The height of the throw above the landing area, in feet. */
const THROW_ABOVE_LZ_FT = 3500;

/** The height of the throw above mean sea level, in metres. */
const START_ALTITUDE_M = LZ_ELEVATION_M + THROW_ABOVE_LZ_FT * FT;

/** The canopy's flight force, stood in for by a drag area, in square metres. */
const CANOPY_FLIGHT_AREA_M2 = OPENING_CANOPY_DRAG_M2;

/** The step of the simulation, in seconds. */
const DT = 1 / 120;

/** The most steps the opening may take before the test gives up. */
const MAX_STEPS = 20 * 120;

/** The exit mass of the default jumper, in kilograms. */
const MASS_KG = exitMassKg(DEFAULT_JUMPER);

/** The belly-neutral terminal speed at the height of the throw, in m/s. */
const TERMINAL_MS = Math.sqrt(
  (2 * MASS_KG * G) / (isaDensity(START_ALTITUDE_M) * BELLY.cdaNeutral),
);

interface OpeningRun {
  /** The time from the throw to the open canopy, in seconds. */
  openS: number;
  /** The largest load the jumper felt through the opening, in g. */
  peakG: number;
  /** The altitude between the throw and the open canopy, in feet. */
  lostFt: number;
  /** The plan the opening was run to. */
  plan: OpeningPlan;
}

/**
 * Throws the canopy and integrates the opening until the canopy is open.
 *
 * @param seed the seed the plan is drawn from
 * @param verticalMs the speed at the throw, in m/s
 * @param kind the main or the reserve
 */
function runOpening(seed: number, verticalMs: number, kind: 'main' | 'reserve'): OpeningRun {
  const plan = planOpening(new Rng(seed), verticalMs, kind);
  const opening = new Opening(plan);
  let altitudeM = START_ALTITUDE_M;
  let verticalMs_ = -verticalMs;
  let peakG = 0;
  let steps = 0;

  while (opening.stage !== 'open' && steps < MAX_STEPS) {
    const rho = isaDensity(altitudeM);
    const bodyArea =
      opening.stage === 'pilot-chute' || opening.stage === 'bag' ? BELLY.cdaNeutral : 0.5;
    const areaM2 = bodyArea + opening.dragArea() + CANOPY_FLIGHT_AREA_M2 * opening.flightBlend();
    const forceN = 0.5 * rho * verticalMs_ * verticalMs_ * areaM2;
    const loadG = forceN / (MASS_KG * G);
    if (loadG > peakG) peakG = loadG;
    verticalMs_ += (forceN / MASS_KG - G) * DT;
    altitudeM += verticalMs_ * DT;
    opening.advance(DT);
    steps++;
  }

  return {
    openS: opening.tS,
    peakG,
    lostFt: (START_ALTITUDE_M - altitudeM) / FT,
    plan,
  };
}

/** Runs the opening over a range of seeds. */
function runSeeds(verticalMs: number, kind: 'main' | 'reserve', lastSeed = 60): OpeningRun[] {
  const runs: OpeningRun[] = [];
  for (let seed = 1; seed <= lastSeed; seed++) {
    runs.push(runOpening(seed, verticalMs, kind));
  }
  return runs;
}

/** The smallest of a list of numbers. */
function min(values: number[]): number {
  return Math.min(...values);
}

/** The largest of a list of numbers. */
function max(values: number[]): number {
  return Math.max(...values);
}

/** The mean of a list of numbers. */
function mean(values: number[]): number {
  return values.reduce((a, b) => a + b, 0) / values.length;
}

describe('the opening plan', () => {
  it('draws the hesitation and the snivel before it decides on a hard opening', () => {
    const plan = planOpening(new Rng(7), 40, 'main');
    expect(plan.kind).toBe('main');
    expect(plan.hesitationS).toBeGreaterThanOrEqual(0.3);
    expect(plan.hesitationS).toBeLessThan(1);
    expect(plan.snivelS).toBeGreaterThanOrEqual(1.8);
    expect(plan.snivelS).toBeLessThan(2.4);
    expect(plan.hard).toBe(false);
  });

  it('gives the same plan for the same seed and speed', () => {
    const a = planOpening(new Rng(12), 55, 'main');
    const b = planOpening(new Rng(12), 55, 'main');
    expect(a).toEqual(b);
  });

  it('opens the reserve faster than the main', () => {
    const reserve = planOpening(new Rng(3), 30, 'reserve');
    expect(reserve.kind).toBe('reserve');
    expect(reserve.hesitationS).toBeGreaterThanOrEqual(0.1);
    expect(reserve.hesitationS).toBeLessThan(0.3);
    expect(reserve.snivelS).toBeGreaterThanOrEqual(0.8);
    expect(reserve.snivelS).toBeLessThan(1.2);
  });

  it('never makes a hard opening below 140 mph', () => {
    for (let seed = 1; seed <= 60; seed++) {
      expect(planOpening(new Rng(seed), OPENING.hardAboveMs, 'main').hard).toBe(false);
      expect(planOpening(new Rng(seed), 120 * MPH, 'main').hard).toBe(false);
    }
  });

  it('always makes a hard opening above 160 mph', () => {
    for (let seed = 1; seed <= 60; seed++) {
      expect(planOpening(new Rng(seed), OPENING.hardFullMs, 'main').hard).toBe(true);
      expect(planOpening(new Rng(seed), 160 * MPH, 'main').hard).toBe(true);
    }
  });
});

describe('the opening', () => {
  it('runs through the stages in order', () => {
    const opening = new Opening(planOpening(new Rng(5), 50, 'main'));
    expect(opening.stage).toBe('pilot-chute');
    const seen: OpeningStage[] = [];
    for (let step = 0; step < 120 * 8; step++) {
      const stage = opening.advance(DT);
      if (stage !== null) seen.push(stage);
      if (opening.stage === 'open') break;
    }
    expect(seen).toEqual(['bag', 'line-stretch', 'snivel', 'inflation', 'open']);
  });

  it('hands the flight force over to the canopy as it inflates', () => {
    const opening = new Opening(planOpening(new Rng(5), 50, 'main'));
    for (let step = 0; step < 120 * 8 && opening.stage !== 'open'; step++) {
      expect(opening.flightBlend()).toBeGreaterThanOrEqual(0);
      expect(opening.flightBlend()).toBeLessThanOrEqual(1);
      expect(opening.inflation).toBeGreaterThanOrEqual(0);
      expect(opening.inflation).toBeLessThanOrEqual(1);
      expect(opening.slider).toBeGreaterThanOrEqual(0);
      expect(opening.slider).toBeLessThanOrEqual(1);
      opening.advance(DT);
    }
    expect(opening.stage).toBe('open');
    expect(opening.flightBlend()).toBe(1);
    expect(opening.inflation).toBe(1);
    expect(opening.slider).toBe(0);
  });
});

describe('the main opening', () => {
  const runs = runSeeds(TERMINAL_MS, 'main');
  const openTimes = runs.map((r) => r.openS);
  const peaks = runs.map((r) => r.peakG);
  const losses = runs.map((r) => r.lostFt);

  it('takes three and a half to five seconds from the throw to full flight', () => {
    expect(min(openTimes)).toBeGreaterThan(3.7);
    expect(max(openTimes)).toBeLessThan(5.2);
  });

  it('takes four to five seconds on average', () => {
    expect(mean(openTimes)).toBeGreaterThan(4.0);
    expect(mean(openTimes)).toBeLessThan(5.0);
  });

  it('pulls two and a half to five and a half g through a normal opening', () => {
    for (const peak of peaks) {
      expect(peak).toBeGreaterThan(2.8);
      expect(peak).toBeLessThan(5.5);
    }
  });

  it('loses five hundred and seventy to nine hundred and forty five feet', () => {
    for (const lost of losses) {
      expect(lost).toBeGreaterThan(570);
      expect(lost).toBeLessThan(945);
    }
  });

  it('is never a hard opening at the belly-neutral terminal speed', () => {
    for (const run of runs) {
      expect(run.plan.hard).toBe(false);
    }
  });
});

describe('the reserve opening', () => {
  it('is open within three and a fifth of a second', () => {
    const runs = runSeeds(TERMINAL_MS, 'reserve');
    for (const run of runs) {
      expect(run.openS).toBeLessThan(3.2);
    }
    expect(min(runs.map((r) => r.openS))).toBeGreaterThan(1);
  });
});

describe('hard openings', () => {
  it('makes between thirty and seventy percent of the openings hard at 150 mph', () => {
    const runs = runSeeds(150 * MPH, 'main');
    const hard = runs.filter((r) => r.plan.hard);
    expect(hard.length / runs.length).toBeGreaterThan(0.3);
    expect(hard.length / runs.length).toBeLessThan(0.7);
  });

  it('makes every opening hard at 160 mph', () => {
    const runs = runSeeds(160 * MPH, 'main');
    for (const run of runs) {
      expect(run.plan.hard).toBe(true);
    }
  });

  it('makes no opening hard at 120 mph', () => {
    const runs = runSeeds(120 * MPH, 'main');
    for (const run of runs) {
      expect(run.plan.hard).toBe(false);
    }
  });

  it('pulls more than eight g through every hard opening', () => {
    for (const mph of [150, 160]) {
      const hard = runSeeds(mph * MPH, 'main').filter((r) => r.plan.hard);
      expect(hard.length).toBeGreaterThan(0);
      for (const run of hard) {
        expect(run.peakG).toBeGreaterThan(8);
      }
    }
  });

  it('keeps the openings that are not hard inside the normal band', () => {
    for (const mph of [120, 150]) {
      const soft = runSeeds(mph * MPH, 'main').filter((r) => !r.plan.hard);
      expect(soft.length).toBeGreaterThan(0);
      for (const run of soft) {
        expect(run.peakG).toBeGreaterThan(2.8);
        expect(run.peakG).toBeLessThan(5.5);
      }
    }
  });
});
