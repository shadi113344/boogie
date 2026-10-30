import { describe, it, expect, vi } from 'vitest';
import { Group } from 'three';
import { LocalFrame } from '@/world/geo';
import { ElevationGrid } from '@/world/ElevationGrid';
import { TileCache } from '@/world/TileCache';
import type { Atmosphere } from '@/render/Atmosphere';
import { Terrain } from '@/render/terrain/Terrain';
import { TerrainTile } from '@/render/terrain/TerrainTile';
import type { LodCamera } from '@/render/terrain/TerrainQuadtree';

const frame = new LocalFrame({ lon: 7.88, lat: 46.68 });
const lz = { x: 0, z: 0 };
const atmo = { applyTo() {} } as unknown as Atmosphere;

/** Straight down from exit altitude, with a 60 degree vertical field of view. */
const down = { dir: { x: 0, y: -1, z: 0 }, halfAngleRad: 0.6 };

/** Edge length of a tile, in pixels. */
const TILE_SIZE = 256;

function cameraAt(x: number, y: number, z: number): LodCamera {
  return { x, y, z, focalPx: 1462, ...down };
}

/** The zoom in a tile URL, whichever provider it is from. */
function zoomOf(url: string): number {
  const match = url.match(/\/(?:terrarium|tile|g)\/(\d+)\//);
  return match ? Number(match[1]) : -1;
}

/** Whether a URL is for elevation rather than imagery. */
function isElevation(url: string): boolean {
  return url.includes('/terrarium/');
}

/**
 * A flat tile of heights, in the Terrarium encoding: the metres above sea
 * level are split over the red, green and blue channels.
 */
function terrariumPixels(height = 568): Uint8ClampedArray {
  const value = height + 32768;
  const red = Math.floor(value / 256);
  const green = value - red * 256;
  const data = new Uint8ClampedArray(TILE_SIZE * TILE_SIZE * 4);
  for (let i = 0; i < TILE_SIZE * TILE_SIZE; i++) {
    data[i * 4] = red;
    data[i * 4 + 1] = green;
    data[i * 4 + 2] = 0;
    data[i * 4 + 3] = 255;
  }
  return data;
}

interface CacheFixture {
  cache: TileCache;

  /** The URLs that were fetched, in the order the cache fetched them. */
  fetched: string[];

  /** Let the held elevation tile through. */
  releaseElevation(): void;
}

/**
 * A tile cache that never touches the network.
 *
 * The stubbed seams carry the URL of the tile in the body of the blob, so the
 * decoders know which tile they are working on: the imagery of one zoom can
 * be made to hang and one elevation tile can be held back.
 */
function makeCache(opts: { hangImageZoom?: number; holdElevationZoom?: number } = {}): CacheFixture {
  const fetched: string[] = [];
  let releaseElevation = (): void => {};
  const elevationGate = new Promise<void>((resolve) => {
    releaseElevation = resolve;
  });

  const fetchFn = async (input: RequestInfo | URL): Promise<Response> => {
    const url = String(input);
    fetched.push(url);
    return new Response(url, { status: 200 });
  };

  const decodeImage = async (blob: Blob): Promise<ImageBitmap> => {
    const url = await blob.text();
    if (opts.hangImageZoom !== undefined && zoomOf(url) === opts.hangImageZoom) {
      // Never arrives: the tile stays without imagery.
      await new Promise<never>(() => {});
    }
    return { width: TILE_SIZE, height: TILE_SIZE } as ImageBitmap;
  };

  const decodePixels = async (
    blob: Blob,
  ): Promise<{ data: Uint8ClampedArray; width: number; height: number }> => {
    const url = await blob.text();
    if (opts.holdElevationZoom !== undefined && zoomOf(url) === opts.holdElevationZoom) {
      await elevationGate;
    }
    return { data: terrariumPixels(), width: TILE_SIZE, height: TILE_SIZE };
  };

  const cache = new TileCache({
    fetchFn,
    decodeImage,
    decodePixels,
    // Plenty of room, so a tile that never arrives does not hold up the rest.
    concurrency: 512,
  });

  return { cache, fetched, releaseElevation: () => releaseElevation() };
}

/** Let the requests run to the end. The ones that hang never do. */
async function settle(cache: TileCache): Promise<void> {
  for (let i = 0; i < 40; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    const stats = cache.stats();
    if (stats.pending === 0 && stats.inFlight === 0) return;
  }
}

interface Fixture extends CacheFixture {
  terrain: Terrain;
  world: Group;
}

/** A terrain over a fake world, streaming into the given cache. */
function makeTerrain(
  cacheFixture: CacheFixture,
  opts: { maxVisibleTiles?: number } = {},
): Fixture {
  const world = new Group();
  const elevation = new ElevationGrid(frame);
  const terrain = new Terrain(
    world,
    frame,
    lz,
    elevation,
    cacheFixture.cache,
    atmo,
    { maxVisibleTiles: opts.maxVisibleTiles ?? 60 },
  );
  return { ...cacheFixture, terrain, world };
}

describe('Terrain', () => {
  it('requests elevation before imagery for a desired tile', async () => {
    const fixture = makeTerrain(makeCache());

    fixture.terrain.update(cameraAt(0, 4683, 0));
    await settle(fixture.cache);

    const fetched = fixture.fetched;
    expect(fetched.length).toBeGreaterThan(0);
    expect(fetched[0]).toContain('terrarium');

    // The imagery of the same tile is asked for as well, and only after its
    // elevation has been asked for.
    const firstImage = fetched.findIndex((url) => !isElevation(url));
    expect(firstImage).toBeGreaterThan(0);
    expect(fetched.slice(0, firstImage).some((url) => isElevation(url))).toBe(true);
  });

  it('shows a parent until the children are ready', async () => {
    const fixture = makeTerrain(makeCache({ hangImageZoom: 16 }), { maxVisibleTiles: 400 });

    // The first pass asks for everything: the ground is not known yet.
    fixture.terrain.update(cameraAt(0, 4683, 0));
    await settle(fixture.cache);

    // The ground is known now, and the selection settles on it.
    fixture.terrain.update(cameraAt(0, 4683, 0));
    await settle(fixture.cache);

    // The fine tiles were asked for, and never arrived.
    expect(
      fixture.fetched.some((url) => !isElevation(url) && zoomOf(url) === 16),
    ).toBe(true);

    // What is on screen is coarser, and there is something on screen.
    const visible = fixture.terrain.visibleTiles;
    expect(visible.length).toBeGreaterThan(0);
    expect(Math.max(...visible.map((tile) => tile.z))).toBeLessThanOrEqual(15);
  });

  it('rebuilds heights when a finer elevation tile arrives', async () => {
    const spy = vi.spyOn(TerrainTile.prototype, 'rebuildHeights');
    const fixture = makeTerrain(makeCache({ holdElevationZoom: 14 }));

    fixture.terrain.update(cameraAt(0, 4683, 0));
    await settle(fixture.cache);

    // The coarse elevation has arrived, the fine one is still held.
    expect(fixture.fetched.some((url) => isElevation(url) && zoomOf(url) === 12)).toBe(true);
    expect(fixture.fetched.some((url) => isElevation(url) && zoomOf(url) === 14)).toBe(true);

    // And now the fine one comes.
    fixture.releaseElevation();
    await settle(fixture.cache);

    const zooms = spy.mock.calls.map((call) => call[1]);
    expect(zooms).toContain(14);
    spy.mockRestore();
  });

  it('never exceeds maxVisibleTiles built meshes', async () => {
    const fixture = makeTerrain(makeCache(), { maxVisibleTiles: 50 });

    for (let step = 0; step < 10; step++) {
      fixture.terrain.update(cameraAt(step * 10_000, 4683, 0));
      await settle(fixture.cache);
    }

    const stats = fixture.terrain.stats();
    expect(stats.built).toBeLessThanOrEqual(50 + stats.desired);
  });

  it('reports what it is doing', async () => {
    const fixture = makeTerrain(makeCache());

    fixture.terrain.update(cameraAt(0, 4683, 0));
    await settle(fixture.cache);

    const stats = fixture.terrain.stats();
    expect(stats.desired).toBeGreaterThan(0);
    expect(stats.visible).toBeGreaterThan(0);
    expect(stats.built).toBeGreaterThan(0);
    expect(stats.pending).toBe(0);
  });

  it('drapes the tiles over the heights of the ground', async () => {
    const fixture = makeTerrain(makeCache());

    fixture.terrain.update(cameraAt(0, 4683, 0));
    await settle(fixture.cache);

    // The ground around the landing area is 568 m above mean sea level.
    let highest = -Infinity;
    for (const child of fixture.world.children) {
      const mesh = child as Group & {
        geometry: {
          getAttribute(name: string): { count: number; getY(index: number): number };
        };
      };
      const positions = mesh.geometry.getAttribute('position');
      for (let i = 0; i < positions.count; i++) {
        highest = Math.max(highest, positions.getY(i));
      }
    }
    expect(highest).toBeCloseTo(568, 0);
  });

  it('sets tau on the quadtree and anisotropy on the textures', async () => {
    const fixture = makeTerrain(makeCache());

    fixture.terrain.update(cameraAt(0, 4683, 0));
    await settle(fixture.cache);

    fixture.terrain.setTau(2.5);
    expect(fixture.terrain.quadtree.config.tau).toBe(2.5);

    fixture.terrain.setAnisotropy(4);
    expect(fixture.terrain.quadtree.config.tau).toBe(2.5);
  });
});
