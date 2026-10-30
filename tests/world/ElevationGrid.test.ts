import { describe, it, expect } from 'vitest';
import { ElevationGrid } from '@/world/ElevationGrid';
import {
  LocalFrame,
  lonLatToMercator,
  lonLatToTile,
  mercatorToLonLat,
  metersPerPixel,
  tileBoundsMercator,
  tileKey,
} from '@/world/geo';
import type { TileCoord } from '@/world/geo';
import { TERRARIUM_TILE_SIZE } from '@/world/terrarium';

const TILE = TERRARIUM_TILE_SIZE;
const ORIGIN = { lon: 7.88, lat: 46.68 };
const frame = new LocalFrame(ORIGIN);

/** A tile of one constant height, in metres above sea level. */
function flatTile(height: number): Float32Array {
  return new Float32Array(TILE * TILE).fill(height);
}

/**
 * A tile whose height grows by 1 m for every pixel row southwards.
 *
 * The height is the row's index in the zoom-z pixel grid (y * 256 + row), so
 * the ramp runs on unbroken from one tile of that zoom to the next.
 */
function rampTile(z: number, x: number, y: number): Float32Array {
  if (y < 0 || y >= 2 ** z) throw new Error(`tile ${z}/${x}/${y} is outside the zoom ${z} grid`);
  const heights = new Float32Array(TILE * TILE);
  for (let row = 0; row < TILE; row++) {
    const h = y * TILE + row;
    for (let col = 0; col < TILE; col++) heights[row * TILE + col] = h;
  }
  return heights;
}

