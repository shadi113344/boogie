import { describe, it, expect } from 'vitest';
import { FixedStep, SIM_HZ, SIM_DT } from '@/sim/FixedStep';

describe('FixedStep', () => {
  it('steps at 120 Hz', () => {
    expect(SIM_HZ).toBe(120);
    expect(SIM_DT).toBeCloseTo(1 / 120, 12);
  });

  it('runs six steps for 50 ms', () => {
    let steps = 0;
    const fixed = new FixedStep(() => {
      steps++;
    });
    expect(fixed.advance(0.05)).toBe(6);
    expect(steps).toBe(6);
  });

  it('keeps the time left over under one step', () => {
    let steps = 0;
    const fixed = new FixedStep(() => {
      steps++;
    });
    fixed.advance(0.004);
    fixed.advance(0.004);
    fixed.advance(0.004);
    expect(steps).toBe(1);
  });

  it('catches up at most twelve steps and lets the rest go', () => {
    let steps = 0;
    const fixed = new FixedStep(() => {
      steps++;
    });
    expect(fixed.advance(1)).toBe(12);
    expect(steps).toBe(12);
  });

  it('does not bank the time it dropped after a late frame', () => {
    let steps = 0;
    const fixed = new FixedStep(() => {
      steps++;
    });
    fixed.advance(1);
    fixed.advance(0);
    expect(steps).toBe(12);
  });

  it('flags the first step of every call', () => {
    const flags: boolean[] = [];
    const fixed = new FixedStep((_dt, first) => {
      flags.push(first);
    });
    fixed.advance(0.05);
    expect(flags).toEqual([true, false, false, false, false, false]);
    flags.length = 0;
    fixed.advance(0.004);
    expect(flags).toEqual([]);
    fixed.advance(0.004);
    expect(flags).toEqual([]);
    fixed.advance(0.004);
    expect(flags).toEqual([true]);
  });

  it('always passes the same dt to the step', () => {
    const dts: number[] = [];
    const fixed = new FixedStep((dt) => {
      dts.push(dt);
    });
    fixed.advance(0.05);
    expect(dts.length).toBe(6);
    for (const dt of dts) expect(dt).toBe(SIM_DT);
  });

  it('never runs the jump backwards', () => {
    let steps = 0;
    const fixed = new FixedStep(() => {
      steps++;
    });
    fixed.advance(-1);
    expect(steps).toBe(0);
    fixed.advance(0.05);
    expect(steps).toBe(6);
  });

  it('forgets the leftover time on reset', () => {
    let steps = 0;
    const fixed = new FixedStep(() => {
      steps++;
    });
    fixed.advance(0.004);
    fixed.advance(0.004);
    fixed.advance(0.004);
    expect(steps).toBe(1);
    fixed.reset();
    fixed.advance(0.004);
    expect(steps).toBe(1);
  });
});
