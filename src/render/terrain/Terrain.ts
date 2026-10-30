/**
 * Terrain streaming: the requests, the tile lifecycle and the budgets.
 *
 * The quadtree says which tiles the camera wants. This class fetches their
 * elevation and imagery, drapes the meshes over the heights, keeps the ground
 * free of holes and throws the rest away again.
 *
 * Four rules keep the ground on screen:
 *
 * - a tile only splits once it can be drawn itself, so the ground sharpens
 *   one level at a time and every tile that is split has a parent that can
 *   stand in for it;
 * - a leaf that is not ready is covered by its parent, or by the tiles it
 *   was merged from when the parent is not built yet, and nothing finer than
 *   that cover is drawn under it: two drawn tiles never overlap, so a coarse
 *   mesh never floats above the fine ones that cover the same ground;
 * - only the visible tiles render: a mesh that is built but not on screen
 *   draws nothing;
 * - the textures belong to the tile cache: a disposed mesh gives its texture
 *   back, and the cache gives the GPU texture back when it evicts the bitmap.
 */

import * as THREE from 'three';
import { metersPerPixel, parentTile, tileKey } from '../../world/geo';
import type { LocalFrame, TileCoord } from '../../world/geo';
import type { ElevationGrid } from '../../world/ElevationGrid';
import { TileFetchError } from '../../world/TileCache';
import type { TileCache } from '../../world/TileCache';
import { ELEVATION_PROVIDER, imageryProviderForZoom, tileUrl } from '../../world/providers';
import type { Atmosphere } from '../Atmosphere';
import { TerrainTile } from './TerrainTile';
import type { TileBounds } from './TerrainTile';
import { TerrainQuadtree, computeRenderSet } from './TerrainQuadtree';
import type { HeightRange, LodCamera } from './TerrainQuadtree';

/** How the terrain is allowed to look. Every field has a default. */
export interface TerrainOptions {
  /** Texels per screen pixel allowed before a tile is split. */
  tau?: number;
  /** Anisotropic filtering on the imagery. */
  anisotropy?: number;
  /** Imagery textures kept on the GPU at once. */
  maxTextures?: number;
  /** Tiles the terrain shows, and the budget of the selection that feeds it. */
  maxVisibleTiles?: number;
  /** How long a tile may stay out of view before its mesh is disposed. */
  disposeDelayMs?: number;
  /** Meshes built per update, so a burst of tiles does not stall a frame. */
  maxBuildsPerUpdate?: number;
}

/**
 * The default numbers: the budget of a phone.
 *
 * The quality tiers own their own numbers, and the app passes theirs in.
 */
export const DEFAULT_TERRAIN_OPTIONS: Required<TerrainOptions> = {
  tau: 1.8,
  anisotropy: 8,
  maxTextures: 256,
  maxVisibleTiles: 160,
  disposeDelayMs: 2000,
  maxBuildsPerUpdate: 8,
};

/** The height range used while no elevation has arrived, in metres. */
const UNKNOWN_RANGE: HeightRange = { min: 0, max: 5000 };

/** How long a failed tile is left alone before it is asked for again, in ms. */
const RETRY_AFTER_MS = 30_000;

/** The smallest pad on a height range that was sampled from a coarse tile, in metres. */
const MIN_SAMPLED_PAD_M = 100;

/** The share of a coarse pixel's relief that the pad has to cover. */
const SAMPLED_PAD_SHARE = 0.6;

/** Where the ground is sampled inside a tile: the corners and the middle. */
const SAMPLE_STEPS = [0, 0.5, 1];

/**
 * A height range that was sampled from a coarser elevation tile.
 *
 * The covering tile is named so that the range is only reused while the same
 * elevation answers for it.
 */
interface SampledRange {
  /** The tile the range belongs to. */
  coord: TileCoord;

  /** The elevation tile the range was sampled from. */
  coveringKey: string;

  /** The range itself. */
  range: HeightRange;
}

/** The state of one terrain tile. */
interface TileState {
  coord: TileCoord;

  bounds: TileBounds;

  /** The URL of the imagery on the tile. */
  imageryUrl: string;

  /** The mesh, once the tile has been drawn at least once. */
  tile: TerrainTile | null;

  /** When the tile was last in the visible set. */
  lastVisibleAt: number;
}

export class Terrain {
  /** The selection of tiles; its tau is what `setTau` changes. */
  readonly quadtree: TerrainQuadtree;

  /** The tiles that are on screen after the fallbacks are worked out. */
  readonly visibleTiles: TileCoord[] = [];

