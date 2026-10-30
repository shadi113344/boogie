/**
 * Loaded elevation tiles and bilinear ground sampling.
 *
 * The grid keeps decoded height tiles in memory, keyed by tile, and answers
 * height queries by sampling the finest tile that is loaded at the point.
 * Heights are metres above mean sea level. This module imports nothing from
 * three.js or the DOM.
 */

import { curvatureDrop, lonLatToMercator, tileBoundsMercator, tileKey, EARTH_RADIUS } from './geo';
import type { LocalFrame, LonLat, TileCoord } from './geo';
import { TERRARIUM_TILE_SIZE } from './terrarium';

/** Default zoom of the elevation tiles: ~6 m per pixel at Interlaken. */
const DEFAULT_MAX_ZOOM = 14;

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

export class ElevationGrid {
  readonly maxZoom: number;

  private readonly frame: LocalFrame;

  private readonly tiles = new Map<string, Float32Array>();

  /** The tile that answered the last sample. */
  private lastTile: TileCoord | null = null;

  /** The Mercator bounds of `lastTile`. */
  private lastBounds: MercatorBounds | null = null;

  /** The zoom of the finest tile in the grid, -1 while it is empty. */
  private finestZoom = -1;

  constructor(frame: LocalFrame, opts?: { maxZoom?: number }) {
    this.frame = frame;
    this.maxZoom = opts?.maxZoom ?? DEFAULT_MAX_ZOOM;
  }

  /** Store the heights of one tile; row 0 is the north edge. */
  addTile(t: TileCoord, heights: Float32Array): void {
    const expected = TILE * TILE;
    if (heights.length !== expected) {
      throw new RangeError(`elevation tile ${tileKey(t)} must hold ${expected} heights, got ${heights.length}`);
    }
    this.tiles.set(tileKey(t), heights);
    if (t.z > this.finestZoom && t.z <= this.maxZoom) this.finestZoom = t.z;

    // A tile that has just arrived may cover the point of the last sample
    // more finely, so the remembered tile is dropped.
    this.lastTile = null;
    this.lastBounds = null;
  }

  hasTile(t: TileCoord): boolean {
    return this.tiles.has(tileKey(t));
  }

  /**
   * The elevation tile a render tile needs: the same column and row scaled to
   * the zoom min(t.z, maxZoom).
   */
  elevationTileFor(t: TileCoord): TileCoord {
    if (t.z <= this.maxZoom) return { z: t.z, x: t.x, y: t.y };
    const shift = 2 ** (t.z - this.maxZoom);
    return { z: this.maxZoom, x: Math.floor(t.x / shift), y: Math.floor(t.y / shift) };
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
      return cached;
    }

    const top = tileOfMercator(m, this.finestZoom);
    for (let z = this.finestZoom; z >= 0; z--) {
      const shift = this.finestZoom - z;
      const tile: TileCoord = { z, x: top.x >> shift, y: top.y >> shift };
      if (!this.hasTile(tile)) continue;
      this.remember(tile);
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
    const heights = this.tiles.get(tileKey(t));
    if (!heights) return 0;

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
