import { describe, it, expect } from 'vitest';
import { AdaptiveQuality, QUALITY, defaultTier } from '@/app/Quality';

describe('quality', () => {
  it('defaultTier picks medium for a dense screen', () => {
    expect(defaultTier(3, 8, 5)).toBe('medium');
    expect(defaultTier(2.625, 8, 5)).toBe('medium');
    expect(defaultTier(2, 8, 0)).toBe('medium');
  });

  it('defaultTier picks medium for a small machine', () => {
    expect(defaultTier(1, 4, 0)).toBe('medium');
    expect(defaultTier(1, 3, 0)).toBe('medium');
    expect(defaultTier(1, 5, 0)).toBe('high');
  });

  it('defaultTier picks medium for a touch screen', () => {
    expect(defaultTier(1, 8, 10)).toBe('medium');
    expect(defaultTier(1, 8, 0)).toBe('high');
  });

  it('holds the numbers of the tiers', () => {
    expect(QUALITY.low).toEqual({
      maxPixelRatio: 1.0,
      tau: 2.4,
      anisotropy: 2,
      maxTextures: 192,
      maxLeaves: 96,
    });
    expect(QUALITY.medium).toEqual({
      maxPixelRatio: 1.5,
      tau: 1.8,
      anisotropy: 4,
      maxTextures: 256,
      maxLeaves: 160,
    });
    expect(QUALITY.high).toEqual({
      maxPixelRatio: 2.0,
      tau: 1.2,
      anisotropy: 8,
      maxTextures: 384,
      maxLeaves: 240,
    });
  });

  it('steps down after 2 s of slow frames and then holds through the cooldown', () => {
    const q = new AdaptiveQuality('high');
    const changed: string[] = [];

    for (let t = 0; t <= 2100; t += 16) {
      const r = q.pushFrame(30, t);
      if (r) changed.push(r);
    }
    expect(changed).toEqual(['medium']);
    expect(q.tier).toBe('medium');

    for (let t = 2116; t <= 6000; t += 16) {
      const r = q.pushFrame(30, t);
      if (r) changed.push(r);
    }
    expect(changed).toEqual(['medium']);
    expect(q.tier).toBe('medium');
  });

  it('never steps below low and never steps up', () => {
    const low = new AdaptiveQuality('low');
    for (let t = 0; t <= 20_000; t += 16) {
      expect(low.pushFrame(30, t)).toBeNull();
    }
    expect(low.tier).toBe('low');

    const medium = new AdaptiveQuality('medium');
    for (let t = 0; t <= 20_000; t += 16) {
      expect(medium.pushFrame(10, t)).toBeNull();
    }
    expect(medium.tier).toBe('medium');
  });

  it('a locked tier never changes', () => {
    const q = new AdaptiveQuality('high');
    q.locked = true;
    for (let t = 0; t <= 20_000; t += 16) {
      expect(q.pushFrame(30, t)).toBeNull();
    }
    expect(q.tier).toBe('high');
  });

  it('fast frames do not step the tier down', () => {
    const q = new AdaptiveQuality('high');
    for (let t = 0; t <= 20_000; t += 16) {
      expect(q.pushFrame(12, t)).toBeNull();
    }
    expect(q.tier).toBe('high');
  });
});