  private readonly world: THREE.Group;

  private readonly frame: LocalFrame;

  private readonly elevation: ElevationGrid;

  private readonly cache: TileCache;

  private readonly atmo: Atmosphere;

  private readonly options: Required<TerrainOptions>;

  /** The height of the ground at a point, curvature included. */
  private readonly heightAt: (x: number, z: number) => number;

  /** Every tile the terrain knows about, by tile key. */
  private readonly tiles = new Map<string, TileState>();

  /** The requests on their way, by URL. */
  private readonly pending = new Map<string, 'image' | 'heights'>();

  /** The URLs that failed, and when they failed. */
  private readonly failed = new Map<string, number>();

  /** The height range of every elevation tile that has arrived, by tile key. */
  private readonly elevationRanges = new Map<string, HeightRange>();

  /** The height ranges that were sampled from a coarser tile, by tile key. */
  private readonly sampledRanges = new Map<string, SampledRange>();

  /** The imagery textures, by URL. */
  private readonly textures = new Map<string, THREE.Texture>();

  /** When each texture was last used, oldest first: the eviction order. */
  private readonly textureOrder = new Map<string, number>();

  private desiredTiles: TileCoord[] = [];

  /**
   * The tiles that were split on the last update: every proper ancestor of
   * a leaf of the selection, down to the root zoom.
   *
   * A tile that was split stays split while the selection keeps it split, so
   * a parent whose mesh or texture was thrown away after its children took
   * over is not merged back and split again in a loop.
   */
  private interior = new Set<string>();

  /** The camera of the last update: the priority of the requests and the order of the builds. */
  private lastCam: LodCamera | null = null;

  /** The distance from the camera to every desired tile, by tile key. */
  private readonly distances = new Map<string, number>();

  /** The meshes built since the last update: the build budget of the frame. */
  private buildsSinceUpdate = 0;

  constructor(
    world: THREE.Group,
    frame: LocalFrame,
    lz: { x: number; z: number },
    elevation: ElevationGrid,
    cache: TileCache,
    atmo: Atmosphere,
    opts: TerrainOptions = {},
  ) {
    this.world = world;
    this.frame = frame;
    this.elevation = elevation;
    this.cache = cache;
    this.atmo = atmo;
    this.options = {
      tau: opts.tau ?? DEFAULT_TERRAIN_OPTIONS.tau,
      anisotropy: opts.anisotropy ?? DEFAULT_TERRAIN_OPTIONS.anisotropy,
      maxTextures: opts.maxTextures ?? DEFAULT_TERRAIN_OPTIONS.maxTextures,
      maxVisibleTiles: opts.maxVisibleTiles ?? DEFAULT_TERRAIN_OPTIONS.maxVisibleTiles,
      disposeDelayMs: opts.disposeDelayMs ?? DEFAULT_TERRAIN_OPTIONS.disposeDelayMs,
      maxBuildsPerUpdate: opts.maxBuildsPerUpdate ?? DEFAULT_TERRAIN_OPTIONS.maxBuildsPerUpdate,
    };
    this.heightAt = (x, z) => this.elevation.groundY(x, z);

    // Every leaf of the selection can end up on screen, so the selection is
    // bounded by the same budget as the visible tiles.
    this.quadtree = new TerrainQuadtree(frame, lz, {
      tau: this.options.tau,
      maxLeaves: this.options.maxVisibleTiles,
    });

    cache.onEvict = (url: string): void => {
      this.onEvict(url);
    };

    // The grid throws its tiles away when it runs out of room. The terrain
    // has to forget the height range of a tile that is gone, or the ground
    // stays known at a zoom that is no longer there.
    const gridOnEvict = this.elevation.onEvict;
    this.elevation.onEvict = (t: TileCoord): void => {
      this.elevationRanges.delete(tileKey(t));
      gridOnEvict?.(t);
    };
  }

  /**
   * One step of the streaming: ask for what is missing, work out what is on
   * screen, build the meshes of the visible tiles and dispose the rest.
   */
  update(cam: LodCamera): void {
    const now = Date.now();
    this.lastCam = cam;
    this.buildsSinceUpdate = 0;

    // The selection only refines what it can draw: a tile that is not ready
    // yet stays a leaf, and the coarse tile above it keeps the ground. The
    // tiles that were split on the last update stay split, so the selection
    // does not oscillate between two levels.
    this.desiredTiles = this.quadtree.select(
      cam,
      (t) => this.heightRange(t),
      (t) => this.canRefine(t),
    );
    this.updateInterior();

    // The distance to every desired tile: the priority of the requests and
    // the order of the builds.
    this.distances.clear();
    for (const coord of this.desiredTiles) {
      this.distances.set(tileKey(coord), this.distanceTo(cam, coord));
    }

    // The camera has moved on: the imagery of the tiles that are no longer
    // wanted is thrown away before the new requests go out.
    this.cancelUnwantedImagery();

    this.requestMissing(cam, now);
    this.refreshVisible(now);
  }

