/**
 * Pure LOD selection for the terrain quadtree.
 *
 * The quadtree starts from a coarse ring of tiles around the landing zone
 * and splits them while the screen-space error says the imagery is too
 * coarse. Two rules keep the result small: tiles outside the view cone are
 * not refined at all, so the ground behind the camera stays coarse, and the
 * imagery zoom is capped by the distance from the landing zone.
 *
 * The splits are ordered best-first: the leaf with the largest screen error
 * is split next, so the budget buys the sharpness where it is missed most
 * and the far edge of every zoom ring is the first to go coarse. The budget
 * is hard: no error threshold is relaxed to make the selection fit.
 *
 * This module imports nothing from three.js or the DOM.
 */

import {
  LocalFrame,
  TileCoord,
  metersPerPixel,
  childTiles,
  parentTile,
  tileKey,
  lonLatToTile,
} from '../../world/geo';

/** Everything the selection needs to know about the camera. */
export interface LodCamera {
  /** Local frame position, metres (x east, y up, z south). */
  x: number;
  y: number;
  z: number;
  /** drawingBufferHeightPx / (2 * tan(fovY / 2)), with the capped pixel ratio applied. */
  focalPx: number;
  /** Unit view direction. */
  dir: { x: number; y: number; z: number };
  /** Half of the diagonal field of view: atan(sqrt(w² + h²) / (2 * focalPx)). */
  halfAngleRad: number;
}

/** Imagery zoom allowed up to `radiusM` from the landing zone. */
export interface ZoomCap {
  radiusM: number;
  maxZoom: number;
}

/**
 * Imagery zoom by distance from the landing zone: 18 within 1.5 km, 17
 * within 4 km, 16 within 10 km, 14 within 30 km, 12 to 100 km and 9 to
 * the horizon.
 */
export const DEFAULT_ZOOM_CAPS: ZoomCap[] = [
  { radiusM: 1500, maxZoom: 18 },
  { radiusM: 4000, maxZoom: 17 },
  { radiusM: 10000, maxZoom: 16 },
  { radiusM: 30000, maxZoom: 14 },
  { radiusM: 100000, maxZoom: 12 },
  { radiusM: Infinity, maxZoom: 9 },
];

export interface LodConfig {
  /** Texels per pixel allowed before a split. */
  tau: number;
  /** Zoom of the tiles the selection starts from. */
  rootZoom: number;
  /** Deepest zoom the selection may reach. */
  maxZoom: number;
  /** Half-width of the square around the landing zone that is covered. */
  rootRadiusM: number;
  /** Imagery zoom by distance from the landing zone. */
  zoomCaps: ZoomCap[];
  /** Extra angle around the view cone in which tiles are still refined. */
  viewMarginRad: number;
  /** Upper bound on the number of leaves of one selection. */
  maxLeaves: number;
}

/** Height of a tile in metres above mean sea level. */
export interface HeightRange {
  min: number;
  max: number;
}

const DEFAULT_CONFIG: LodConfig = {
  tau: 1.0,
  rootZoom: 8,
  maxZoom: 18,
  rootRadiusM: 250000,
  zoomCaps: DEFAULT_ZOOM_CAPS,
  viewMarginRad: 0.35,
  maxLeaves: 400,
};

/** An axis-aligned box in the local frame. */
interface Aabb {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  minZ: number;
  maxZ: number;
}

/** A leaf that may be split, with the screen error that orders the splits. */
interface Candidate {
  tile: TileCoord;
  error: number;
}

export class TerrainQuadtree {
  readonly config: LodConfig;

  private readonly frame: LocalFrame;

  private readonly lz: { x: number; z: number };

  private readonly caps: ZoomCap[];

  constructor(frame: LocalFrame, lz: { x: number; z: number }, config: Partial<LodConfig> = {}) {
    this.frame = frame;
    this.lz = lz;
    const caps = [...(config.zoomCaps ?? DEFAULT_ZOOM_CAPS)].sort((a, b) => a.radiusM - b.radiusM);
    this.config = { ...DEFAULT_CONFIG, ...config, zoomCaps: caps };
    this.caps = caps;
  }

