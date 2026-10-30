import { describe, it, expect, vi } from 'vitest';
import { Group, Texture } from 'three';
import { LocalFrame, lonLatToTile, metersPerPixel, parentTile, tileKey } from '@/world/geo';
import type { TileCoord } from '@/world/geo';
import { ElevationGrid } from '@/world/ElevationGrid';
import { TileCache, TileFetchError } from '@/world/TileCache';
import { ELEVATION_PROVIDER, imageryProviderForZoom, tileUrl } from '@/world/providers';
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

/** The coarse tile of the zoom-8 ring that holds the landing area. */
const coarseTile = lonLatToTile(frame.origin, 8);

/** The heights of the coarse tile: 500 m at its north edge, 4,500 m at its south edge. */
const RAMP_NORTH_M = 500;
const RAMP_SOUTH_M = 4500;

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

/** The tile of an elevation URL, or null when the URL is not one. */
function elevationTileOf(url: string): TileCoord | null {
  const match = url.match(/\/terrarium\/(\d+)\/(\d+)\/(\d+)\.png/);
  if (!match) return null;
  return { z: Number(match[1]), x: Number(match[2]), y: Number(match[3]) };
}

/** The tile of an imagery URL, or null when the URL is not one. */
function imageryTileOf(url: string): TileCoord | null {
  const match = url.match(/\/(?:tile|g)\/(\d+)\/(\d+)\/(\d+)(?:\.jpg)?$/);
  if (!match) return null;
  // Both imagery providers put the row before the column.
  return { z: Number(match[1]), y: Number(match[2]), x: Number(match[3]) };
}

