/**
 * Loaded elevation tiles and bilinear ground sampling.
 *
 * The grid keeps decoded height tiles in memory, keyed by tile, and answers
 * height queries by sampling the finest tile that is loaded at the point.
 * Heights are metres above mean sea level. The tiles are held in the order
 * they were last used, and the ones that have been out of the way the
 * longest are thrown away when the grid runs out of room, so a long flight
 * cannot fill the phone with heights it will never look at again.
 *
 * This module imports nothing from three.js or the DOM.
 */

import { curvatureDrop, lonLatToMercator, tileBoundsMercator, tileKey, EARTH_RADIUS } from './geo';
import type { LocalFrame, LonLat, TileCoord } from './geo';
import { TERRARIUM_TILE_SIZE } from './terrarium';

/** Default zoom of the elevation tiles: ~26 m per pixel at Interlaken. */
const DEFAULT_MAX_ZOOM = 12;

/**
 * Default number of height tiles kept in memory.
 *
 * A tile is 256 KB of floats, so this is about 16 MB: enough for the ground
 * around the drop zone, little enough to keep the phone happy.
 */
const DEFAULT_MAX_TILES = 64;

/** Edge length of a tile in pixels; row 0 is the north edge. */
const TILE = TERRARIUM_TILE_SIZE;

/** Half the circumference of the projected world, in metres. */
const HALF_WORLD = Math.PI * EARTH_RADIUS;

/** A point in the Mercator plane, in metres. */
interface MercatorPoint {
  x: number;
  y: number;
}

/** A box in the Mercator plane, in metres. */
interface MercatorBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** One loaded height tile and the tile it belongs to. */
interface ElevationTile {
  coord: TileCoord;
  heights: Float32Array;
}

/** How the grid is allowed to look. Every field has a default. */
export interface ElevationGridOptions {
  /** Finest zoom of the elevation tiles. Default 12. */
  maxZoom?: number;
  /** Height tiles kept in memory; the least recently used one is thrown away. Default 64. */
  maxTiles?: number;
  /** Called with every tile that is thrown away. */
  onEvict?: (t: TileCoord) => void;
}

export class ElevationGrid {
  readonly maxZoom: number;

  /**
   * Called with every tile that is thrown away.
   *
   * The caller needs to know: a tile that is gone is not in the grid any
   * more, so whatever it knew about it is stale.
   */
  onEvict?: (t: TileCoord) => void;

  private readonly frame: LocalFrame;

  /** The height tiles in memory, oldest first: the eviction order. */
  private readonly tiles = new Map<string, ElevationTile>();

  /** How many height tiles are kept in memory. */
  private readonly maxTiles: number;

  /** The tile that answered the last sample. */
  private lastTile: TileCoord | null = null;

  /** The Mercator bounds of `lastTile`. */
  private lastBounds: MercatorBounds | null = null;

  /** The zoom of the finest tile in the grid, -1 while it is empty. */
  private finestZoom = -1;

  constructor(frame: LocalFrame, opts?: ElevationGridOptions) {
    this.frame = frame;
    this.maxZoom = opts?.maxZoom ?? DEFAULT_MAX_ZOOM;
    this.maxTiles = Math.max(1, opts?.maxTiles ?? DEFAULT_MAX_TILES);
    this.onEvict = opts?.onEvict;
  }

  /** Store the heights of one tile; row 0 is the north edge. */
  addTile(t: TileCoord, heights: Float32Array): void {
    const expected = TILE * TILE;
    if (heights.length !== expected) {
      throw new RangeError(`elevation tile ${tileKey(t)} must hold ${expected} heights, got ${heights.length}`);
    }
    const key = tileKey(t);
    // The tile is stored at the end of the order: it is the most recently
    // used one now.
    this.tiles.delete(key);
    this.tiles.set(key, { coord: t, heights });
    if (t.z > this.finestZoom && t.z <= this.maxZoom) this.finestZoom = t.z;

    // A tile that has just arrived may cover the point of the last sample
    // more finely, so the remembered tile is dropped.
    this.lastTile = null;
    this.lastBounds = null;

    this.enforceBudget();
  }

  /**
   * Keep the number of height tiles within the budget.
   *
   * The least recently used tile goes first: it is the one that has been
   * out of the way the longest, so it is the one the ground is least likely
   * to need again. The caller is told, because a tile that is gone is not in
   * the grid any more.
   */
  private enforceBudget(): void {
    while (this.tiles.size > this.maxTiles) {
      const oldest = this.tiles.keys().next();
      if (oldest.done) break;
      const key = oldest.value;
      const entry = this.tiles.get(key);
      this.tiles.delete(key);
      if (!entry) continue;

      // The remembered tile may be the one that has just gone.
      if (this.lastTile && tileKey(this.lastTile) === key) {
        this.lastTile = null;
        this.lastBounds = null;
      }
      if (entry.coord.z === this.finestZoom) this.recomputeFinestZoom();

      this.onEvict?.(entry.coord);
    }
  }

  /** The zoom of the finest tile left in the grid. */
  private recomputeFinestZoom(): void {
    let finest = -1;
    for (const tile of this.tiles.values()) {
      if (tile.coord.z > finest && tile.coord.z <= this.maxZoom) finest = tile.coord.z;
    }
    this.finestZoom = finest;
  }

  /** Move a tile to the most recently used end of the eviction order. */
  private touch(t: TileCoord): void {
    const key = tileKey(t);
    const entry = this.tiles.get(key);
    if (!entry) return;
    this.tiles.delete(key);
    this.tiles.set(key, entry);
  }

  hasTile(t: TileCoord): boolean {
    return this.tiles.has(tileKey(t));
  }

