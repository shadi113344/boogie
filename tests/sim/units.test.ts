import { describe, it, expect } from 'vitest';
import {
  FT,
  MPH,
  KT,
  FPM,
  KMH,
  G,
  formatAltitude,
  formatSpeed,
  formatDistance,
} from '@/sim/units';

describe('units', () => {
  it('exposes the conversion constants', () => {
    expect(FT).toBeCloseTo(0.3048, 10);
    expect(MPH).toBeCloseTo(0.44704, 10);
    expect(KT).toBeCloseTo(0.514444, 10);
    expect(FPM).toBeCloseTo(0.00508, 10);
    expect(KMH).toBeCloseTo(1 / 3.6, 10);
    expect(G).toBeCloseTo(9.80665, 10);
  });

  it('formats an altitude in feet, to the nearest ten', () => {
    expect(formatAltitude(4114.8, 'ft')).toBe('13,500 ft');
    expect(formatAltitude(4114.8, 'm')).toBe('4,110 m');
  });

  it('formats a speed in the units of the drop zone', () => {
    expect(formatSpeed(53.6448, 'ft')).toBe('120 mph');
    expect(formatSpeed(53.6448, 'm')).toBe('193 km/h');
  });

  it('formats a distance to the nearest whole unit', () => {
    expect(formatDistance(106.68, 'ft')).toBe('350 ft');
    expect(formatDistance(106.68, 'm')).toBe('107 m');
  });

  it('rounds an altitude to the nearest ten', () => {
    expect(formatAltitude(101.9, 'm')).toBe('100 m');
    expect(formatAltitude(105, 'm')).toBe('110 m');
    expect(formatAltitude(4104, 'ft')).toBe('13,460 ft');
  });

  it('rounds a speed to the nearest whole unit', () => {
    expect(formatSpeed(0, 'ft')).toBe('0 mph');
    expect(formatSpeed(53.9, 'm')).toBe('194 km/h');
  });

  it('separates the thousands itself, without the locale', () => {
    expect(formatAltitude(12192, 'ft')).toBe('40,000 ft');
    expect(formatAltitude(1234567, 'm')).toBe('1,234,570 m');
    expect(formatSpeed(223.52, 'ft')).toBe('500 mph');
    expect(formatDistance(1234.5, 'm')).toBe('1,235 m');
  });
});
