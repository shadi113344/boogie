import { describe, it, expect } from 'vitest';
import { sunPosition, sunDirectionLocal, localTimeToDate } from '@/world/sun';

const INTERLAKEN = { lon: 7.88, lat: 46.68 };

describe('sun', () => {
  it('sun at Interlaken at 12:00 UTC on 21 June 2026 is high in the south', () => {
    const s = sunPosition(new Date('2026-06-21T12:00:00Z'), INTERLAKEN);
    expect(s.elevationDeg).toBeGreaterThan(64.5);
    expect(s.elevationDeg).toBeLessThan(67.5);
    expect(s.azimuthDeg).toBeGreaterThan(165);
    expect(s.azimuthDeg).toBeLessThan(200);
  });

  it('sun is below the horizon at local midnight', () => {
    expect(
      sunPosition(new Date('2026-06-21T00:00:00Z'), INTERLAKEN).elevationDeg,
    ).toBeLessThan(-10);
  });

  it('sun direction is a unit vector with y = sin(elevation)', () => {
    const date = new Date('2026-06-21T12:00:00Z');
    const s = sunPosition(date, INTERLAKEN);
    const v = sunDirectionLocal(date, INTERLAKEN);
    expect(Math.hypot(v.x, v.y, v.z)).toBeCloseTo(1, 6);
    expect(v.y).toBeCloseTo(Math.sin((s.elevationDeg * Math.PI) / 180), 6);
    // The sun is in the west-south-west: west is -x, south is +z.
    expect(v.x).toBeLessThan(0);
    expect(v.z).toBeGreaterThan(0);
  });

  it('localTimeToDate respects the zone', () => {
    const d = localTimeToDate(INTERLAKEN, 'Europe/Zurich', '2026-06-21', 10);
    expect(d.toISOString()).toBe('2026-06-21T08:00:00.000Z');
  });

  it('localTimeToDate respects standard time in winter', () => {
    const d = localTimeToDate(INTERLAKEN, 'Europe/Zurich', '2026-01-21', 10);
    expect(d.toISOString()).toBe('2026-01-21T09:00:00.000Z');
  });

  it('localTimeToDate handles zones behind UTC', () => {
    const d = localTimeToDate({ lon: -74, lat: 40.7 }, 'America/New_York', '2026-06-21', 10);
    expect(d.toISOString()).toBe('2026-06-21T14:00:00.000Z');
  });

  it('the sun rises in the east and sets in the west', () => {
    const morning = sunPosition(
      localTimeToDate(INTERLAKEN, 'Europe/Zurich', '2026-06-21', 6),
      INTERLAKEN,
    );
    expect(morning.elevationDeg).toBeGreaterThan(0);
    expect(morning.azimuthDeg).toBeGreaterThan(45);
    expect(morning.azimuthDeg).toBeLessThan(120);

    const evening = sunPosition(
      localTimeToDate(INTERLAKEN, 'Europe/Zurich', '2026-06-21', 20),
      INTERLAKEN,
    );
    expect(evening.elevationDeg).toBeGreaterThan(0);
    expect(evening.azimuthDeg).toBeGreaterThan(250);
    expect(evening.azimuthDeg).toBeLessThan(330);
  });
});
