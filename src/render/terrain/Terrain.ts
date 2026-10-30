/**
 * Terrain streaming: the requests, the tile lifecycle and the budgets.
 *
 * The quadtree says which tiles the camera wants. This class fetches their
 * elevation and imagery, drapes the meshes over the heights, keeps the ground
 * free of holes and throws the rest away again.
 *
 * Three rules keep the ground on screen:
 *
 * - a tile is only drawn once its imagery has arrived, and a leaf that is not
 *   ready falls back to its nearest ready ancestor, so a slow or missing tile
 *   leaves the parent's texture on screen instead of a hole;
 * - the imagery of the parent is asked for as well, so the fallback is
 *   already there when the fine tile is still on its way;
 * - the textures belong to the tile cache: a disposed mesh gives its texture
 *   back, and the cache gives the GPU texture back when it evicts the bitmap.
 */

import * as THREE from 'three';
import { parentTile, tileKey } from '../../world/geo';
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
 * The high tier's numbers. Task 11 owns the tiers and passes their own.
 */
export const DEFAULT_TERRAIN_OPTIONS: Required<TerrainOptions> = {
  tau: 1.0,
  anisotropy: 8,
  maxTextures: 512,
  maxVisibleTiles: 400,
  disposeDelayMs: 2000,
  maxBuildsPerUpdate: 8,
};

/** The height range used while no elevation has arrived, in metres. */
const UNKNOWN_RANGE: HeightRange = { min: 0, max: 5000 };