  /**
   * The elevation tile a render tile needs.
   *
   * The imagery of a tile is draped on an elevation tile that is two zooms
   * coarser: a mesh has at most 33 vertices per side, so a height field with
   * 64 samples across the tile already says more than the mesh can use, and
   * the height data outside the US is 30 m SRTM to begin with. The zoom is
   * capped at the finest elevation that is fetched and never below zoom 1.
   */
  elevationTileFor(t: TileCoord): TileCoord {
    const z = clamp(t.z - 2, 1, this.maxZoom);
    const shift = 2 ** (t.z - z);
    return { z, x: Math.floor(t.x / shift), y: Math.floor(t.y / shift) };
  }

  /** The highest zoom at or below maxZoom whose loaded tile covers the point. */
  finestLoadedTileFor(p: LonLat): TileCoord | null {
    return this.finestLoadedTileAt(lonLatToMercator(p));
  }

  /** Bilinear height on the finest loaded tile, with the zoom it came from. */
  sample(p: LonLat): { height: number; zoom: number } | null {
    const m = lonLatToMercator(p);
    const t = this.finestLoadedTileAt(m);
    if (!t) return null;
    return { height: this.heightIn(t, m), zoom: t.z };
  }

  /** Height at a local frame position, or 0 when nothing is loaded there. */
  sampleLocal(x: number, z: number): number {
    return this.sample(this.frame.toLonLat(x, z))?.height ?? 0;
  }

  /** Ground height in the local frame, with the horizon's curvature drop. */
  groundY(x: number, z: number): number {
    return this.sampleLocal(x, z) - curvatureDrop(Math.hypot(x, z));
  }

  tileCount(): number {
    return this.tiles.size;
  }

  /**
   * The finest loaded tile that covers a point in the Mercator plane.
   *
   * The tile that answered last time is tried first: the points of a mesh
   * build all lie in the same tile, so the walk is only needed when a point
   * leaves it. The remembered tile is only used while it is the finest tile
   * in the grid, because a finer tile elsewhere could cover the point.
   *
   * The walk itself starts at the finest zoom in the grid and halves the
   * column and the row on the way down, which are the tiles the point falls
   * in, so one projection is enough.
   */
  private finestLoadedTileAt(m: MercatorPoint): TileCoord | null {
    if (this.tiles.size === 0 || this.finestZoom < 0) return null;

    const cached = this.lastTile;
    const bounds = this.lastBounds;
    if (cached && bounds && cached.z === this.finestZoom && covers(bounds, m)) {
      // The tile that answers is the tile that is in use: it moves to the
      // end of the eviction order.
      this.touch(cached);
      return cached;
    }

    const top = tileOfMercator(m, this.finestZoom);
    for (let z = this.finestZoom; z >= 0; z--) {
      const shift = this.finestZoom - z;
      const tile: TileCoord = { z, x: top.x >> shift, y: top.y >> shift };
      if (!this.hasTile(tile)) continue;
      this.remember(tile);
      this.touch(tile);
      return tile;
    }
    return null;
  }

  /** Remember the tile that answered, with the bounds it covers. */
  private remember(tile: TileCoord): void {
    const last = this.lastTile;
    if (last && last.z === tile.z && last.x === tile.x && last.y === tile.y) return;
    this.lastTile = tile;
    this.lastBounds = tileBoundsMercator(tile);
  }

  /**
   * Bilinear height inside one tile.
   *
   * The tile is uniform in Mercator space, so the point's fractional pixel
   * coordinates follow from the Mercator bounds. Pixel centres sit at
   * (i + 0.5) / 256, hence the half pixel shift and the clamp to the tile.
   */
  private heightIn(t: TileCoord, m: MercatorPoint): number {
    const entry = this.tiles.get(tileKey(t));
    if (!entry) return 0;
    const heights = entry.heights;

    const b = tileBoundsMercator(t);
    const span = b.maxX - b.minX;
    const fx = ((m.x - b.minX) / span) * TILE;
    const fy = ((b.maxY - m.y) / span) * TILE;

    const gx = clamp(fx - 0.5, 0, TILE - 1);
    const gy = clamp(fy - 0.5, 0, TILE - 1);
    const x0 = Math.floor(gx);
    const y0 = Math.floor(gy);
    const x1 = Math.min(x0 + 1, TILE - 1);
    const y1 = Math.min(y0 + 1, TILE - 1);
    const tx = gx - x0;
    const ty = gy - y0;

    const h00 = heightAt(heights, x0, y0);
    const h10 = heightAt(heights, x1, y0);
    const h01 = heightAt(heights, x0, y1);
    const h11 = heightAt(heights, x1, y1);
    return h00 + (h10 - h00) * tx + (h01 - h00) * ty + (h11 - h10 - h01 + h00) * tx * ty;
  }
}

/** The tile at a zoom that holds a point in the Mercator plane. */
function tileOfMercator(m: MercatorPoint, z: number): TileCoord {
  const span = (2 * HALF_WORLD) / 2 ** z;
  return {
    z,
    x: Math.floor((m.x + HALF_WORLD) / span),
    y: Math.floor((HALF_WORLD - m.y) / span),
  };
}

/** Whether a point in the Mercator plane lies in a box. */
function covers(b: MercatorBounds, m: MercatorPoint): boolean {
  return m.x >= b.minX && m.x < b.maxX && m.y >= b.minY && m.y < b.maxY;
}

function clamp(v: number, lo: number, hi: number): number {
  if (v < lo) return lo;
  if (v > hi) return hi;
  return v;
}

function heightAt(heights: Float32Array, x: number, y: number): number {
  return heights[y * TILE + x] ?? 0;
}