/** Whether two tiles are the same one. */
function sameTile(a: TileCoord, b: TileCoord): boolean {
  return a.z === b.z && a.x === b.x && a.y === b.y;
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

/**
 * A tile of heights that ramp from the north edge to the south edge, in the
 * Terrarium encoding.
 */
function terrariumRampPixels(northM: number, southM: number): Uint8ClampedArray {
  const data = new Uint8ClampedArray(TILE_SIZE * TILE_SIZE * 4);
  for (let y = 0; y < TILE_SIZE; y++) {
    const height = Math.round(northM + ((southM - northM) * y) / (TILE_SIZE - 1));
    const value = height + 32768;
    const red = Math.floor(value / 256);
    const green = value - red * 256;
    for (let x = 0; x < TILE_SIZE; x++) {
      const i = (y * TILE_SIZE + x) * 4;
      data[i] = red;
      data[i + 1] = green;
      data[i + 2] = 0;
      data[i + 3] = 255;
    }
  }
  return data;
}

/** The height of the ramp at a point of the local frame, in metres. */
function rampHeightAt(z: number): number {
  const bounds = frame.tileBoundsLocal(coarseTile);
  const share = (z - bounds.minZ) / (bounds.maxZ - bounds.minZ);
  return RAMP_NORTH_M + (RAMP_SOUTH_M - RAMP_NORTH_M) * share;
}

/** The pad the terrain puts on a height range sampled from the coarse tile. */
function sampledPad(tile: TileCoord): number {
  const bounds = frame.tileBoundsLocal(tile);
  const lat = frame.toLonLat(
    (bounds.minX + bounds.maxX) / 2,
    (bounds.minZ + bounds.maxZ) / 2,
  ).lat;
  return Math.max(100, 0.6 * metersPerPixel(lat, coarseTile.z));
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
    /**
     * The one elevation tile that arrives: it ramps from `northM` at its
     * north edge to `southM` at its south edge. Every other elevation tile
     * is held back, so only the coarse ground is known.
     */
    elevationRamp?: { tile: TileCoord; northM: number; southM: number };
    /**
     * The elevation tiles come in one at a time, in the order they were
     * asked for: the network is slow and the tiles arrive one by one.
     */
    elevationInOrder?: boolean;
    /**
     * The imagery of the tiles the predicate picks arrives late, by this
     * many milliseconds: the network is slow for some of them.
     */
    lateImageMs?: number;
    /** The tiles whose imagery arrives late. */
    lateImage?: (t: TileCoord) => boolean;
  } = {},
): CacheFixture {
  const fetched: string[] = [];
  let releaseElevation = (): void => {};
  const elevationGate = new Promise<void>((resolve) => {
    releaseElevation = resolve;
  });

  /** The turn of every elevation tile: the next one waits for this one. */
  let elevationTurn: Promise<void> = Promise.resolve();

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
    if (opts.lateImageMs !== undefined && opts.lateImage) {
      const tile = imageryTileOf(url);
      if (tile && opts.lateImage(tile)) {
        // Arrives late: the ground is coarse for a little while.
        await new Promise<void>((resolve) => setTimeout(resolve, opts.lateImageMs));
      }
    }
    return { width: TILE_SIZE, height: TILE_SIZE } as ImageBitmap;
  };

  const decodePixels = async (
    blob: Blob,
  ): Promise<{ data: Uint8ClampedArray; width: number; height: number }> => {
    const url = await blob.text();
    if (opts.elevationInOrder && isElevation(url)) {
      // One tile at a time, in the order the tiles were asked for.
      const turn = elevationTurn;
      let done = (): void => {};
      elevationTurn = new Promise<void>((resolve) => {
        done = resolve;
      });
      await turn;
      await new Promise<void>((resolve) => setTimeout(resolve, 1));
      done();
    }
    const ramp = opts.elevationRamp;
    if (ramp) {
      const tile = elevationTileOf(url);
      if (!tile || !sameTile(tile, ramp.tile)) {
        // Only the coarse tile arrives: the finer ground is still on its way.
        await elevationGate;
      }
      return {
        data: terrariumRampPixels(ramp.northM, ramp.southM),
        width: TILE_SIZE,
        height: TILE_SIZE,
      };
    }
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
async function settle(cache: TileCache, ticks = 40): Promise<void> {
  for (let i = 0; i < ticks; i++) {
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

/**
 * Update and let the requests run, again and again.
 *
 * The terrain refines top down: a tile is only split once it can be drawn
 * itself, so the selection needs one round trip per zoom level. A test that
 * expects a settled, deep selection has to stream, not update once.
 *
 * The wait between the updates is short: a tile that is on its way arrives
 * within a few ticks, and the requests that hang never arrive anyway.
 */
async function stream(fixture: Fixture, cam: LodCamera, updates = 40): Promise<void> {
  for (let step = 0; step < updates; step++) {
    fixture.terrain.update(cam);
    await settle(fixture.cache, 4);
  }
}

/** A terrain over a fake world, streaming into the given cache. */
function makeTerrain(
  cacheFixture: CacheFixture,
  opts: {
    maxVisibleTiles?: number;
    maxTextures?: number;
    maxBuildsPerUpdate?: number;
    disposeDelayMs?: number;
    elevationMaxTiles?: number;
    tau?: number;
  } = {},
): Fixture {
  const world = new Group();
  const elevation = new ElevationGrid(frame, { maxTiles: opts.elevationMaxTiles });
  const terrain = new Terrain(world, frame, lz, elevation, cacheFixture.cache, atmo, {
    maxVisibleTiles: opts.maxVisibleTiles ?? 60,
    maxTextures: opts.maxTextures,
    maxBuildsPerUpdate: opts.maxBuildsPerUpdate,
    disposeDelayMs: opts.disposeDelayMs,
    tau: opts.tau,
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
    const fixture = makeTerrain(makeCache({ hangImageZoom: 15 }), { maxVisibleTiles: 400 });

    // The selection refines top down, so it takes a round trip per level to
    // get to the fine tiles.
    await stream(fixture, cameraAt(0, 4683, 0));

    // The fine tiles were asked for, and never arrived.
    expect(
      fixture.fetched.some((url) => !isElevation(url) && zoomOf(url) === 15),
    ).toBe(true);

    // What is on screen is coarser, and there is something on screen.
    const visible = fixture.terrain.visibleTiles;
    expect(visible.length).toBeGreaterThan(0);
    expect(Math.max(...visible.map((tile) => tile.z))).toBeLessThanOrEqual(14);
  });

  it('rebuilds heights when a finer elevation tile arrives', async () => {
    const spy = vi.spyOn(TerrainTile.prototype, 'rebuildHeights');
    // The elevation is two zooms coarser than the imagery, so the finest
    // elevation there is: the zoom-12 tile the fine tiles are draped on.
    const fixture = makeTerrain(makeCache({ holdElevationZoom: 12 }), {
      maxVisibleTiles: 400,
      // Every tile of the selection is meshed in one go, so the ground under
      // the camera is draped on the elevation that arrives.
      maxBuildsPerUpdate: 200,
    });

    // The selection refines top down, and the zoom-12 elevation is the one
    // the zoom-14 tiles are draped on.
    await stream(fixture, cameraAt(0, 4683, 0));

    // The coarse elevation has arrived, the fine one is still held.
    expect(fixture.fetched.some((url) => isElevation(url) && zoomOf(url) === 5)).toBe(true);
    expect(fixture.fetched.some((url) => isElevation(url) && zoomOf(url) === 12)).toBe(true);

    // The selection refines top down, and a tile is only split once the
    // elevation it is draped on has arrived: the zoom-14 tiles are draped on
    // the zoom-12 elevation, so the selection stops there.
    const leaves = fixture.terrain['desiredTiles'];
    expect(Math.max(...leaves.map((tile: TileCoord) => tile.z))).toBe(14);

    // And now the fine one comes.
    fixture.releaseElevation();
    await settle(fixture.cache);

    const zooms = spy.mock.calls.map((call) => call[1]);
    expect(zooms).toContain(12);
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
    // Every tile of the selection is meshed in one go: the ground under the
    // camera is one of them, and it is the one that shows the height.
    const fixture = makeTerrain(makeCache(), { maxBuildsPerUpdate: 200 });

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

  it('asks for the root ring\'s imagery and elevation together on a cold start', async () => {
    const fixture = makeTerrain(makeCache({ holdElevationAbove: 0 }));

    // Nothing is known about the ground yet: the selection is the root ring,
    // and the imagery of the ring and the elevation it is draped on are
    // asked for together.
    fixture.terrain.update(cameraAt(0, 4683, 0));
    await settle(fixture.cache);

    const imagery = new Set<string>();
    const elevation = new Set<string>();
    for (const root of fixture.terrain.quadtree.rootTiles()) {
      imagery.add(tileUrl(imageryProviderForZoom(root.z), root));
      elevation.add(tileUrl(ELEVATION_PROVIDER, fixture.elevation.elevationTileFor(root)));
    }

    expect(fixture.fetched.length).toBeGreaterThan(0);
    expect(fixture.fetched.every((url) => imagery.has(url) || elevation.has(url))).toBe(true);
    expect(fixture.fetched.some((url) => imagery.has(url))).toBe(true);
    expect(fixture.fetched.some((url) => elevation.has(url))).toBe(true);
  });

  it('builds at most maxBuildsPerUpdate meshes per update and keeps the ground covered', async () => {
    const fixture = makeTerrain(makeCache(), {
      maxVisibleTiles: 400,
      maxBuildsPerUpdate: 8,
      disposeDelayMs: 60_000,
    });

    // The selection is thirty-nine tiles: a split takes one leaf and gives
    // four, so the budget of forty leaves thirty-nine.
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
    for (const leaf of fixture.terrain['desiredTiles'] as TileCoord[]) {
      expect(coveredBy(drawn, leaf)).toBe(true);
    }

    // Everything on screen has a mesh of its own: the tiles that have none
    // yet fall back to an ancestor that has one.
    const meshed = new Set(fixture.world.children.map((child) => child.name));
    for (const drawnTile of fixture.terrain.visibleTiles) {
      expect(meshed.has(`tile ${tileKey(drawnTile)}`)).toBe(true);
    }

    // Once the selection has settled, every tile of it has a mesh of its
    // own: the drawn tiles are then the leaves themselves.
    await stream(fixture, near);
    const leaves = fixture.terrain.quadtree.select(near, (t) => fixture.terrain.heightRange(t));
    expect(leaves.length).toBe(39);
    expect(fixture.terrain.visibleTiles.length).toBe(39);
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

  it('sets the number of visible tiles on the quadtree', async () => {
    const fixture = makeTerrain(makeCache());

    fixture.terrain.update(cameraAt(0, 4683, 0));
    await settle(fixture.cache);

    fixture.terrain.setMaxVisibleTiles(96);
    expect(fixture.terrain.quadtree.config.maxLeaves).toBe(96);
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

  it("requests the root ring's imagery while only the root elevation is loaded", async () => {
    // The root ring is at zoom 7, and its elevation is two zooms coarser:
    // everything finer than zoom 5 is held back.
    const fixture = makeTerrain(makeCache({ holdElevationAbove: 5 }), { maxVisibleTiles: 400 });

    // Only the elevation of the root ring arrives: every finer elevation
    // tile is still on its way.
    fixture.terrain.update(cameraAt(0, 4683, 0));
    await settle(fixture.cache);

    const imagery = fixture.fetched.filter((url) => !isElevation(url));

    // The root ring under the view is asked for, so the coarse ground is
    // covered while the fine elevation is still missing.
    const root = lonLatToTile(frame.origin, 7);
    const rootUrl = tileUrl(imageryProviderForZoom(root.z), root);
    expect(imagery).toContain(rootUrl);

    // Nothing finer is asked for: the ground it would be draped on is not
    // there yet.
    expect(imagery.some((url) => zoomOf(url) === 16)).toBe(false);
    expect(imagery.every((url) => zoomOf(url) === 7)).toBe(true);
  });

  it('fills in finer fallbacks as finer elevation arrives', async () => {
    const fixture = makeTerrain(makeCache({ holdElevationAbove: 8 }), { maxVisibleTiles: 400 });

    // The elevation finer than zoom 8 is held back: a tile is only split
    // once the elevation it is draped on has arrived, and the zoom-12 tiles
    // are draped on the zoom-10 elevation.
    await stream(fixture, cameraAt(0, 4683, 0));

    const leaves = fixture.terrain['desiredTiles'] as TileCoord[];
    const deep = Math.max(...leaves.map((tile) => tile.z));
    expect(deep).toBeLessThanOrEqual(11);

    // The fallback of the fine tiles is asked for: the parent of the fine
    // leaves covers the ground while their own imagery is on its way.
    const imagery = fixture.fetched.filter((url) => !isElevation(url));
    expect(imagery.some((url) => zoomOf(url) === 10 || zoomOf(url) === 11)).toBe(true);

    // The fine elevation arrives.
    fixture.releaseElevation();
    await settle(fixture.cache);

    // The camera looks at the ground again, and the selection settles on the
    // fine tiles.
    await stream(fixture, cameraAt(0, 4683, 0));

    const deeper = Math.max(
      ...(fixture.terrain['desiredTiles'] as TileCoord[]).map((tile) => tile.z),
    );
    expect(deeper).toBeGreaterThan(deep);

    // The root ring is loaded already: it was asked for before the fine
    // elevation arrived, and it is on screen.
    const root = lonLatToTile(frame.origin, 8);
    const rootUrl = tileUrl(imageryProviderForZoom(root.z), root);
    expect(fixture.terrain['textures'].has(rootUrl)).toBe(true);
  });

  it('cancels the imagery it no longer wants', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // The imagery of the zoom-8 tiles never arrives, so the selection
    // settles on them and the queue fills up with the ones behind them.
    const fixture = makeTerrain(makeCache({ concurrency: 1, hangImageZoom: 8 }), {
      maxVisibleTiles: 400,
    });

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
    await stream(fixture, cameraAt(0, 4683, 0), 20);

    // The camera moves two hundred kilometres east, out of the tile it was
    // looking at: the leaves are other tiles now.
    fixture.terrain.update(cameraAt(200_000, 4683, 0));
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

    // The ring is draped on an elevation tile that is two zooms coarser.
    const root = lonLatToTile(frame.origin, 7);
    const elevationTile = fixture.elevation.elevationTileFor(root);
    const first = asked.filter(
      (url) =>
        isElevation(url) && url.includes(`/${elevationTile.z}/${elevationTile.x}/${elevationTile.y}`),
    );
    expect(first.length).toBe(1);

    // The grid fills up and throws the elevation tile away.
    const heights = new Float32Array(TILE_SIZE * TILE_SIZE).fill(100);
    for (let i = 0; i < 5; i++) {
      fixture.elevation.addTile({ z: 12, x: i, y: 4000 }, heights);
    }
    expect(fixture.elevation.hasTile(elevationTile)).toBe(false);

    // The terrain has forgotten the height range of the tile as well.
    expect(fixture.terrain['elevationRanges'].has(tileKey(elevationTile))).toBe(false);

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
    // no reason to ask for it. The ring is draped on an elevation tile that
    // is two zooms coarser.
    const root = lonLatToTile(frame.origin, 7);
    fixture.elevation.addTile(
      fixture.elevation.elevationTileFor(root),
      new Float32Array(TILE_SIZE * TILE_SIZE).fill(568),
    );

    fixture.terrain.update(cameraAt(0, 700_000, 0));
    await settle(fixture.cache);

    expect(asked.filter((url) => isElevation(url))).toEqual([]);
  });

  it('height range from a coarse tile follows the local ground', async () => {
    const fixture = makeTerrain(
      makeCache({
        elevationRamp: { tile: coarseTile, northM: RAMP_NORTH_M, southM: RAMP_SOUTH_M },
      }),
    );

    // The ring is one tile, and it is draped on the ramp: the ramp is two
    // zooms coarser than the ring it covers.
    fixture.terrain.quadtree.config.rootZoom = 10;
    fixture.terrain.quadtree.config.rootRadiusM = 1000;

    fixture.terrain.update(cameraAt(0, 4683, 0));
    await settle(fixture.cache);

    // The coarse ground has arrived and nothing finer has.
    expect(fixture.elevation.hasTile(coarseTile)).toBe(true);
    expect(fixture.elevation.tileCount()).toBe(1);

    // A tile in the northern quarter of the coarse tile, where the ramp is
    // low: its ground is known, even though its own elevation has not come.
    const fine: TileCoord = { z: 14, x: coarseTile.x * 64 + 32, y: coarseTile.y * 64 + 8 };
    expect(fixture.elevation.hasTile(fixture.elevation.elevationTileFor(fine))).toBe(false);

    const range = fixture.terrain.heightRange(fine);
    const pad = sampledPad(fine);
    const fineBounds = frame.tileBoundsLocal(fine);
    const local = rampHeightAt((fineBounds.minZ + fineBounds.maxZ) / 2);

    // The range is the relief of the tile, not the relief of the coarse tile.
    expect(range.max - range.min).toBeLessThan(700);
    expect(range.min).toBeGreaterThan(RAMP_NORTH_M);
    expect(range.max).toBeLessThan(RAMP_SOUTH_M);

    // And it is centred on the ground that is really under the tile.
    expect(Math.abs(range.min - local)).toBeLessThan(100 + pad);
  });

  it('the first selection does not over-refine while only coarse elevation is loaded', async () => {
    const fixture = makeTerrain(
      makeCache({
        elevationRamp: { tile: coarseTile, northM: RAMP_NORTH_M, southM: RAMP_SOUTH_M },
      }),
      // The phone runs at the medium tier, where the ground is allowed to be
      // a little coarser than on the high tier.
      { maxVisibleTiles: 400, tau: 1.4 },
    );

    // The first pass asks for the ground; the coarse tile is the only one
    // that arrives.
    fixture.terrain.update(cameraAt(0, 4683, 0));
    await settle(fixture.cache);

    // The selection settles on the coarse ground, and it does not refine
    // past what the screen can show.
    fixture.terrain.update(cameraAt(0, 4683, 0));

    const desired = fixture.terrain['desiredTiles'] as TileCoord[];
    expect(desired.length).toBeGreaterThan(0);
    expect(Math.max(...desired.map((tile) => tile.z))).toBeLessThanOrEqual(16);
    expect(fixture.terrain.stats().desired).toBeLessThan(400);
  });

  it('elevation requests stay bounded on a cold start', async () => {
    const fixture = makeTerrain(
      makeCache({ hangImageFetch: true, elevationInOrder: true }),
      { maxVisibleTiles: 400 },
    );

    // The ground keeps arriving while the imagery hangs: the elevation grid
    // must not fill up with the transient leaves of the settling selection.
    let held = 0;
    for (let step = 0; step < 20; step++) {
      fixture.terrain.update(cameraAt(0, 4683, 0));
      await new Promise((resolve) => setTimeout(resolve, 1));
      held = Math.max(held, fixture.elevation.tileCount());
    }

    expect(held).toBeLessThanOrEqual(96);
  });

  it('asks only for the root ring before any elevation has arrived', async () => {
    const fixture = makeTerrain(
      makeCache({ hangImageFetch: true, holdElevationAbove: 0 }),
      { maxVisibleTiles: 400 },
    );

    // Nothing is known about the ground yet: the first update must not refine
    // the near field blind and ask for the elevation of hundreds of leaves.
    fixture.terrain.update(cameraAt(0, 4683, 0));
    await new Promise((resolve) => setTimeout(resolve, 1));

    const roots = fixture.terrain.quadtree.rootTiles().length;
    expect(fixture.terrain.stats().desired).toBe(roots);

    // Every URL that was fetched belongs to a root tile: its imagery, or the
    // elevation it is draped on.
    const imagery = new Set<string>();
    const elevation = new Set<string>();
    for (const root of fixture.terrain.quadtree.rootTiles()) {
      imagery.add(tileUrl(imageryProviderForZoom(root.z), root));
      elevation.add(tileUrl(ELEVATION_PROVIDER, fixture.elevation.elevationTileFor(root)));
    }
    expect(fixture.fetched.length).toBeGreaterThan(0);
    expect(fixture.fetched.every((url) => imagery.has(url) || elevation.has(url))).toBe(true);
  });

  it('never renders a tile over one of its ancestors while it streams', async () => {
    // Half of the imagery arrives late: the ground is coarse for a while and
    // the fine tiles come in behind the coarse ones.
    const fixture = makeTerrain(
      makeCache({ lateImageMs: 5, lateImage: (t) => t.y % 2 === 1 }),
      // The budget of the selection has to leave room for the ground to
      // sharpen to the zoom the test looks for.
      { maxVisibleTiles: 200, maxBuildsPerUpdate: 1000 },
    );

    // Sixty degrees down from exit altitude.
    const cam: LodCamera = {
      x: 0,
      y: 568 + 4115,
      z: 0,
      focalPx: 1462,
      dir: { x: 0, y: -0.866, z: -0.5 },
      halfAngleRad: 0.6,
    };

    for (let step = 0; step < 150; step++) {
      fixture.terrain.update(cam);
      await new Promise((resolve) => setTimeout(resolve, 1));

      const visible = fixture.terrain.visibleTiles;
      const drawn = new Set(visible.map(tileKey));

      // No tile is drawn together with one of its ancestors.
      for (const tile of visible) {
        let ancestor = parentTile(tile);
        while (ancestor !== null) {
          expect(drawn.has(tileKey(ancestor))).toBe(false);
          ancestor = parentTile(ancestor);
        }
      }

      // And only the visible tiles draw.
      const drawnMeshes = fixture.world.children.filter((child) => child.visible).length;
      expect(drawnMeshes).toBe(visible.length);
    }

    // The ground has sharpened all the way.
    expect(Math.max(...fixture.terrain.visibleTiles.map((t) => t.z))).toBeGreaterThanOrEqual(14);
    // 150 real-timer waits: on Windows each 1 ms wait lasts about 16 ms.
  }, 30_000);

  it('never selects below a tile it cannot draw', async () => {
    // The imagery of the zoom-10 tiles never arrives, so they are never
    // split: the selection cannot go below them.
    const fixture = makeTerrain(makeCache({ hangImageZoom: 10 }), { maxVisibleTiles: 400 });

    await stream(fixture, cameraAt(0, 4683, 0));

    const desired = fixture.terrain['desiredTiles'] as TileCoord[];
    expect(Math.max(...desired.map((tile) => tile.z))).toBe(10);
    expect(Math.max(...fixture.terrain.visibleTiles.map((tile) => tile.z))).toBe(9);
  });

  it('keeps a split tile split after its texture is thrown away', async () => {
    // The texture budget is small enough that the textures of the tiles
    // that stand in for the leaves are thrown away.
    const fixture = makeTerrain(makeCache(), {
      maxVisibleTiles: 60,
      maxTextures: 70,
      disposeDelayMs: 0,
    });

    const cam = cameraAt(0, 4683, 0);
    await stream(fixture, cam);

    const before = (fixture.terrain['desiredTiles'] as TileCoord[]).map(tileKey).sort();
    expect(before.length).toBeGreaterThan(0);
    // The selection has settled deep: the ground is sharp.
    expect(
      Math.max(...(fixture.terrain['desiredTiles'] as TileCoord[]).map((t) => t.z)),
    ).toBeGreaterThanOrEqual(13);

    // Five more rounds do not change the selection: a parent whose texture
    // was thrown away is not merged back into its parent and split again.
    for (let step = 0; step < 5; step++) {
      fixture.terrain.update(cam);
      await settle(fixture.cache);
      const now = (fixture.terrain['desiredTiles'] as TileCoord[]).map(tileKey).sort();
      expect(now).toEqual(before);
    }
  });
});