  /**
   * The tiles that were split on the last update.
   *
   * Every proper ancestor of a leaf of the selection is a tile that was
   * split: it was replaced by its children, and the ground it used to cover
   * is now covered by them.
   */
  private updateInterior(): void {
    const interior = new Set<string>();
    const rootZoom = this.quadtree.config.rootZoom;
    for (const leaf of this.desiredTiles) {
      let ancestor = parentTile(leaf);
      while (ancestor && ancestor.z >= rootZoom) {
        interior.add(tileKey(ancestor));
        ancestor = parentTile(ancestor);
      }
    }
    this.interior = interior;
  }

  /**
   * Whether a tile may be split.
   *
   * A tile is split once its own imagery and the elevation it is draped on
   * have arrived, so its children have it to fall back on. A tile that was
   * already split on the last update stays split while the selection keeps
   * it split, so a parent whose mesh or texture was thrown away after its
   * children took over is not merged back and split again in a loop.
   */
  private canRefine(t: TileCoord): boolean {
    return this.interior.has(tileKey(t)) || (this.isReady(t) && this.elevationReady(t));
  }

  /**
   * Cancel the imagery that is no longer wanted.
   *
   * The wanted set is the imagery of every leaf of the selection and of the
   * ancestors that stand in for them. Anything else that is still on its way
   * is cancelled: the camera has moved on, and the tile would only take a
   * slot in the queue and a texture on the GPU.
   *
   * Only the queued requests can be cancelled; one that is already on the
   * wire is left to arrive, and it is simply not asked for again.
   */
  private cancelUnwantedImagery(): void {
    const wanted = this.wantedImageryUrls();
    for (const [url, kind] of [...this.pending]) {
      if (kind !== 'image') continue;
      if (wanted.has(url)) continue;
      this.cache.cancel(url);
    }
  }

  /** The imagery the current selection wants: its leaves and their ancestors. */
  private wantedImageryUrls(): Set<string> {
    const wanted = new Set<string>();
    const rootZoom = this.quadtree.config.rootZoom;

    // The ancestors are collected first: many leaves share them, and a URL is
    // not cheap to build.
    const ancestors = new Map<string, TileCoord>();
    for (const coord of this.desiredTiles) {
      wanted.add(this.imageryUrlFor(coord));
      let ancestor = parentTile(coord);
      while (ancestor && ancestor.z >= rootZoom) {
        ancestors.set(tileKey(ancestor), ancestor);
        ancestor = parentTile(ancestor);
      }
    }
    for (const ancestor of ancestors.values()) {
      wanted.add(this.imageryUrlFor(ancestor));
    }
    return wanted;
  }

  /**
   * The desired tiles, nearest to the camera first.
   *
   * The requests go out in this order, so the ground under the camera
   * arrives first and is the first to be drawn.
   */
  private nearestFirst(): TileCoord[] {
    return [...this.desiredTiles].sort(
      (a, b) => this.distanceOf(a) - this.distanceOf(b),
    );
  }

  /**
   * The distance from the camera to a tile, in metres.
   *
   * The desired tiles are measured once per update; the ancestors that stand
   * in for them are measured when they are needed.
   */
  private distanceOf(coord: TileCoord): number {
    const known = this.distances.get(tileKey(coord));
    if (known !== undefined) return known;
    const cam = this.lastCam;
    return cam === null ? 0 : this.distanceTo(cam, coord);
  }

  /**
   * Ask for what is missing: the elevation of every desired tile and its
   * imagery.
   *
   * The two are asked for at once. A desired tile is only ever the next
   * level under ground that is already drawn, so its heights and its
   * imagery are both needed now, and asking for both at once costs one
   * round trip per level instead of two.
   *
   * The fallback of a leaf is asked for as well, so a leaf that is not ready
   * has something to stand in for it while its own imagery is on its way.
   */
  private requestMissing(cam: LodCamera, now: number): void {
    const nearest = this.nearestFirst();

    for (const coord of nearest) {
      this.requestElevation(coord, cam, now);
      this.requestImagery(coord, cam, now);
    }

    // The parent of every leaf, so a leaf that is not ready has something to
    // fall back on while its own imagery is still on the way. The leaf itself
    // does not have to be ready: the fallback is exactly for the leaves whose
    // own ground is not known yet.
    for (const coord of nearest) {
      this.requestFallback(coord, cam, now);
    }
  }

