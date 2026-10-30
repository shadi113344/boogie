import { describe, it, expect } from 'vitest';
import { LocalFrame, TileCoord, parentTile, tileKey } from '@/world/geo';
import { TerrainQuadtree, computeRenderSet } from '@/render/terrain/TerrainQuadtree';

const frame = new LocalFrame({ lon: 7.88, lat: 46.68 });
const lz = { x: 0, z: 0 };
const flat = () => ({ min: 568, max: 568 });
const q = new TerrainQuadtree(frame, lz);

/** Straight down, with a 60 degree vertical field of view on an iPhone. */
const down = { dir: { x: 0, y: -1, z: 0 }, halfAngleRad: 0.6 };

function containsLocal(f: LocalFrame, t: TileCoord, x: number, z: number): boolean {
  const b = f.tileBoundsLocal(t);
  return x >= b.minX && x <= b.maxX && z >= b.minZ && z <= b.maxZ;
}

describe('TerrainQuadtree', () => {
  it('root tiles cover ±250 km', () => {
    const q = new TerrainQuadtree(frame, lz);
    const roots = q.rootTiles();
    expect(roots.length).toBeGreaterThanOrEqual(25);
    expect(roots.every((t) => t.z === 8)).toBe(true);
  });

  it('zoom caps follow distance from the landing area', () => {
    expect(q.zoomCapAt(1000, 0)).toBe(18);
    expect(q.zoomCapAt(3000, 0)).toBe(17);
    expect(q.zoomCapAt(20000, 0)).toBe(14);
    expect(q.zoomCapAt(200000, 0)).toBe(9);
  });

  it('from exit altitude the tile under the camera is zoom 16', () => {
    const cam = { x: 0, y: 568 + 4115, z: 0, focalPx: 1462, ...down };
    const under = q.select(cam, flat).find((t) => containsLocal(frame, t, 0, 0));
    expect(under?.z).toBe(16);
  });

  it('tiles behind the camera stay at zoom 12 or coarser', () => {
    const cam = { x: 0, y: 568 + 4115, z: 0, focalPx: 1462, ...down };
    const behind = q
      .select(cam, flat)
      .filter((t) => {
        const b = frame.tileBoundsLocal(t);
        return Math.min(Math.abs(b.minZ), Math.abs(b.maxZ)) > 20000;
      });
    expect(behind.length).toBeGreaterThan(0);
    expect(Math.max(...behind.map((t) => t.z))).toBeLessThanOrEqual(12);
  });

  it('on final at 300 ft the tile under the camera is capped at zoom 18', () => {
    const cam = { x: 800, y: 568 + 91, z: 0, focalPx: 1462, ...down };
    expect(q.select(cam, flat).find((t) => containsLocal(frame, t, 800, 0))?.z).toBe(18);
  });

  it('50 km away never exceeds zoom 14', () => {
    const cam = {
      x: 50000,
      y: 568 + 500,
      z: 0,
      focalPx: 1462,
      dir: { x: -1, y: -0.2, z: 0 },
      halfAngleRad: 0.6,
    };
    expect(Math.max(...q.select(cam, flat).map((t) => t.z))).toBeLessThanOrEqual(14);
  });

  it('never returns more than maxLeaves, even for a 4K desktop', () => {
    for (const f of [1462, 2078, 4000]) {
      expect(q.select({ x: 0, y: 4683, z: 0, focalPx: f, ...down }, flat).length).toBeLessThanOrEqual(
        400,
      );
    }
  });

  it('looking forward 30 degrees down from exit altitude keeps the ground 3 km ahead at zoom 15 or finer, within budget', () => {
    const cam = { x: 0, y: 568 + 4115, z: 0, focalPx: 1462, dir: { x: 0, y: -0.5, z: -0.866 }, halfAngleRad: 0.6 };
    const leaves = q.select(cam, flat);
    expect(leaves.length).toBeLessThanOrEqual(400);
    expect(leaves.find(t => containsLocal(frame, t, 0, -3000))?.z).toBeGreaterThanOrEqual(15);
  });

  it('spends the budget on the largest screen errors first', () => {
    const small = new TerrainQuadtree(frame, lz, { maxLeaves: 120 });
    const cam = { x: 0, y: 568 + 4115, z: 0, focalPx: 1462, ...down };
    const leaves = small.select(cam, flat);
    expect(leaves.length).toBeLessThanOrEqual(120);
    const under = leaves.find(t => containsLocal(frame, t, 0, 0))!;
    const far = leaves.find(t => containsLocal(frame, t, 0, -40000))!;
    expect(under.z).toBeGreaterThan(far.z);
  });

  it('never splits a tile whose error is at or below tau', () => {
    // The root tile under the camera has a texel error of about 150 from
    // exit altitude, so a tau above that must leave the whole root ring alone.
    const coarse = new TerrainQuadtree(frame, lz, { tau: 1000 });
    const cam = { x: 0, y: 568 + 4115, z: 0, focalPx: 1462, ...down };
    expect(coarse.select(cam, flat).every(t => t.z === 8)).toBe(true);
  });
});

describe('computeRenderSet', () => {
  it('falls back to the nearest ready ancestor and dedupes', () => {
    const leaf = { z: 16, x: 34202, y: 23137 };
    const sib = { z: 16, x: 34203, y: 23137 };
    const p = parentTile(leaf)!;
    const set = computeRenderSet([leaf, sib], (t) => tileKey(t) === tileKey(p));
    expect(set).toEqual([p]);
  });

  it('drops a leaf with no ready ancestor', () => {
    expect(computeRenderSet([{ z: 16, x: 1, y: 1 }], () => false)).toEqual([]);
  });
});
