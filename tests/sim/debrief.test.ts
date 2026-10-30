import { describe, expect, it } from 'vitest';
import { computeDebrief } from '@/sim/debrief';
import { Jump } from '@/sim/Jump';
import { Opening } from '@/sim/opening';
import { FT } from '@/sim/units';
import { WIND_PRESETS } from '@/sim/wind';
import { flyPattern, makeFullConfig } from './scripted';

describe('the debrief of the full jump', () => {
  it('reads the numbers of the jump', () => {
    const jump = new Jump(makeFullConfig());
    flyPattern(jump);
    const debrief = computeDebrief(jump);

    // The throw is at the pull altitude.
    const deploymentFt = (debrief.deploymentAltitudeAglM ?? 0) / FT;
    expect(Math.abs(deploymentFt - 3500)).toBeLessThan(50);
    // The freefall is the time from the exit to the throw.
    expect(debrief.freefallTimeS).toBeGreaterThan(51);
    expect(debrief.freefallTimeS).toBeLessThan(58);
    expect(debrief.exitAltitudeAglM / FT).toBeCloseTo(13500, 6);
    // The canopy was flying for the rest of the jump.
    expect(debrief.canopyTimeS).toBeGreaterThan(60);
    expect(debrief.maxOpeningG).toBeGreaterThan(2.8);
    expect(debrief.maxOpeningG).toBeLessThan(5.5);
    // The jumper fell faster than a hundred and twenty miles an hour.
    expect(debrief.maxVerticalMs).toBeGreaterThan(50);
    expect(debrief.avgVerticalMs).toBeGreaterThan(45);
    expect(debrief.avgVerticalMs).toBeLessThan(debrief.maxVerticalMs);
  });

  it('has nothing to flag', () => {
    const jump = new Jump(makeFullConfig());
    flyPattern(jump);
    const debrief = computeDebrief(jump);

    expect(debrief.flags).toEqual([]);
    expect(debrief.patternTurns).toEqual([]);
  });

  it('says where the jumper landed', () => {
    const jump = new Jump(makeFullConfig());
    flyPattern(jump);
    const debrief = computeDebrief(jump);

    const landing = debrief.landing;
    expect(landing).not.toBeNull();
    expect(landing?.outcome).not.toBe('injury');
    expect(landing?.outcome).not.toBe('fatal');
    expect(landing?.verticalMs ?? 99).toBeLessThan(5);
    expect(landing?.distanceFromTargetM ?? Infinity).toBeLessThan(1500);
    // The canopy flew into the wind, so the jumper landed to the west of the
    // landing area: the bearing is measured clockwise from north.
    expect(landing?.bearingFromTargetDeg ?? 999).toBeGreaterThan(180);
    expect(landing?.bearingFromTargetDeg ?? 999).toBeLessThan(270);
    // The wind at the landing is the wind of the drop zone.
    expect(landing?.windMs ?? 0).toBeGreaterThan(2);
    expect(landing?.windMs ?? 0).toBeLessThan(8);
    expect(landing?.windFromDeg ?? 999).toBeCloseTo(270, 0);
  });
});

describe('the debrief of a low turn', () => {
  it('flags the turn and lists it', () => {
    const jump = new Jump(makeFullConfig());
    flyPattern(jump, { lowTurnAtFt: 400 });
    const debrief = computeDebrief(jump);

    expect(debrief.flags).toContain('low-turn');
    expect(debrief.patternTurns.length).toBeGreaterThan(0);
    const turn = debrief.patternTurns[0];
    expect(turn).toBeDefined();
    // The turn was a half circle, and it was still going on below 500 ft.
    // The measured turn is a little over the half circle the jumper flew:
    // the canopy keeps turning while the bank rolls out.
    expect(Math.abs(turn?.headingChangeDeg ?? 0)).toBeGreaterThan(150);
    expect(Math.abs(turn?.headingChangeDeg ?? 0)).toBeLessThan(230);
    // The turn started at 400 ft: the first sample of the turn is the one
    // before the canopy began to turn.
    expect(turn?.startAglM ?? 0).toBeLessThan(410 * FT);
    expect(turn?.startAglM ?? 0).toBeGreaterThan(380 * FT);
    expect(turn?.endAglM ?? 9999).toBeLessThan(500 * FT);
  });
});

describe('the debrief of a jump with no pull', () => {
  it('flags the missing throw and the AAD', () => {
    const jump = new Jump(makeFullConfig());
    flyPattern(jump, { pull: false });
    const debrief = computeDebrief(jump);

    expect(debrief.flags).toContain('no-pull');
    expect(debrief.flags).toContain('aad-fire');
    expect(debrief.flags).not.toContain('impact');
    // The reserve came out at the height the AAD fires at.
    const deploymentFt = (debrief.deploymentAltitudeAglM ?? 0) / FT;
    expect(deploymentFt).toBeGreaterThan(700);
    expect(deploymentFt).toBeLessThan(800);
    expect(debrief.landing).not.toBeNull();
  });
});

describe('the debrief of a downwind landing', () => {
  it('flags the landing', () => {
    const jump = new Jump(makeFullConfig({ wind: WIND_PRESETS.sporty }));
    flyPattern(jump, { steer: 'downwind' });
    const debrief = computeDebrief(jump);

    expect(debrief.flags).toContain('downwind-landing');
    expect(debrief.landing).not.toBeNull();
  });
});

describe('the debrief of the other flags', () => {
  it('flags a pull that comes too late', () => {
    // The plan is 3,500 ft, and the jumper throws at 2,900 ft.
    const jump = new Jump(makeFullConfig());
    flyPattern(jump, { pullAtFt: 2900 });
    const debrief = computeDebrief(jump);

    // The throw was 600 ft below the 3,500 ft of the plan.
    expect(debrief.flags).toContain('late-pull');
    expect(debrief.flags).not.toContain('no-pull');
    expect(debrief.flags).not.toContain('aad-fire');
    expect((debrief.deploymentAltitudeAglM ?? 0) / FT).toBeCloseTo(2900, -1);
  });

  it('flags a jumper who hits the ground', () => {
    // No AAD and a pull at 500 ft: the opening does not finish in time.
    const jump = new Jump(makeFullConfig({ pullAltitudeFt: 500, aad: false }));
    flyPattern(jump);
    const debrief = computeDebrief(jump);

    expect(debrief.flags).toContain('impact');
    expect(debrief.flags).not.toContain('aad-fire');
    expect(debrief.landing?.outcome).toMatch(/injury|fatal/);
  });

  it('flags a hard opening', () => {
    const jump = new Jump(makeFullConfig());
    flyPattern(jump);
    expect(computeDebrief(jump).flags).not.toContain('hard-opening');

    // The freefall never reaches the speed of a hard opening, so the plan of
    // the opening is set to a hard one to see that the debrief reads it.
    jump.opening = new Opening({
      kind: 'main',
      hesitationS: 0.5,
      snivelS: 0.3,
      hard: true,
    });

    expect(computeDebrief(jump).flags).toContain('hard-opening');
  });
});
