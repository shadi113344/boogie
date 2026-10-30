import { describe, it, expect } from 'vitest';
import { SEA_LEVEL_DENSITY, isaDensity } from '@/sim/atmosphere';

describe('isaDensity', () => {
  it('is the standard density at sea level', () => {
    expect(SEA_LEVEL_DENSITY).toBe(1.225);
    expect(Math.abs(isaDensity(0) - 1.225)).toBeLessThanOrEqual(0.001);
  });

  it('follows the standard atmosphere up the hill', () => {
    expect(Math.abs(isaDensity(1000) - 1.1117)).toBeLessThanOrEqual(0.002);
    expect(Math.abs(isaDensity(4000) - 0.8194)).toBeLessThanOrEqual(0.002);
  });

  it('takes a temperature offset', () => {
    expect(Math.abs(isaDensity(0, 15) - 1.164)).toBeLessThanOrEqual(0.003);
  });

  it('thins out with altitude and with warmth', () => {
    expect(isaDensity(4000)).toBeLessThan(isaDensity(1000));
    expect(isaDensity(1000)).toBeLessThan(isaDensity(0));
    expect(isaDensity(0, 15)).toBeLessThan(isaDensity(0));
    expect(isaDensity(0, -15)).toBeGreaterThan(isaDensity(0));
  });
});