/** How long a failed tile is left alone before it is asked for again, in ms. */
const RETRY_AFTER_MS = 30_000;

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

  /** The imagery textures, by URL. */
  private readonly textures = new Map<string, THREE.Texture>();

  /** When each texture was last used, oldest first: the eviction order. */
  private readonly textureOrder = new Map<string, number>();

  private desiredTiles: TileCoord[] = [];

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

    this.desiredTiles = this.quadtree.select(cam, (t) => this.heightRange(t));

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
   * Ask for what is missing: the elevation of every desired tile and, once
   * the ground under a tile is known, its imagery.
   *
   * The imagery of a tile whose ground is not known yet is not asked for:
   * without the heights there is nothing to drape the tile on, and the
   * selection is about to change anyway. The elevation tiles are coarse and
   * few, so the ground is known one round trip later and the imagery can
   * follow. The fallback of such a tile waits as well, for the same reason:
   * the parent is only worth asking for once the ground is there.
   *
   * "Known" means the elevation tile the imagery is draped on, not just any
   * elevation tile that covers it: a coarse tile says nothing about how fine
   * the selection is going to be, and the imagery of a zoom that is about to
   * change is imagery thrown away.
   */
  private requestMissing(cam: LodCamera, now: number): void {
    const nearest = this.nearestFirst();

    for (const coord of nearest) {
      this.requestElevation(coord, cam, now);
      if (!this.elevationReady(coord)) continue;
      this.requestImagery(coord, cam, now);
    }

    // The parent of every leaf, so a leaf that is not ready has something to
    // fall back on while its own imagery is still on the way.
    for (const coord of nearest) {
      if (!this.elevationReady(coord)) continue;
      this.requestFallback(coord, cam, now);
    }
  }

  /**
   * Whether the ground under a tile is known finely enough to draw it.
   *
   * The imagery of a tile is draped on the elevation tile of the same zoom,
   * capped at the finest zoom of the elevation: the zoom-14 tile for every
   * tile of zoom 14 and finer, the tile's own zoom below that. Until that
   * tile has arrived the tile is not asked for, because the selection it
   * would be drawn at is not settled yet.
   */
  private elevationReady(coord: TileCoord): boolean {
    return this.elevation.hasTile(this.elevation.elevationTileFor(coord));
  }

  /**
   * Work out what is on screen and build the meshes of those tiles.
   *
   * A leaf that has no imagery falls back to the nearest ancestor that has,
   * so the ground is never missing: a tile that is slow or that has failed
   * leaves its parent's texture on screen.
   *
   * Only a few meshes are built per call, the nearest to the camera first,
   * so a hundred tiles that arrive together do not stall a frame. A tile
   * whose mesh is not built yet falls back to its nearest ancestor that has
   * one, exactly as a tile that has not arrived at all does.
   */
  private refreshVisible(now: number): void {
    this.visibleTiles.length = 0;

    // The tiles that have imagery: the ones that can have a mesh.
    const ready = computeRenderSet(this.desiredTiles, (t) => this.isReady(t));

    // The meshes that are missing, nearest to the camera first.
    const missing = ready
      .filter((coord) => !this.hasMesh(coord))
      .sort((a, b) => this.distanceOf(a) - this.distanceOf(b));

    const budget = Math.max(0, this.options.maxBuildsPerUpdate - this.buildsSinceUpdate);
    for (const coord of missing.slice(0, budget)) {
      this.ensureMesh(coord, now);
      this.buildsSinceUpdate++;
    }

    // The tiles that are on screen: the ones that have a mesh. The others
    // fall back to their nearest ancestor that has one.
    for (const coord of computeRenderSet(this.desiredTiles, (t) => this.hasMesh(t))) {
      this.visibleTiles.push(coord);
    }

    this.enforceBudget(now);
  }

  /**
   * The height range of a tile, from the elevation tile that covers it.
   *
   * Before any elevation has arrived the range is a guess: from sea level to
   * five thousand metres, which is as good as any until the ground is known.
   */
  heightRange(t: TileCoord): HeightRange {
    const covering = this.coveringElevation(t);
    if (!covering) return { min: UNKNOWN_RANGE.min, max: UNKNOWN_RANGE.max };
    const range = this.elevationRanges.get(tileKey(covering));
    if (!range) return { min: UNKNOWN_RANGE.min, max: UNKNOWN_RANGE.max };
    return { min: range.min, max: range.max };
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
   * The parent is asked for, and only when the parent has failed in turn is
   * the grandparent asked for, so a tile that never arrives walks up the tree
   * one level at a time instead of asking for the whole chain at once. The
   * walk stops at the root ring of the quadtree: below it there is nothing
   * but the ring itself.
   *
   * The elevation of the ancestor is always asked for: it is what tells the
   * terrain how high the ground is under the tile that is still on its way.
   * The imagery of the ancestor waits for that ground: the ancestor is
   * draped on the elevation tile of its own zoom, so the imagery of a
   * fallback waits for the elevation of that zoom and not for any tile that
   * happens to cover it.
   */
  private requestFallback(leaf: TileCoord, cam: LodCamera, now: number): void {
    const rootZoom = this.quadtree.config.rootZoom;
    let ancestor = parentTile(leaf);
    while (ancestor && ancestor.z >= rootZoom) {
      const url = this.imageryUrlFor(ancestor);
      if (this.textures.has(url)) return;
      if (this.pending.has(url)) return;

      const failedAt = this.failed.get(url);
      if (failedAt === undefined || now - failedAt >= RETRY_AFTER_MS) {
        this.requestElevation(ancestor, cam, now);
        if (this.elevationReady(ancestor)) this.requestImagery(ancestor, cam, now);
        return;
      }
      ancestor = parentTile(ancestor);
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

    // Every tile this elevation covers is draped over it again, unless it is
    // already draped over something finer.
    const bounds = this.frame.tileBoundsLocal(coord);
    for (const state of this.tiles.values()) {
      if (!state.tile) continue;
      if (state.tile.elevZoom >= coord.z) continue;
      if (!overlaps(state.bounds, bounds)) continue;
      state.tile.rebuildHeights(this.heightAt, coord.z);
    }

    // The ground is known now, so the imagery of the tiles it covers can be
    // asked for: they were held back while the heights were missing.
    const cam = this.lastCam;
    if (cam) this.requestMissing(cam, Date.now());
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