  /**
   * Whether the ground under a tile is known finely enough to draw it.
   *
   * The imagery of a tile is draped on an elevation tile that is two zooms
   * coarser, capped at the finest zoom of the elevation: the zoom-12 tile
   * for every tile of zoom 14 and finer, the tile's own zoom below that.
   * Until that tile has arrived the tile is not asked for, because the
   * selection it would be drawn at is not settled yet.
   */
  private elevationReady(coord: TileCoord): boolean {
    return this.elevation.hasTile(this.elevation.elevationTileFor(coord));
  }

  /**
   * Work out what is on screen and build the meshes of those tiles.
   *
   * The meshes to build are the ready leaves of the selection and the tiles
   * that stand in for the leaves that are not ready. The ready leaves come
   * first: they are the ones that take over from their parent, and they are
   * built together so that all four of them are on screen in the same frame.
   *
   * A leaf that has no imagery falls back to the nearest ancestor that has,
   * so the ground is never missing: a tile that is slow or that has failed
   * leaves its parent's texture on screen.
   *
   * Only a few meshes are built per call, the nearest to the camera first,
   * so a hundred tiles that arrive together do not stall a frame. A tile
   * whose mesh is not built yet falls back to its nearest ancestor that has
   * one, exactly as a tile that has not arrived at all does.
   *
   * Only the visible tiles are drawn: a mesh that is built but is not on
   * screen stays in the world, ready to come back, and draws nothing.
   */
  private refreshVisible(now: number): void {
    this.visibleTiles.length = 0;

    // The tiles that have imagery: the ones that can have a mesh.
    const ready = computeRenderSet(this.desiredTiles, (t) => this.isReady(t));

    // The meshes that are missing: the ready leaves first, so that they can
    // take over from their parent in one go, then the tiles that stand in
    // for the leaves that are not ready.
    const missing: TileCoord[] = [];
    const seen = new Set<string>();
    const add = (coord: TileCoord): void => {
      const key = tileKey(coord);
      if (seen.has(key)) return;
      seen.add(key);
      missing.push(coord);
    };
    for (const coord of this.desiredTiles) {
      if (!this.isReady(coord)) continue;
      if (this.hasMesh(coord)) continue;
      add(coord);
    }
    for (const coord of ready) {
      if (this.hasMesh(coord)) continue;
      add(coord);
    }

    const budget = Math.max(0, this.options.maxBuildsPerUpdate - this.buildsSinceUpdate);
    for (const coord of missing
      .sort((a, b) => this.distanceOf(a) - this.distanceOf(b))
      .slice(0, budget)) {
      this.ensureMesh(coord, now);
      this.buildsSinceUpdate++;
    }

    // The tiles that are on screen: the ones that have a mesh. The others
    // fall back to their nearest ancestor that has one.
    for (const coord of computeRenderSet(this.desiredTiles, (t) => this.hasMesh(t))) {
      this.visibleTiles.push(coord);
    }

    // Only the visible tiles draw. A mesh that is out of view stays in the
    // world, so a camera that turns back finds it still there.
    const visible = new Set(this.visibleTiles.map(tileKey));
    for (const [key, state] of this.tiles) {
      if (!state.tile) continue;
      state.tile.mesh.visible = visible.has(key);
    }

    this.enforceBudget(now);
  }

  /**
   * The height range of a tile.
   *
   * A tile whose own elevation tile has arrived has the exact range of that
   * tile. A tile that is still covered by a coarser elevation tile gets the
   * range of the ground under it, sampled from that coarse tile: the coarse
   * tile says nothing about the relief of the small one, and a range that
   * spans the whole coarse tile puts the camera inside the box of every tile
   * below it, which makes the quadtree refine far past what the screen can
   * show.
   *
   * Before any elevation has arrived the range is a guess: from sea level to
   * five thousand metres, which is as good as any until the ground is known.
   */
  heightRange(t: TileCoord): HeightRange {
    const needed = this.elevation.elevationTileFor(t);
    if (this.elevation.hasTile(needed)) {
      const range = this.elevationRanges.get(tileKey(needed));
      if (range) return { min: range.min, max: range.max };
      return { min: UNKNOWN_RANGE.min, max: UNKNOWN_RANGE.max };
    }

    const covering = this.coveringElevation(t);
    if (!covering) return { min: UNKNOWN_RANGE.min, max: UNKNOWN_RANGE.max };
    return this.sampledHeightRange(t, covering);
  }

