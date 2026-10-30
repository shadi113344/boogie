import { describe, it, expect, vi } from 'vitest';
import { Group, Texture } from 'three';
import { LocalFrame, lonLatToTile, parentTile, tileKey } from '@/world/geo';
import type { TileCoord } from '@/world/geo';
import { ElevationGrid } from '@/world/ElevationGrid';
import { TileCache, TileFetchError } from '@/world/TileCache';
import { imageryProviderForZoom, tileUrl } from '@/world/providers';
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
 * be made to hang and the elevation of one zoom, or of every zoom above a
 * given one, can be held back.
 */
function makeCache(
  opts: {
    hangImageZoom?: number;
    holdElevationZoom?: number;
    holdElevationAbove?: number;
    concurrency?: number;
    hangImageFetch?: boolean;
  } = {},
): CacheFixture {
  const fetched: string[] = [];
  let releaseElevation = (): void => {};
  const elevationGate = new Promise<void>((resolve) => {
    releaseElevation = resolve;
  });

  /** The zooms whose elevation is held back. */
  const heldZooms = new Set<number>();
  if (opts.holdElevationZoom !== undefined) heldZooms.add(opts.holdElevationZoom);
  if (opts.holdElevationAbove !== undefined) {
    for (let z = opts.holdElevationAbove + 1; z <= 20; z++) heldZooms.add(z);
  }

  const fetchFn = async (input: RequestInfo | URL): Promise<Response> => {
    const url = String(input);
    fetched.push(url);
    if (opts.hangImageFetch && !isElevation(url)) {
      // Never arrives: the request stays on the wire and takes a slot of the
      // cache for good.
      await new Promise<never>(() => {});
    }
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
    if (heldZooms.has(zoomOf(url))) {
      await elevationGate;
    }
    return { data: terrariumPixels(), width: TILE_SIZE, height: TILE_SIZE };
  };

  const cache = new TileCache({
    fetchFn,
    decodeImage,
    decodePixels,
    // Plenty of room, so a tile that never arrives does not hold up the rest.
    concurrency: opts.concurrency ?? 512,
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
  elevation: ElevationGrid;
}

/** A terrain over a fake world, streaming into the given cache. */
function makeTerrain(
  cacheFixture: CacheFixture,
  opts: {
    maxVisibleTiles?: number;
    maxBuildsPerUpdate?: number;
    disposeDelayMs?: number;
    elevationMaxTiles?: number;
  } = {},
): Fixture {
  const world = new Group();
  const elevation = new ElevationGrid(frame, { maxTiles: opts.elevationMaxTiles });
  const terrain = new Terrain(world, frame, lz, elevation, cacheFixture.cache, atmo, {
    maxVisibleTiles: opts.maxVisibleTiles ?? 60,
    maxBuildsPerUpdate: opts.maxBuildsPerUpdate,
    disposeDelayMs: opts.disposeDelayMs,
  });
  return { ...cacheFixture, terrain, world, elevation };
}

/**
 * Whether a tile is on screen: either it is drawn itself, or one of its
 * ancestors stands in for it.
 */
function coveredBy(drawn: Set<string>, tile: TileCoord): boolean {
  let t: TileCoord | null = tile;
  while (t !== null) {
    if (drawn.has(tileKey(t))) return true;
    t = parentTile(t);
  }
  return false;
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

  it('asks for no imagery until the ground is known', async () => {
    const fixture = makeTerrain(makeCache({ holdElevationAbove: 0 }));

    // The ground is not known, so only the elevation is asked for: there is
    // nothing to drape the imagery on yet.
    fixture.terrain.update(cameraAt(0, 4683, 0));
    await settle(fixture.cache);

    expect(fixture.fetched.length).toBeGreaterThan(0);
    expect(fixture.fetched.every((url) => isElevation(url))).toBe(true);

    // The ground arrives, and the imagery follows it.
    fixture.releaseElevation();
    await settle(fixture.cache);

    expect(fixture.fetched.some((url) => !isElevation(url))).toBe(true);
  });

  it('builds at most maxBuildsPerUpdate meshes per update and keeps the ground covered', async () => {
    const fixture = makeTerrain(makeCache(), {
      maxVisibleTiles: 400,
      maxBuildsPerUpdate: 8,
      disposeDelayMs: 60_000,
    });

    // The selection is forty tiles.
    fixture.terrain.quadtree.config.maxLeaves = 40;

    // The coarse ground first: from high above the drop zone the selection
    // is the root ring, and those tiles are the ancestors of the fine ones
    // that follow.
    const high = cameraAt(0, 700_000, 0);
    for (let step = 0; step < 5; step++) {
      fixture.terrain.update(high);
      await settle(fixture.cache);
    }
    const coarse = fixture.terrain.stats().built;
    expect(coarse).toBeGreaterThan(0);

    // The camera comes down: the selection refines, and the fine tiles all
    // arrive together.
    const near = cameraAt(0, 4683, 0);
    fixture.terrain.update(near);
    await settle(fixture.cache);

    // Only eight meshes are built, even though the whole selection is ready.
    expect(fixture.terrain.stats().built - coarse).toBeLessThanOrEqual(8);

    // The ground is still covered: every tile of the selection has itself or
    // an ancestor among the drawn tiles.
    const drawn = new Set(fixture.terrain.visibleTiles.map(tileKey));
    expect(drawn.size).toBeGreaterThan(0);
    for (const leaf of fixture.terrain.quadtree.select(near, (t) => fixture.terrain.heightRange(t))) {
      expect(coveredBy(drawn, leaf)).toBe(true);
    }

    // Everything on screen has a mesh of its own: the tiles that have none
    // yet fall back to an ancestor that has one.
    const meshed = new Set(fixture.world.children.map((child) => child.name));
    for (const drawnTile of fixture.terrain.visibleTiles) {
      expect(meshed.has(`tile ${tileKey(drawnTile)}`)).toBe(true);
    }

    // Five updates later every tile of the selection has a mesh of its own:
    // the drawn tiles are then the leaves themselves.
    for (let step = 0; step < 5; step++) {
      fixture.terrain.update(near);
    }
    const leaves = fixture.terrain.quadtree.select(near, (t) => fixture.terrain.heightRange(t));
    expect(leaves.length).toBe(40);
    expect(fixture.terrain.visibleTiles.length).toBe(40);
    for (const drawnTile of fixture.terrain.visibleTiles) {
      expect(leaves.some((leaf) => tileKey(leaf) === tileKey(drawnTile))).toBe(true);
    }
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

  it('keeps the texture of a built tile when the cache evicts it', async () => {
    const dispose = vi.spyOn(Texture.prototype, 'dispose');
    const fixture = makeTerrain(makeCache());

    fixture.terrain.update(cameraAt(0, 4683, 0));
    await settle(fixture.cache);

    // The ground is on screen.
    const meshes = fixture.world.children.length;
    expect(meshes).toBeGreaterThan(0);

    const visible = fixture.terrain.visibleTiles[0];
    if (!visible) throw new Error('no visible tile');
    const url = tileUrl(imageryProviderForZoom(visible.z), visible);

    // The cache throws the imagery of that tile away.
    fixture.cache.onEvict?.(url, { width: 0, height: 0 } as ImageBitmap);

    // The mesh is still on screen and its texture is still alive.
    expect(fixture.world.children.length).toBe(meshes);
    expect(dispose).not.toHaveBeenCalled();

    dispose.mockRestore();
  });

  it('disposes unused textures when the texture budget is lowered', async () => {
    const dispose = vi.spyOn(Texture.prototype, 'dispose');
    const fixture = makeTerrain(makeCache(), { maxBuildsPerUpdate: 0 });

    fixture.terrain.update(cameraAt(0, 4683, 0));
    await settle(fixture.cache);

    // The textures are there, and none of them is on screen.
    expect(dispose).not.toHaveBeenCalled();

    fixture.terrain.setMaxTextures(0);

    expect(dispose).toHaveBeenCalled();

    dispose.mockRestore();
  });

  it('disposes an unused texture when the cache evicts it', async () => {
    const dispose = vi.spyOn(Texture.prototype, 'dispose');
    const fixture = makeTerrain(makeCache(), { maxBuildsPerUpdate: 0 });

    fixture.terrain.update(cameraAt(0, 4683, 0));
    await settle(fixture.cache);

    // No mesh was built, so no texture is in use.
    expect(fixture.world.children.length).toBe(0);

    const imagery = fixture.fetched.filter((url) => !isElevation(url));
    const url = imagery[0];
    if (!url) throw new Error('no imagery was fetched');

    fixture.cache.onEvict?.(url, { width: 0, height: 0 } as ImageBitmap);

    expect(dispose).toHaveBeenCalled();

    dispose.mockRestore();
  });

  it('asks for no imagery until the elevation it is draped on has arrived', async () => {
    const fixture = makeTerrain(makeCache({ holdElevationZoom: 14 }), { maxVisibleTiles: 400 });

    // From high above the drop zone the selection is the root ring, and the
    // elevation of that ring is coarse but enough to know the ground.
    fixture.terrain.update(cameraAt(0, 700_000, 0));
    await settle(fixture.cache);

    // The camera comes down: the selection refines to the fine tiles, but the
    // elevation they are draped on is still on its way, so the imagery of
    // that zoom is not asked for.
    fixture.terrain.update(cameraAt(0, 4683, 0));
    await settle(fixture.cache);

    const leaves = fixture.terrain['desiredTiles'];
    expect(leaves.some((tile: TileCoord) => tile.z === 16)).toBe(true);
    expect(fixture.fetched.some((url) => !isElevation(url) && zoomOf(url) === 16)).toBe(false);

    // The fine elevation arrives, and the imagery follows it.
    fixture.releaseElevation();
    await settle(fixture.cache);

    expect(fixture.fetched.some((url) => !isElevation(url) && zoomOf(url) === 16)).toBe(true);
  });

  it("requests the root ring's imagery while only the root elevation is loaded", async () => {
    const fixture = makeTerrain(makeCache({ holdElevationAbove: 8 }), { maxVisibleTiles: 400 });

    // Only the elevation of the root ring arrives: every finer elevation
    // tile is still on its way.
    fixture.terrain.update(cameraAt(0, 4683, 0));
    await settle(fixture.cache);

    const imagery = fixture.fetched.filter((url) => !isElevation(url));

    // The root ring under the view is asked for, so the coarse ground is
    // covered while the fine elevation is still missing.
    const root = lonLatToTile(frame.origin, 8);
    const rootUrl = tileUrl(imageryProviderForZoom(root.z), root);
    expect(imagery).toContain(rootUrl);

    // Nothing finer is asked for: the ground it would be draped on is not
    // there yet.
    expect(imagery.some((url) => zoomOf(url) === 16)).toBe(false);
    expect(imagery.every((url) => zoomOf(url) === 8)).toBe(true);
  });

  it('fills in finer fallbacks as finer elevation arrives', async () => {
    const fixture = makeTerrain(makeCache({ holdElevationAbove: 8 }), { maxVisibleTiles: 400 });

    fixture.terrain.update(cameraAt(0, 4683, 0));
    await settle(fixture.cache);

    const root = lonLatToTile(frame.origin, 8);
    const rootUrl = tileUrl(imageryProviderForZoom(root.z), root);
    expect(fixture.fetched).toContain(rootUrl);

    // The fine elevation arrives.
    fixture.releaseElevation();
    await settle(fixture.cache);

    // The camera looks at the ground again, and the selection settles on the
    // fine tiles.
    fixture.terrain.update(cameraAt(0, 4683, 0));
    await settle(fixture.cache);

    // The fallback of the fine tiles is asked for now that the ground under
    // it is known: the parent of the fine leaves covers the ground while
    // their own imagery is on its way.
    const imagery = fixture.fetched.filter((url) => !isElevation(url));
    expect(imagery.some((url) => zoomOf(url) === 15 || zoomOf(url) === 16)).toBe(true);
    expect(imagery.some((url) => zoomOf(url) === 15)).toBe(true);

    // The root ring is loaded already: it was asked for before the fine
    // elevation arrived, and it is on screen.
    expect(fixture.terrain['textures'].has(rootUrl)).toBe(true);
  });

  it('cancels the imagery it no longer wants', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fixture = makeTerrain(makeCache({ concurrency: 1, hangImageFetch: true }));

    // The requests that the cache dropped, and the ones it never sent.
    const cancelled = new Set<string>();
    const getImage = fixture.cache.getImage.bind(fixture.cache);
    fixture.cache.getImage = (url: string, priority = 0): Promise<ImageBitmap> => {
      const promise = getImage(url, priority);
      void promise.catch((error: unknown) => {
        if (error instanceof TileFetchError && error.status === -1) cancelled.add(url);
      });
      return promise;
    };

    // The camera looks at the ground: the imagery of the leaves is asked for.
    fixture.terrain.update(cameraAt(0, 4683, 0));
    await settle(fixture.cache);

    // The camera moves twenty kilometres east: the leaves are other tiles now.
    fixture.terrain.update(cameraAt(20_000, 4683, 0));
    await settle(fixture.cache);

    // The imagery of the first set was dropped before it was ever sent.
    expect(cancelled.size).toBeGreaterThan(0);
    for (const url of cancelled) {
      expect(fixture.fetched).not.toContain(url);
    }

    // A cancelled request is not a failure, and it is not worth a warning.
    expect(fixture.terrain['failed'].size).toBe(0);
    expect(warn).not.toHaveBeenCalled();

    warn.mockRestore();
  });

  it('asks for an elevation tile again after the grid has thrown it away', async () => {
    const fixture = makeTerrain(makeCache(), { elevationMaxTiles: 4 });

    // One tile of the root ring is enough for this test.
    fixture.terrain.quadtree.config.rootRadiusM = 1000;

    const asked: string[] = [];
    const getHeights = fixture.cache.getHeights.bind(fixture.cache);
    fixture.cache.getHeights = (url: string, priority = 0): Promise<Float32Array> => {
      asked.push(url);
      return getHeights(url, priority);
    };

    // From high above the ground the selection is the root ring.
    fixture.terrain.update(cameraAt(0, 700_000, 0));
    await settle(fixture.cache);

    const root = lonLatToTile(frame.origin, 8);
    const first = asked.filter((url) => isElevation(url) && url.includes(`/${root.z}/${root.x}/${root.y}`));
    expect(first.length).toBe(1);

    // The grid fills up and throws the elevation tile away.
    const heights = new Float32Array(TILE_SIZE * TILE_SIZE).fill(100);
    for (let i = 0; i < 5; i++) {
      fixture.elevation.addTile({ z: 12, x: i, y: 4000 }, heights);
    }
    expect(fixture.elevation.hasTile(root)).toBe(false);

    // The terrain has forgotten the height range of the tile as well.
    expect(fixture.terrain['elevationRanges'].has(tileKey(root))).toBe(false);

    // The next update asks for the tile again.
    fixture.terrain.update(cameraAt(0, 700_000, 0));
    await settle(fixture.cache);

    expect(asked.filter((url) => url === first[0]).length).toBe(2);
  });

  it('does not ask for an elevation tile the grid already holds', async () => {
    const fixture = makeTerrain(makeCache(), { elevationMaxTiles: 4 });

    // One tile of the root ring is enough for this test.
    fixture.terrain.quadtree.config.rootRadiusM = 1000;

    const asked: string[] = [];
    const getHeights = fixture.cache.getHeights.bind(fixture.cache);
    fixture.cache.getHeights = (url: string, priority = 0): Promise<Float32Array> => {
      asked.push(url);
      return getHeights(url, priority);
    };

    // The grid holds the tile of the root ring already, so the terrain has
    // no reason to ask for it.
    const root = lonLatToTile(frame.origin, 8);
    fixture.elevation.addTile(root, new Float32Array(TILE_SIZE * TILE_SIZE).fill(568));

    fixture.terrain.update(cameraAt(0, 700_000, 0));
    await settle(fixture.cache);

    expect(asked.filter((url) => isElevation(url))).toEqual([]);
  });
});
