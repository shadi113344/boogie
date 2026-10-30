import { describe, it, expect } from 'vitest';
import { DEFAULT_DROP_ZONE_ID, DROP_ZONES, findDropZone } from '@/data/dropzones';

describe('drop zones', () => {
  it('has the six preloaded drop zones with valid fields', () => {
    expect(DROP_ZONES.map((d) => d.id).sort()).toEqual([
      'dubai',
      'empuriabrava',
      'gryttjom',
      'hinton',
      'interlaken',
      'sharm',
    ]);

    for (const d of DROP_ZONES) {
      expect(Math.abs(d.lz.lat)).toBeLessThanOrEqual(90);
      expect(Math.abs(d.lz.lon)).toBeLessThanOrEqual(180);
      expect(d.exitAltitudeFt).toBeGreaterThanOrEqual(12000);
      expect(() => new Intl.DateTimeFormat('en', { timeZone: d.timeZone })).not.toThrow();
    }
  });

  it('uses metres at the three European metric DZs', () => {
    for (const id of ['gryttjom', 'interlaken', 'empuriabrava']) {
      expect(findDropZone(id)?.units).toBe('m');
    }
    expect(findDropZone('hinton')?.units).toBe('ft');
  });

  it('findDropZone returns undefined for unknown ids', () => {
    expect(findDropZone('nowhere')).toBeUndefined();
  });

  it('defaults to Interlaken', () => {
    expect(findDropZone(DEFAULT_DROP_ZONE_ID)?.id).toBe('interlaken');
  });
});