  /**
   * The height range of a tile that is still covered by a coarser tile.
   *
   * The ground under the tile is sampled from the coarse tile, so the range
   * is the relief of the tile itself and not the relief of the whole coarse
   * tile. The samples are padded by the relief that one coarse pixel can
   * hide, so ground that is a little higher or lower than the samples still
   * fits inside the box.
   *
   * The range is kept until the covering tile changes: the ground under a
   * tile does not change while the same elevation answers for it.
   */
  private sampledHeightRange(t: TileCoord, covering: TileCoord): HeightRange {
    const key = tileKey(t);
    const coveringKey = tileKey(covering);

    const cached = this.sampledRanges.get(key);
    if (cached && cached.coveringKey === coveringKey) return cached.range;

    const bounds = this.frame.tileBoundsLocal(t);
    let min = Infinity;
    let max = -Infinity;
    for (const fz of SAMPLE_STEPS) {
      for (const fx of SAMPLE_STEPS) {
        const x = bounds.minX + (bounds.maxX - bounds.minX) * fx;
        const z = bounds.minZ + (bounds.maxZ - bounds.minZ) * fz;
        const height = this.elevation.sampleLocal(x, z);
        if (height < min) min = height;
        if (height > max) max = height;
      }
    }

    if (!Number.isFinite(min) || !Number.isFinite(max)) {
      return { min: UNKNOWN_RANGE.min, max: UNKNOWN_RANGE.max };
    }

    const pad = this.sampledPad(t, covering);
    const range: HeightRange = { min: min - pad, max: max + pad };
    this.sampledRanges.set(key, { coord: t, coveringKey, range });
    return range;
  }

  /**
   * The pad on a height range that was sampled from a coarse tile.
   *
   * The pad covers the relief that one pixel of the coarse tile can hide, so
   * the box is wide enough for the ground the samples missed.
   */
  private sampledPad(t: TileCoord, covering: TileCoord): number {
    const lat = this.tileCentreLat(t);
    return Math.max(MIN_SAMPLED_PAD_M, SAMPLED_PAD_SHARE * metersPerPixel(lat, covering.z));
  }

  /** The latitude of the middle of a tile, where the ground resolution is measured. */
  private tileCentreLat(t: TileCoord): number {
    const bounds = this.frame.tileBoundsLocal(t);
    return this.frame.toLonLat(
      (bounds.minX + bounds.maxX) / 2,
      (bounds.minZ + bounds.maxZ) / 2,
    ).lat;
  }

  /** What the terrain is doing, for the debug overlay. */
  stats(): { desired: number; visible: number; pending: number; built: number } {
    let built = 0;
    for (const state of this.tiles.values()) {
      if (state.tile) built++;
    }
    return {
      desired: this.desiredTiles.length,
      visible: this.visibleTiles.length,
      pending: this.pending.size,
      built,
    };
  }

  /** How sharp the terrain may be. A smaller tau is sharper and costlier. */
  setTau(tau: number): void {
    this.options.tau = tau;
    this.quadtree.config.tau = tau;
  }

  /**
   * How many tiles the terrain shows at once.
   *
   * The budget of the selection is the same number: every leaf of the
   * selection can end up on screen, so the two are kept in step.
   */
  setMaxVisibleTiles(maxVisibleTiles: number): void {
    this.options.maxVisibleTiles = maxVisibleTiles;
    this.quadtree.config.maxLeaves = maxVisibleTiles;
  }

  /** The anisotropic filtering on the imagery. */
  setAnisotropy(anisotropy: number): void {
    this.options.anisotropy = anisotropy;
    for (const texture of this.textures.values()) {
      texture.anisotropy = anisotropy;
      texture.needsUpdate = true;
    }
  }

  /**
   * How many imagery textures are kept on the GPU at once.
   *
   * A lower budget throws the textures that are not on screen away at once,
   * so the memory of the GPU is freed when the tier steps down.
   */
  setMaxTextures(maxTextures: number): void {
    this.options.maxTextures = maxTextures;
    this.enforceTextureBudget();
  }

  /** Let go of everything: the meshes, the textures and the requests. */
  dispose(): void {
    for (const state of this.tiles.values()) {
      this.disposeMesh(state);
    }
    this.tiles.clear();
    this.visibleTiles.length = 0;
    this.desiredTiles = [];

    for (const url of [...this.pending.keys()]) {
      this.cache.cancel(url);
    }
    this.pending.clear();

    for (const texture of this.textures.values()) {
      texture.dispose();
    }
    this.textures.clear();
    this.textureOrder.clear();
    this.elevationRanges.clear();
    this.sampledRanges.clear();
  }