describe('ElevationGrid', () => {
  it('returns null with no tiles and 0 from sampleLocal', () => {
    const g = new ElevationGrid(frame);
    expect(g.tileCount()).toBe(0);
    expect(g.sample(ORIGIN)).toBeNull();
    expect(g.finestLoadedTileFor(ORIGIN)).toBeNull();
    expect(g.sampleLocal(0, 0)).toBe(0);
    expect(g.groundY(0, 0)).toBe(0);
  });

  it('elevationTileFor caps zoom at maxZoom and rescales x,y', () => {
    const g = new ElevationGrid(frame);
    expect(g.maxZoom).toBe(14);
    expect(g.elevationTileFor({ z: 16, x: 34202, y: 23137 })).toEqual({ z: 14, x: 8550, y: 5784 });
    expect(g.elevationTileFor({ z: 10, x: 534, y: 361 })).toEqual({ z: 10, x: 534, y: 361 });
  });

  it('elevationTileFor honours a custom maxZoom', () => {
    const g = new ElevationGrid(frame, { maxZoom: 12 });
    expect(g.maxZoom).toBe(12);
    expect(g.elevationTileFor({ z: 16, x: 34202, y: 23137 })).toEqual({ z: 12, x: 2137, y: 1446 });
    expect(g.elevationTileFor({ z: 12, x: 2137, y: 1445 })).toEqual({ z: 12, x: 2137, y: 1445 });
  });

  it('samples bilinearly inside a ramp tile', () => {
    const g = new ElevationGrid(frame);
    const t = lonLatToTile(ORIGIN, 14);
    const south = { z: 14, x: t.x, y: t.y + 1 };
    g.addTile(t, rampTile(14, t.x, t.y));
    g.addTile(south, rampTile(14, south.x, south.y));

    // A quarter of a tile south, measured in the local frame's metres.
    const b = tileBoundsMercator(t);
    const quarter = ((b.maxY - b.minY) / 4) * frame.scale;

    const a = g.sample(ORIGIN);
    const s = g.sample(frame.toLonLat(0, quarter));
    expect(a).not.toBeNull();
    expect(s).not.toBeNull();
    expect(a?.zoom).toBe(14);
    expect(s?.zoom).toBe(14);
    // The ramp climbs 1 m per row, and a quarter tile is 64 rows.
    expect((s?.height ?? 0) - (a?.height ?? 0)).toBeCloseTo(64, 1);
  });

  it('interpolates between pixel centres along a column ramp', () => {
    const g = new ElevationGrid(frame);
    const t = lonLatToTile(ORIGIN, 14);
    const heights = new Float32Array(TILE * TILE);
    for (let row = 0; row < TILE; row++) {
      for (let col = 0; col < TILE; col++) heights[row * TILE + col] = col;
    }
    g.addTile(t, heights);

    const a = g.sampleLocal(0, 0);
    const b = g.sampleLocal(metersPerPixel(ORIGIN.lat, 14), 0);
    // One pixel further east is one metre higher on this ramp.
    expect(b - a).toBeCloseTo(1, 6);
    // The origin falls between two pixel centres, so the height is fractional.
    expect(a % 1).not.toBe(0);
  });

  it('puts the pixel centres at (i + 0.5) / 256', () => {
    const g = new ElevationGrid(frame);
    const t = lonLatToTile(ORIGIN, 14);
    const heights = new Float32Array(TILE * TILE);
    for (let row = 0; row < TILE; row++) {
      for (let col = 0; col < TILE; col++) heights[row * TILE + col] = col;
    }
    g.addTile(t, heights);

    // The centre of the tile's first column pixel.
    const b = tileBoundsMercator(t);
    const m = lonLatToMercator(ORIGIN);
    const centre = mercatorToLonLat(b.minX + ((b.maxX - b.minX) * 0.5) / TILE, m.y);

    expect(g.sample(centre)?.height).toBeCloseTo(0, 6);
  });

  it('prefers the finest loaded tile', () => {
    const g = new ElevationGrid(frame);
    const t12 = lonLatToTile(ORIGIN, 12);
    const t14 = lonLatToTile(ORIGIN, 14);
    g.addTile(t12, flatTile(100));
    g.addTile(t14, flatTile(200));

    expect(g.tileCount()).toBe(2);
    expect(g.hasTile(t12)).toBe(true);
    expect(g.hasTile(t14)).toBe(true);
    expect(g.finestLoadedTileFor(ORIGIN)).toEqual(t14);

    const s = g.sample(ORIGIN);
    expect(s?.height).toBe(200);
    expect(s?.zoom).toBe(14);
  });

  it('falls back to a coarser loaded tile', () => {
    const g = new ElevationGrid(frame);
    const t12 = lonLatToTile(ORIGIN, 12);
    g.addTile(t12, flatTile(100));

    expect(g.finestLoadedTileFor(ORIGIN)).toEqual(t12);
    const s = g.sample(ORIGIN);
    expect(s?.height).toBe(100);
    expect(s?.zoom).toBe(12);
  });

  it('keeps negative heights', () => {
    const g = new ElevationGrid(frame);
    const t = lonLatToTile(ORIGIN, 14);
    g.addTile(t, flatTile(-3));

    const s = g.sample(ORIGIN);
    expect(s?.height).toBe(-3);
    expect(g.sampleLocal(0, 0)).toBe(-3);
  });

  it('groundY subtracts curvature', () => {
    const g = new ElevationGrid(frame);
    const t = lonLatToTile(frame.toLonLat(10000, 0), 14);
    g.addTile(t, flatTile(0));

    expect(g.sampleLocal(10000, 0)).toBe(0);
    expect(g.groundY(10000, 0)).toBeCloseTo(-7.85, 1);
    expect(g.groundY(0, 0)).toBe(0);
  });

  it('samples ten thousand points in one tile the same as a grid that has to walk', () => {
    const t = lonLatToTile(ORIGIN, 14);
    const east = { z: 14, x: t.x + 1, y: t.y };

    // One grid with the tile on its own: the tile that answered last time is
    // the tile that answers now.
    const cached = new ElevationGrid(frame);
    cached.addTile(t, rampTile(14, t.x, t.y));

    // Another grid with a second tile beside it, so the points of the first
    // tile are answered by a walk through the zooms every time.
    const walked = new ElevationGrid(frame);
    walked.addTile(t, rampTile(14, t.x, t.y));
    const eastHeights = new Float32Array(TILE * TILE);
    for (let row = 0; row < TILE; row++) {
      for (let col = 0; col < TILE; col++) eastHeights[row * TILE + col] = 1000 + col;
    }
    walked.addTile(east, eastHeights);

    // Ten thousand points inside the tile, spread over it by a fixed
    // sequence, so the run is the same every time.
    const b = tileBoundsMercator(t);
    const e = tileBoundsMercator(east);
    let seed = 20241013;
    const next = (): number => {
      seed = (Math.imul(seed, 1103515245) + 12345) | 0;
      return (seed >>> 0) / 4294967296;
    };

    let worst = 0;
    let zooms = new Set<number>();
    for (let i = 0; i < 10_000; i++) {
      const mx = b.minX + (b.maxX - b.minX) * (0.001 + 0.998 * next());
      const my = b.minY + (b.maxY - b.minY) * (0.001 + 0.998 * next());
      const point = mercatorToLonLat(mx, my);

      const here = cached.sample(point);

      // A point of the other tile in between, so the remembered tile is of
      // no use when the next point is asked for.
      walked.sample(
        mercatorToLonLat(
          e.minX + (e.maxX - e.minX) * (0.001 + 0.998 * next()),
          e.minY + (e.maxY - e.minY) * (0.001 + 0.998 * next()),
        ),
      );

      const there = walked.sample(point);
      zooms.add(here?.zoom ?? -1);
      zooms.add(there?.zoom ?? -1);
      worst = Math.max(worst, Math.abs((here?.height ?? 0) - (there?.height ?? 0)));
    }

    // The remembered tile does not change the answer, and the answer comes
    // from the tile the point is in.
    expect([...zooms]).toEqual([14]);
    expect(worst).toBe(0);
  });

  it('keeps 192 height tiles by default', () => {
    const g = new ElevationGrid(frame);

    // One array for all of them: the test is about the number of tiles the
    // grid keeps, not about the heights in them.
    const heights = flatTile(100);
    for (let i = 0; i < 200; i++) {
      g.addTile({ z: 14, x: i, y: 0 }, heights);
    }

    expect(g.tileCount()).toBe(192);
  });

  it('throws the least recently used tile away when it runs out of room', () => {
    const evicted: TileCoord[] = [];
    const g = new ElevationGrid(frame, {
      maxTiles: 192,
      onEvict: (t) => evicted.push(t),
    });

    const heights = flatTile(100);
    for (let i = 0; i < 200; i++) {
      g.addTile({ z: 14, x: i, y: 0 }, heights);
    }

    // The first eight tiles are the ones that have been out of the way the
    // longest, so they are the ones that go.
    expect(g.tileCount()).toBe(192);
    expect(evicted.length).toBe(8);
    expect(evicted.map(tileKey)).toEqual([
      '14/0/0',
      '14/1/0',
      '14/2/0',
      '14/3/0',
      '14/4/0',
      '14/5/0',
      '14/6/0',
      '14/7/0',
    ]);
    expect(g.hasTile({ z: 14, x: 0, y: 0 })).toBe(false);
    expect(g.hasTile({ z: 14, x: 7, y: 0 })).toBe(false);
    expect(g.hasTile({ z: 14, x: 8, y: 0 })).toBe(true);
    expect(g.hasTile({ z: 14, x: 199, y: 0 })).toBe(true);
  });

  it('keeps a tile that has been sampled from being the next one thrown away', () => {
    const g = new ElevationGrid(frame, { maxTiles: 2 });

    const home = lonLatToTile(ORIGIN, 14);
    const east = { z: 14, x: home.x + 1, y: home.y };
    const west = { z: 14, x: home.x - 1, y: home.y };

    g.addTile(home, flatTile(100));
    g.addTile(east, flatTile(200));

    // The ground under the origin is asked for, so the tile that holds it is
    // the one that is in use.
    expect(g.sample(ORIGIN)?.height).toBe(100);

    // The next tile to arrive pushes the east tile out, not the home tile.
    g.addTile(west, flatTile(300));

    expect(g.tileCount()).toBe(2);
    expect(g.hasTile(home)).toBe(true);
    expect(g.hasTile(east)).toBe(false);
    expect(g.hasTile(west)).toBe(true);
  });

  it('tells the caller which tile it has thrown away', () => {
    const evicted: TileCoord[] = [];
    const g = new ElevationGrid(frame, { maxTiles: 1 });
    g.onEvict = (t) => evicted.push(t);

    const first = { z: 14, x: 3, y: 4 };
    g.addTile(first, flatTile(100));
    g.addTile({ z: 14, x: 5, y: 6 }, flatTile(200));

    expect(evicted).toEqual([first]);
    expect(g.hasTile(first)).toBe(false);
  });
});