  /**
   * The root tiles: every tile of `rootZoom` whose bounds meet the square
   * of `rootRadiusM` around the landing zone.
   */
  rootTiles(): TileCoord[] {
    const r = this.config.rootRadiusM;
    const x0 = this.lz.x - r;
    const x1 = this.lz.x + r;
    const z0 = this.lz.z - r;
    const z1 = this.lz.z + r;

    // The local frame is a linear map of the Mercator plane, so the tile
    // range follows from the corners of the square. The range is widened by
    // one tile and then filtered on the exact bounds.
    const corners = [
      this.frame.toLonLat(x0, z0),
      this.frame.toLonLat(x1, z0),
      this.frame.toLonLat(x0, z1),
      this.frame.toLonLat(x1, z1),
    ];
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const c of corners) {
      const t = lonLatToTile(c, this.config.rootZoom);
      minX = Math.min(minX, t.x);
      maxX = Math.max(maxX, t.x);
      minY = Math.min(minY, t.y);
      maxY = Math.max(maxY, t.y);
    }

    const tiles: TileCoord[] = [];
    for (let x = minX - 1; x <= maxX + 1; x++) {
      for (let y = minY - 1; y <= maxY + 1; y++) {
        const t: TileCoord = { z: this.config.rootZoom, x, y };
        const b = this.frame.tileBoundsLocal(t);
        if (b.maxX < x0 || b.minX > x1 || b.maxZ < z0 || b.minZ > z1) continue;
        tiles.push(t);
      }
    }
    return tiles;
  }

  /** The imagery zoom allowed at the given distance from the landing zone. */
  zoomCapAt(x: number, z: number): number {
    const d = Math.hypot(x - this.lz.x, z - this.lz.z);
    for (const cap of this.caps) {
      if (d <= cap.radiusM) return cap.maxZoom;
    }
    return this.caps.length > 0 ? this.caps[this.caps.length - 1]!.maxZoom : this.config.maxZoom;
  }

  /** Distance from the camera to the tile's box, zero when the camera is inside. */
  distanceToTile(cam: LodCamera, t: TileCoord, h: HeightRange): number {
    const box = this.aabb(t, h);
    return Math.hypot(
      axisGap(cam.x, box.minX, box.maxX),
      axisGap(cam.y, box.minY, box.maxY),
      axisGap(cam.z, box.minZ, box.maxZ),
    );
  }

  /** True when the camera looks at the tile: inside it, or within the view cone. */
  inView(cam: LodCamera, t: TileCoord, h: HeightRange): boolean {
    const box = this.aabb(t, h);
    // The vector from the camera to the nearest point of the box.
    const wx = clamp(cam.x, box.minX, box.maxX) - cam.x;
    const wy = clamp(cam.y, box.minY, box.maxY) - cam.y;
    const wz = clamp(cam.z, box.minZ, box.maxZ) - cam.z;
    const len = Math.hypot(wx, wy, wz);
    if (len === 0) return true; // the camera is inside the box

    const dirLen = Math.hypot(cam.dir.x, cam.dir.y, cam.dir.z);
    if (dirLen === 0) return false;
    const cos = (wx * cam.dir.x + wy * cam.dir.y + wz * cam.dir.z) / (len * dirLen);
    const angle = Math.acos(Math.max(-1, Math.min(1, cos)));
    return angle <= cam.halfAngleRad + this.config.viewMarginRad;
  }

  /** Texels per screen pixel: one is the point where the imagery looks sharp. */
  texelError(cam: LodCamera, t: TileCoord, h: HeightRange): number {
    const dist = this.distanceToTile(cam, t, h);
    const lat = this.tileCentreLat(t);
    return (metersPerPixel(lat, t.z) / Math.max(dist, 1)) * cam.focalPx;
  }

  /**
   * The leaves of the terrain tree.
   *
   * The split order is best-first: of all the leaves that the view cone
   * reaches, that are still below their zoom limit and that are still too
   * coarse for the screen, the one with the largest screen error is split
   * next. The tile under the camera always has the largest error, so it is
   * refined first, and the budget is spent on the ground that is missed
   * most.
   *
   * The same rule applies from the root ring down: a tile is a candidate
   * while the view cone reaches it, it is below its zoom limit and its own
   * texel error is above tau.
   *
   * A split replaces one leaf with its four children, so the selection
   * always covers the same area: the budget only decides how fine that area
   * is, never where it is.
   */
  select(cam: LodCamera, heightRange: (t: TileCoord) => HeightRange): TileCoord[] {
    const leaves = new Map<string, TileCoord>();
    const heap: Candidate[] = [];

    for (const root of this.rootTiles()) {
      leaves.set(tileKey(root), root);
      const error = this.splitError(cam, root, heightRange);
      if (error !== null) heapPush(heap, { tile: root, error });
    }

    while (heap.length > 0 && leaves.size + 3 <= this.config.maxLeaves) {
      const candidate = heapPop(heap)!;
      leaves.delete(tileKey(candidate.tile));
      for (const child of childTiles(candidate.tile)) {
        leaves.set(tileKey(child), child);
        const error = this.splitError(cam, child, heightRange);
        if (error !== null) heapPush(heap, { tile: child, error });
      }
    }

    return [...leaves.values()];
  }

  /**
   * The screen error of a leaf that may be split, or null when the leaf
   * stays as it is: tiles the view cone does not reach are never refined,
   * tiles at their zoom limit have no finer imagery to spend, and tiles
   * that are sharp enough are left alone.
   */
  private splitError(
    cam: LodCamera,
    t: TileCoord,
    heightRange: (t: TileCoord) => HeightRange,
  ): number | null {
    const h = heightRange(t);
    if (!this.reachesViewCone(cam, t, h)) return null;
    if (t.z >= this.zoomLimit(t)) return null;
    const error = this.texelError(cam, t, h);
    return error > this.config.tau ? error : null;
  }

  /**
   * True when the view cone reaches the tile at all.
   *
   * `inView` asks whether the camera looks at the nearest point of the
   * tile, which is the right question for a small tile but not for the
   * root ring: the camera hangs over the middle of it, so its nearest point
   * is straight down, and in a freefall view straight down is outside the
   * cone even though the cone still reaches the ground ahead. The selection
   * therefore asks whether the cone and the tile overlap: the nearest point
   * counts, so does the axis of the view, so does any corner of the tile.
   */
  private reachesViewCone(cam: LodCamera, t: TileCoord, h: HeightRange): boolean {
    if (this.inView(cam, t, h)) return true;
    const box = this.aabb(t, h);
    if (rayHitsBox(cam, box)) return true;
    const cos = Math.cos(cam.halfAngleRad + this.config.viewMarginRad);
    for (const corner of boxCorners(box)) {
      if (inViewCone(cam, corner, cos)) return true;
    }
    return false;
  }

  /** The deepest zoom the tile may reach, given the distance cap. */
  private zoomLimit(t: TileCoord): number {
    const b = this.frame.tileBoundsLocal(t);
    const centreX = (b.minX + b.maxX) / 2;
    const centreZ = (b.minZ + b.maxZ) / 2;
    return Math.min(this.config.maxZoom, this.zoomCapAt(centreX, centreZ));
  }

  /** The tile's box in the local frame. */
  private aabb(t: TileCoord, h: HeightRange): Aabb {
    const b = this.frame.tileBoundsLocal(t);
    return {
      minX: b.minX,
      maxX: b.maxX,
      minY: h.min,
      maxY: h.max,
      minZ: b.minZ,
      maxZ: b.maxZ,
    };
  }

  /** The latitude of the middle of the tile, where the ground resolution is measured. */
  private tileCentreLat(t: TileCoord): number {
    const b = this.frame.tileBoundsLocal(t);
    return this.frame.toLonLat((b.minX + b.maxX) / 2, (b.minZ + b.maxZ) / 2).lat;
  }
}

