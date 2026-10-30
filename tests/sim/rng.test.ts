import { describe, it, expect } from 'vitest';
import { Rng } from '@/sim/rng';

describe('Rng', () => {
  it('gives the same numbers for the same seed', () => {
    const a = new Rng(7);
    const b = new Rng(7);
    for (let i = 0; i < 1000; i++) expect(a.next()).toBe(b.next());
  });

  it('gives different numbers for different seeds', () => {
    const a = new Rng(7);
    const b = new Rng(8);
    let same = 0;
    for (let i = 0; i < 1000; i++) if (a.next() === b.next()) same++;
    expect(same).toBe(0);
  });

  it('stays in [0, 1)', () => {
    const rng = new Rng(12345);
    for (let i = 0; i < 1000; i++) {
      const v = rng.next();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it('ranges between the bounds', () => {
    const rng = new Rng(3);
    for (let i = 0; i < 1000; i++) {
      const v = rng.range(-5, 15);
      expect(v).toBeGreaterThanOrEqual(-5);
      expect(v).toBeLessThan(15);
    }
  });

  it('draws normals with a mean of zero and a unit variance', () => {
    const rng = new Rng(2024);
    const n = 20000;
    let sum = 0;
    let sumSq = 0;
    for (let i = 0; i < n; i++) {
      const v = rng.normal();
      expect(Number.isFinite(v)).toBe(true);
      sum += v;
      sumSq += v * v;
    }
    const mean = sum / n;
    const variance = sumSq / n - mean * mean;
    expect(mean).toBeGreaterThan(-0.05);
    expect(mean).toBeLessThan(0.05);
    expect(variance).toBeGreaterThan(0.95);
    expect(variance).toBeLessThan(1.05);
  });
});