  /** The URL of the imagery of a tile. */
  private imageryUrlFor(coord: TileCoord): string {
    return tileUrl(imageryProviderForZoom(coord.z), coord);
  }

  /** How far the camera is from a tile, in metres: the request priority. */
  private distanceTo(cam: LodCamera, coord: TileCoord): number {
    return this.quadtree.distanceToTile(cam, coord, this.heightRange(coord));
  }

  /** Ask for the imagery of a tile. */
  private requestImagery(coord: TileCoord, cam: LodCamera, now: number): void {
    const url = this.imageryUrlFor(coord);
    if (this.textures.has(url)) return;
    if (this.pending.has(url)) return;
    const failedAt = this.failed.get(url);
    if (failedAt !== undefined && now - failedAt < RETRY_AFTER_MS) return;

    this.pending.set(url, 'image');
    void this.cache.getImage(url, this.distanceTo(cam, coord)).then(
      (bitmap: ImageBitmap) => {
        this.pending.delete(url);
        this.failed.delete(url);
        this.onImagery(coord, url, bitmap);
      },
      (error: unknown) => {
        this.pending.delete(url);
        // A request that was cancelled is not a failure: the tile was not
        // wanted any more, so there is nothing to warn about and nothing to
        // remember.
        if (isCancelled(error)) return;
        this.failed.set(url, Date.now());
        console.warn(`boogie: no imagery for ${url}`, error);
      },
    );
  }

  /** Ask for the elevation tile a tile needs. */
  private requestElevation(coord: TileCoord, cam: LodCamera, now: number): void {
    const elev = this.elevation.elevationTileFor(coord);

    // The grid is what the terrain knows: a tile that has been thrown away
    // is asked for again, or the ground under it would stay unknown.
    if (this.elevation.hasTile(elev)) return;

    const url = tileUrl(ELEVATION_PROVIDER, elev);
    if (this.pending.has(url)) return;
    const failedAt = this.failed.get(url);
    if (failedAt !== undefined && now - failedAt < RETRY_AFTER_MS) return;

    this.pending.set(url, 'heights');
    void this.cache.getHeights(url, this.distanceTo(cam, elev)).then(
      (heights: Float32Array) => {
        this.pending.delete(url);
        this.failed.delete(url);
        this.onElevation(elev, heights);
      },
      (error: unknown) => {
        this.pending.delete(url);
        this.failed.set(url, Date.now());
        console.warn(`boogie: no elevation for ${url}`, error);
      },
    );
  }

  /**
   * Ask for the imagery that stands in for a leaf that has none.
   *
   * The walk starts at the parent of the leaf and climbs to the root ring of
   * the quadtree: below it there is nothing but the ring itself.
   *
   * The walk does not stop at an ancestor whose ground is not known yet: it
   * asks for that ground and climbs on. The fine ancestors are draped on the
   * finest elevation tile, and that tile takes a while to arrive for the
   * whole view, so a walk that stopped there would never reach the coarse
   * ring and the ground would stay empty until the fine elevation was in.
   * The ring is asked for first and the finer fallbacks follow as the finer
   * elevation arrives.
   *
   * The walk stops at the first ancestor that covers the ground: one whose
   * imagery has arrived or is on its way, and one whose ground is known and
   * whose imagery can be asked for now. An ancestor whose imagery has failed
   * is left alone and the walk goes on to the next one up.
   */
  private requestFallback(leaf: TileCoord, cam: LodCamera, now: number): void {
    const rootZoom = this.quadtree.config.rootZoom;
    let ancestor = parentTile(leaf);
    while (ancestor && ancestor.z >= rootZoom) {
      const url = this.imageryUrlFor(ancestor);
      if (this.textures.has(url)) return;
      if (this.pending.has(url)) return;

      const failedAt = this.failed.get(url);
      if (failedAt !== undefined && now - failedAt < RETRY_AFTER_MS) {
        // The imagery of this ancestor failed: the next one up stands in for
        // it instead.
        ancestor = parentTile(ancestor);
        continue;
      }

      if (!this.elevationReady(ancestor)) {
        // The ground under the ancestor is not known yet: ask for it and
        // keep climbing, so that the coarse ring is asked for as well.
        this.requestElevation(ancestor, cam, now);
        ancestor = parentTile(ancestor);
        continue;
      }

      this.requestImagery(ancestor, cam, now);
      return;
    }
  }

