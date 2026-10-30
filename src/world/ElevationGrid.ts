/**
 * Loaded elevation tiles and bilinear ground sampling.
 *
 * The grid keeps decoded height tiles in memory, keyed by tile, and answers
 * height queries by sampling the finest tile that is loaded at the point.
 * Heights are metres above mean sea level. This module imports nothing from
 * three.js or the DOM.
 */

import { curvatureDrop, lonLatToMercator, lonLatToTile, tileBoundsMercator, tileKey } from './geo';
import type { LocalFrame, LonLat, TileCoord } from './geo';
import { TERRARIUM_TILE_SIZE } from './terrarium';

/** Default zoom of the elevation tiles: ~6 m per pixel at Interlaken. */
const DEFAULT_MAX_ZOOM = 14;

/** Edge length of a tile in pixels; row 0 is the north edge. */
const TILE = TERRARIUM_TILE_SIZE;

export class ElevationGrid {
  readonly maxZoom: number;

  private readonly frame: LocalFrame;

  private readonly tiles = new Map<string, Float32Array>();

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
    for (let z = this.maxZoom; z >= 0; z--) {
      const t = lonLatToTile(p, z);
      if (this.hasTile(t)) return t;
    }
    return null;
  }

  /** Bilinear height on the finest loaded tile, with the zoom it came from. */
  sample(p: LonLat): { height: number; zoom: number } | null {
    const t = this.finestLoadedTileFor(p);
    if (!t) return null;
    return { height: this.heightIn(t, p), zoom: t.z };
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
   * Bilinear height inside one tile.
   *
   * The tile is uniform in Mercator space, so the point's fractional pixel
   * coordinates follow from the Mercator bounds. Pixel centres sit at
   * (i + 0.5) / 256, hence the half pixel shift and the clamp to the tile.
   */
  private heightIn(t: TileCoord, p: LonLat): number {
    const heights = this.tiles.get(tileKey(t));
    if (!heights) return 0;

    const b = tileBoundsMercator(t);
    const m = lonLatToMercator(p);
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

function clamp(v: number, lo: number, hi: number): number {
  if (v < lo) return lo;
  if (v > hi) return hi;
  return v;
}

function heightAt(heights: Float32Array, x: number, y: number): number {
  return heights[y * TILE + x] ?? 0;
}