/**
 * The tiles to draw for a desired set: every leaf that is not ready is
 * replaced by the nearest ready ancestor, and duplicates are dropped.
 */
export function computeRenderSet(
  desired: TileCoord[],
  isReady: (t: TileCoord) => boolean,
): TileCoord[] {
  const out: TileCoord[] = [];
  const seen = new Set<string>();
  for (const leaf of desired) {
    let t: TileCoord | null = leaf;
    while (t !== null && !isReady(t)) t = parentTile(t);
    if (t === null) continue;
    const key = tileKey(t);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  return out;
}

/** Distance from a value to an interval, zero inside it. */
function axisGap(value: number, min: number, max: number): number {
  if (value < min) return min - value;
  if (value > max) return value - max;
  return 0;
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

/** The eight corners of a box. */
function boxCorners(box: Aabb): { x: number; y: number; z: number }[] {
  const corners: { x: number; y: number; z: number }[] = [];
  for (const x of [box.minX, box.maxX]) {
    for (const y of [box.minY, box.maxY]) {
      for (const z of [box.minZ, box.maxZ]) {
        corners.push({ x, y, z });
      }
    }
  }
  return corners;
}

/** True when the point is inside the cone of the camera. */
function inViewCone(
  cam: LodCamera,
  p: { x: number; y: number; z: number },
  cosHalfAngle: number,
): boolean {
  const vx = p.x - cam.x;
  const vy = p.y - cam.y;
  const vz = p.z - cam.z;
  const len = Math.hypot(vx, vy, vz);
  if (len === 0) return true; // the point is the camera itself
  const dirLen = Math.hypot(cam.dir.x, cam.dir.y, cam.dir.z);
  if (dirLen === 0) return false;
  const dot = (vx * cam.dir.x + vy * cam.dir.y + vz * cam.dir.z) / dirLen;
  if (dot <= 0) return false; // behind the camera
  return dot / len >= cosHalfAngle;
}

/** True when the axis of the view, as a ray, meets the box. */
function rayHitsBox(cam: LodCamera, box: Aabb): boolean {
  const dirLen = Math.hypot(cam.dir.x, cam.dir.y, cam.dir.z);
  if (dirLen === 0) return false;
  const dir = { x: cam.dir.x / dirLen, y: cam.dir.y / dirLen, z: cam.dir.z / dirLen };
  const origin = { x: cam.x, y: cam.y, z: cam.z };
  const slabs: { o: number; d: number; min: number; max: number }[] = [
    { o: origin.x, d: dir.x, min: box.minX, max: box.maxX },
    { o: origin.y, d: dir.y, min: box.minY, max: box.maxY },
    { o: origin.z, d: dir.z, min: box.minZ, max: box.maxZ },
  ];
  let enter = 0;
  let leave = Infinity;
  for (const slab of slabs) {
    if (Math.abs(slab.d) < 1e-9) {
      if (slab.o < slab.min || slab.o > slab.max) return false;
      continue;
    }
    let t0 = (slab.min - slab.o) / slab.d;
    let t1 = (slab.max - slab.o) / slab.d;
    if (t0 > t1) {
      const swap = t0;
      t0 = t1;
      t1 = swap;
    }
    enter = Math.max(enter, t0);
    leave = Math.min(leave, t1);
    if (enter > leave) return false;
  }
  return true;
}

/** Put a candidate on the heap, the largest screen error first. */
function heapPush(heap: Candidate[], candidate: Candidate): void {
  heap.push(candidate);
  let i = heap.length - 1;
  while (i > 0) {
    const parent = (i - 1) >> 1;
    if (heap[parent]!.error >= heap[i]!.error) break;
    const swap = heap[parent]!;
    heap[parent] = heap[i]!;
    heap[i] = swap;
    i = parent;
  }
}

/** Take the candidate with the largest screen error off the heap. */
function heapPop(heap: Candidate[]): Candidate | undefined {
  const top = heap[0];
  const last = heap.pop();
  if (last === undefined) return undefined;
  if (heap.length === 0) return top;
  heap[0] = last;
  let i = 0;
  for (;;) {
    const left = 2 * i + 1;
    const right = left + 1;
    let biggest = i;
    if (left < heap.length && heap[left]!.error > heap[biggest]!.error) biggest = left;
    if (right < heap.length && heap[right]!.error > heap[biggest]!.error) biggest = right;
    if (biggest === i) break;
    const swap = heap[biggest]!;
    heap[biggest] = heap[i]!;
    heap[i] = swap;
    i = biggest;
  }
  return top;
}