  /** The imagery has arrived: keep the texture and note the tile. */
  private onImagery(coord: TileCoord, url: string, bitmap: ImageBitmap): void {
    this.textureFor(url, bitmap);

    const key = tileKey(coord);
    if (!this.tiles.has(key)) {
      this.tiles.set(key, {
        coord,
        bounds: this.frame.tileBoundsLocal(coord),
        imageryUrl: url,
        tile: null,
        lastVisibleAt: Date.now(),
      });
    }

    // The tile may be the one the camera is waiting for, or the parent that
    // stands in for it: either way the ground changes now.
    this.refreshVisible(Date.now());
  }

  /** The elevation has arrived: keep it and re-drape the tiles it covers. */
  private onElevation(coord: TileCoord, heights: Float32Array): void {
    try {
      this.elevation.addTile(coord, heights);
    } catch (error) {
      console.warn(`boogie: bad elevation tile for ${tileKey(coord)}`, error);
      return;
    }

    let min = Infinity;
    let max = -Infinity;
    for (const height of heights) {
      if (height < min) min = height;
      if (height > max) max = height;
    }
    this.elevationRanges.set(tileKey(coord), { min, max });

    // The ranges that were sampled under this tile are stale now: the ground
    // they describe is known better.
    this.dropSampledRanges(coord);

    // Every tile this elevation covers is draped over it again, unless it is
    // already draped over something finer.
    const bounds = this.frame.tileBoundsLocal(coord);
    for (const state of this.tiles.values()) {
      if (!state.tile) continue;
      if (state.tile.elevZoom >= coord.z) continue;
      if (!overlaps(state.bounds, bounds)) continue;
      state.tile.rebuildHeights(this.heightAt, coord.z);
    }

    // The ground is known now, so the tiles it covers can be asked for: the
    // selection may refine now that it can draw the tiles it splits.
    const cam = this.lastCam;
    if (!cam) return;
    this.requestMissing(cam, Date.now());
  }

  /**
   * Forget the height ranges that were sampled under a tile.
   *
   * The tiles the new elevation covers have their own range now, and the
   * tiles that are still covered by a coarser tile are sampled again: the
   * finer heights may say something different about the ground under them.
   */
  private dropSampledRanges(coord: TileCoord): void {
    const bounds = this.frame.tileBoundsLocal(coord);
    for (const [key, entry] of [...this.sampledRanges]) {
      const tileBounds = this.frame.tileBoundsLocal(entry.coord);
      if (!overlaps(tileBounds, bounds)) continue;
      this.sampledRanges.delete(key);
    }
  }

  /** Build the mesh of a tile, if it has imagery and no mesh yet. */
  private ensureMesh(coord: TileCoord, now: number): void {
    const state = this.tiles.get(tileKey(coord));
    if (!state || state.tile) return;

    const texture = this.textures.get(state.imageryUrl);
    if (!texture) return;

    const tile = new TerrainTile(
      coord,
      state.bounds,
      this.atmo,
      this.heightAt,
      this.coveringElevationZoom(coord),
    );
    tile.setTexture(texture);
    tile.textureZoom = coord.z;

    // A new mesh draws nothing until the selection says it is on screen.
    tile.mesh.visible = false;

    this.world.add(tile.mesh);
    state.tile = tile;
    state.lastVisibleAt = now;
    this.touchTexture(state.imageryUrl);
  }

  /** Let go of the mesh of a tile. The texture belongs to the cache. */
  private disposeMesh(state: TileState): void {
    if (!state.tile) return;
    this.world.remove(state.tile.mesh);
    state.tile.dispose();
    state.tile = null;
  }

  /** The imagery texture of a URL, made once and kept. */
  private textureFor(url: string, bitmap: ImageBitmap): THREE.Texture {
    const existing = this.textures.get(url);
    if (existing) return existing;

    const texture = new THREE.Texture(bitmap);
    texture.flipY = false;
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.generateMipmaps = true;
    texture.minFilter = THREE.LinearMipmapLinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.anisotropy = this.options.anisotropy;
    texture.needsUpdate = true;

    this.textures.set(url, texture);
    this.touchTexture(url);
    this.enforceTextureBudget();
    return texture;
  }

  /** Move a texture to the end of the eviction order. */
  private touchTexture(url: string): void {
    this.textureOrder.delete(url);
    this.textureOrder.set(url, Date.now());
  }

