import { describe, it, expect } from 'vitest';
import { LocalFrame, TileCoord, childTiles, parentTile, tileKey } from '@/world/geo';
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

/** A small random generator, so a test can be run again and get the same tiles. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The tiles below a tile, one level down. */
function grandchildrenOf(t: TileCoord): TileCoord[] {
  return childTiles(t).flatMap((child) => childTiles(child));
}

describe('TerrainQuadtree', () => {
  it('root tiles cover ±250 km', () => {
    const q = new TerrainQuadtree(frame, lz);
    const roots = q.rootTiles();
    expect(roots.length).toBeGreaterThanOrEqual(9);
    expect(roots.every((t) => t.z === 7)).toBe(true);
  });

  it('zoom caps follow distance from the landing area', () => {
    expect(q.zoomCapAt(1000, 0)).toBe(17);
    expect(q.zoomCapAt(3000, 0)).toBe(16);
    expect(q.zoomCapAt(20000, 0)).toBe(14);
    expect(q.zoomCapAt(200000, 0)).toBe(9);
  });

  it('from exit altitude the tile under the camera is zoom 15', () => {
    const cam = { x: 0, y: 568 + 4115, z: 0, focalPx: 1462, ...down };
    const under = q.select(cam, flat).find((t) => containsLocal(frame, t, 0, 0));
    expect(under?.z).toBe(15);
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

  it('on final at 300 ft the tile under the camera is capped at zoom 17', () => {
    const cam = { x: 800, y: 568 + 91, z: 0, focalPx: 1462, ...down };
    expect(q.select(cam, flat).find((t) => containsLocal(frame, t, 800, 0))?.z).toBe(17);
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
        160,
      );
    }
  });

  it('looking forward 30 degrees down from exit altitude keeps the ground 3 km ahead at zoom 14, within budget', () => {
    const cam = { x: 0, y: 568 + 4115, z: 0, focalPx: 1462, dir: { x: 0, y: -0.5, z: -0.866 }, halfAngleRad: 0.6 };
    const leaves = q.select(cam, flat);
    expect(leaves.length).toBeLessThanOrEqual(160);
    // The budget is spent on the largest screen errors first, and the 160
    // leaves run out on the fifty tiles that are closer to the camera: all
    // of them have an error above 3.5. The tile three kilometres ahead has
    // an error of 2.16, which is above tau as well, so it would be split
    // too: it is the budget that stops it, and its texel of 6.6 m covers
    // the 3.3 m the screen has there, so the imagery is a little soft.
    expect(leaves.find(t => containsLocal(frame, t, 0, -3000))?.z).toBe(14);
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
    expect(coarse.select(cam, flat).every(t => t.z === 7)).toBe(true);
  });

  it('refines only the tiles it is allowed to', () => {
    const cam = { x: 0, y: 568 + 4115, z: 0, focalPx: 1462, ...down };

    // The tiles below zoom 9 may be split, the ones at zoom 9 may not.
    const limited = q.select(cam, flat, (t) => t.z < 9);
    expect(Math.max(...limited.map((t) => t.z))).toBe(9);

    // Nothing may be split: the selection is the root ring.
    const none = q.select(cam, flat, () => false);
    expect(none.every((t) => t.z === 7)).toBe(true);
    expect(none.length).toBe(q.rootTiles().length);
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

  it('never draws a tile together with one of its ancestors', () => {
    const leaf = { z: 16, x: 34202, y: 23137 };
    const sib = { z: 16, x: 34203, y: 23137 };
    const p = parentTile(leaf)!;

    // The leaf is ready, its sibling is not, and their parent is: the parent
    // covers both, so the leaf is not drawn as well.
    const ready = new Set([tileKey(leaf), tileKey(p)]);
    const set = computeRenderSet([leaf, sib], (t) => ready.has(tileKey(t)));
    expect(set).toEqual([p]);
  });

  it('keeps the four children on screen while a merged parent is not ready', () => {
    const p = { z: 15, x: 17101, y: 11568 };
    const children = childTiles(p);

    // The camera moved away and the parent was merged back into the four
    // tiles that were drawn before it. The parent is not built yet, so the
    // four children keep the ground.
    const ready = new Set(children.map(tileKey));
    const set = computeRenderSet([p], (t) => ready.has(tileKey(t)));
    expect([...set].map(tileKey).sort()).toEqual(children.map(tileKey).sort());
  });

  it('covers from two levels down but no deeper', () => {
    const p = { z: 15, x: 17101, y: 11568 };
    const [c1, c2, c3, c4] = childTiles(p);
    const grandchildren = childTiles(c4);

    // Three children are ready and the fourth is not, but its own four
    // children are: the ground is covered by seven tiles, and the parent is
    // not one of them.
    const ready = new Set([
      tileKey(c1),
      tileKey(c2),
      tileKey(c3),
      ...grandchildren.map(tileKey),
    ]);
    const set = computeRenderSet([p], (t) => ready.has(tileKey(t)));
    expect(set).toHaveLength(7);
    expect(set.some((t) => tileKey(t) === tileKey(p))).toBe(false);

    // Three levels down is too deep: the fourth child cannot be covered, so
    // the parent of the parent stands in for the whole lot.
    const parent = parentTile(p)!;
    const deeper = grandchildren.flatMap((g) => childTiles(g));
    const readyDeep = new Set([
      tileKey(c1),
      tileKey(c2),
      tileKey(c3),
      ...deeper.map(tileKey),
      tileKey(parent),
    ]);
    expect(computeRenderSet([p], (t) => readyDeep.has(tileKey(t)))).toEqual([parent]);
  });

  it('no drawn tile has an ancestor in the set, for any readiness', () => {
    const base = { z: 13, x: 4275, y: 2892 };

    for (let seed = 1; seed <= 200; seed++) {
      const rand = mulberry32(seed);

      // Every tile below the base tile, and its parent, is ready with a
      // probability of one half.
      const ready = new Set<string>();
      const roll = (t: TileCoord): void => {
        if (rand() < 0.5) ready.add(tileKey(t));
      };
      roll(parentTile(base)!);
      roll(base);
      for (const t of childTiles(base)) {
        roll(t);
        for (const g of childTiles(t)) {
          roll(g);
          for (const gg of childTiles(g)) roll(gg);
        }
      }

      // The desired set: the grandchildren of the base tile, some of them
      // replaced by their own four children.
      const desired: TileCoord[] = [];
      for (const t of grandchildrenOf(base)) {
        if (rand() < 0.5) desired.push(...childTiles(t));
        else desired.push(t);
      }

      const set = computeRenderSet(desired, (t) => ready.has(tileKey(t)));
      const drawn = new Set(set.map(tileKey));

      for (const t of set) {
        // Every drawn tile is ready, ...
        expect(ready.has(tileKey(t))).toBe(true);
        // ... and none of them has an ancestor among the drawn tiles.
        let ancestor = parentTile(t);
        while (ancestor !== null) {
          expect(drawn.has(tileKey(ancestor))).toBe(false);
          ancestor = parentTile(ancestor);
        }
      }
    }
  });
});