  /** Keep the number of textures on the GPU within the budget. */
  private enforceTextureBudget(): void {
    while (this.textures.size > this.options.maxTextures) {
      const url = this.oldestUnusedTexture();
      if (!url) return;
      this.disposeTexture(url);
    }
  }

  /** The oldest texture that no live mesh is showing. */
  private oldestUnusedTexture(): string | null {
    for (const url of this.textureOrder.keys()) {
      if (!this.textureInUse(url)) return url;
    }
    return null;
  }

  /** Whether a live mesh is showing a texture. */
  private textureInUse(url: string): boolean {
    for (const state of this.tiles.values()) {
      if (state.tile && state.imageryUrl === url) return true;
    }
    return false;
  }

  /** Let go of a texture and of the meshes that were showing it. */
  private disposeTexture(url: string): void {
    const texture = this.textures.get(url);
    if (!texture) return;

    for (const [key, state] of [...this.tiles]) {
      if (state.imageryUrl !== url) continue;
      this.disposeMesh(state);
      this.tiles.delete(key);
    }
    texture.dispose();
    this.textures.delete(url);
    this.textureOrder.delete(url);
  }

  /**
   * The cache has thrown a tile away.
   *
   * A texture that a built mesh is showing stays: three keeps the bitmap
   * alive through the texture, so throwing the bitmap away frees nothing and
   * only costs the mesh its ground. A texture that no mesh uses is freed.
   */
  private onEvict(url: string): void {
    if (this.textureInUse(url)) return;
    this.disposeTexture(url);
  }

  /**
   * Dispose the meshes that fell out of view and keep the number of live
   * meshes within the budget.
   *
   * The visible tiles are never disposed: they are the ground. The others go
   * once they have been out of view for the delay, so a camera that turns back
   * finds them still there; when there are too many of them, the oldest go
   * first.
   */
  private enforceBudget(now: number): void {
    const visible = new Set(this.visibleTiles.map(tileKey));

    for (const [key, state] of [...this.tiles]) {
      if (visible.has(key)) {
        state.lastVisibleAt = now;
        continue;
      }
      if (now - state.lastVisibleAt >= this.options.disposeDelayMs) {
        this.disposeMesh(state);
      }
    }

    const live = [...this.tiles.values()].filter((state) => state.tile !== null);
    const limit = this.options.maxVisibleTiles + visible.size;
    let excess = live.length - limit;
    if (excess <= 0) return;

    const candidates = live
      .filter((state) => !visible.has(tileKey(state.coord)))
      .sort((a, b) => a.lastVisibleAt - b.lastVisibleAt);
    for (const state of candidates) {
      if (excess <= 0) break;
      this.disposeMesh(state);
      excess--;
    }
  }

  /** Whether a tile has imagery and can be drawn. */
  private isReady(coord: TileCoord): boolean {
    const state = this.tiles.get(tileKey(coord));
    return state !== undefined && this.textures.has(state.imageryUrl);
  }

  /** Whether a tile has a mesh of its own on the screen. */
  private hasMesh(coord: TileCoord): boolean {
    const state = this.tiles.get(tileKey(coord));
    return state !== undefined && state.tile !== null;
  }

  /**
   * The elevation tile that covers a tile: the one it needs, or the finest
   * of its ancestors that has arrived.
   */
  private coveringElevation(t: TileCoord): TileCoord | null {
    const needed = this.elevation.elevationTileFor(t);
    if (this.elevation.hasTile(needed)) return needed;

    let x = needed.x;
    let y = needed.y;
    for (let z = needed.z - 1; z >= 0; z--) {
      x = Math.floor(x / 2);
      y = Math.floor(y / 2);
      const ancestor: TileCoord = { z, x, y };
      if (this.elevation.hasTile(ancestor)) return ancestor;
    }
    return null;
  }

  /** The zoom of the elevation a tile is draped over. */
  private coveringElevationZoom(t: TileCoord): number {
    return this.coveringElevation(t)?.z ?? 0;
  }
}

/** Whether two boxes in the local frame overlap. */
function overlaps(a: TileBounds, b: TileBounds): boolean {
  return a.minX <= b.maxX && a.maxX >= b.minX && a.minZ <= b.maxZ && a.maxZ >= b.minZ;
}

/**
 * Whether a tile request was cancelled rather than failed.
 *
 * A cancelled request is one the terrain asked the cache to drop because
 * the tile was not wanted any more. It never reached the network, so it is
 * neither a failure nor a reason to warn.
 */
function isCancelled(error: unknown): boolean {
  return error instanceof TileFetchError && error.status === -1;
}
