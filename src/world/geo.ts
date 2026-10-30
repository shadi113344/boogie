/**
 * Geodesy helpers for the Boogie world.
 *
 * Everything here is plain Web Mercator (EPSG:3857) arithmetic plus a local
 * tangent frame expressed in metres: x east, y up (metres above mean sea
 * level), z south. This module imports nothing from three.js or the DOM.
 */

export interface LonLat {
  lon: number;
  lat: number;
}

export interface TileCoord {
  z: number;
  x: number;
  y: number;
}

/** Sphere radius used by the Web Mercator projection. */
export const EARTH_RADIUS = 6378137;

/** Mean earth radius, used for the curvature (horizon) drop. */
export const EARTH_MEAN_RADIUS = 6371000;

const DEG = Math.PI / 180;

/** Latitude at which Web Mercator is truncated (the square world). */
const MAX_MERCATOR_LAT = 85.0511287798066;

/** Half the circumference of the projected world, in metres. */
const HALF_WORLD = Math.PI * EARTH_RADIUS;

/** Metres per pixel at the equator for a 256 px tile at zoom 0. */
const EQUATOR_METERS_PER_PIXEL = 156543.03392804097;

function clampLat(lat: number): number {
  if (lat > MAX_MERCATOR_LAT) return MAX_MERCATOR_LAT;
  if (lat < -MAX_MERCATOR_LAT) return -MAX_MERCATOR_LAT;
  return lat;
}

function clampLon(lon: number): number {
  return ((((lon + 180) % 360) + 360) % 360) - 180;
}

/** Projected northing (metres) of a latitude. */
function mercatorY(lat: number): number {
  return EARTH_RADIUS * Math.log(Math.tan(Math.PI / 4 + (clampLat(lat) * DEG) / 2));
}

export function lonLatToMercator(p: LonLat): { x: number; y: number } {
  return {
    x: EARTH_RADIUS * clampLon(p.lon) * DEG,
    y: mercatorY(p.lat),
  };
}

export function mercatorToLonLat(x: number, y: number): LonLat {
  return {
    lon: x / (EARTH_RADIUS * DEG),
    lat: (2 * Math.atan(Math.exp(y / EARTH_RADIUS)) - Math.PI / 2) / DEG,
  };
}

export function lonLatToTile(p: LonLat, z: number): TileCoord {
  const n = 2 ** z;
  const lon = clampLon(p.lon);
  const lat = clampLat(p.lat);
  const x = Math.floor(((lon + 180) / 360) * n);
  // Projected northing runs north, tile rows run south.
  const y = Math.floor((0.5 - mercatorY(lat) / (2 * HALF_WORLD)) * n);
  return { z, x, y };
}

export function tileBoundsMercator(t: TileCoord): {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
} {
  const span = (2 * HALF_WORLD) / 2 ** t.z;
  const minX = -HALF_WORLD + t.x * span;
  const maxX = minX + span;
  const maxY = HALF_WORLD - t.y * span;
  const minY = maxY - span;
  return { minX, minY, maxX, maxY };
}

export function tileBoundsLonLat(t: TileCoord): {
  west: number;
  south: number;
  east: number;
  north: number;
} {
  const b = tileBoundsMercator(t);
  return {
    west: mercatorToLonLat(b.minX, 0).lon,
    south: mercatorToLonLat(0, b.minY).lat,
    east: mercatorToLonLat(b.maxX, 0).lon,
    north: mercatorToLonLat(0, b.maxY).lat,
  };
}

/** Stable cache key for a tile, e.g. "14/8550/5784". */
export function tileKey(t: TileCoord): string {
  return `${t.z}/${t.x}/${t.y}`;
}

/** The tile one zoom level up, or null at the root zoom. */
export function parentTile(t: TileCoord): TileCoord | null {
  if (t.z <= 0) return null;
  return { z: t.z - 1, x: Math.floor(t.x / 2), y: Math.floor(t.y / 2) };
}

/** The four tiles one zoom level down, in NW, NE, SW, SE order. */
export function childTiles(t: TileCoord): [TileCoord, TileCoord, TileCoord, TileCoord] {
  const z = t.z + 1;
  const x = t.x * 2;
  const y = t.y * 2;
  return [
    { z, x, y },
    { z, x: x + 1, y },
    { z, x, y: y + 1 },
    { z, x: x + 1, y: y + 1 },
  ];
}

/** Ground resolution of a 256 px tile at the given latitude and zoom. */
export function metersPerPixel(lat: number, z: number): number {
  return (EQUATOR_METERS_PER_PIXEL * Math.cos(lat * DEG)) / 2 ** z;
}

/** Vertical drop of the horizon due to earth curvature, in metres. */
export function curvatureDrop(distance: number): number {
  return (distance * distance) / (2 * EARTH_MEAN_RADIUS);
}

/**
 * A local tangent frame anchored at an origin, in metres.
 *
 * Local coordinates are projected metres relative to the origin, scaled by
 * cos(origin latitude): x east, z south (north is negative z), y is height
 * above mean sea level.
 */
export class LocalFrame {
  readonly scale: number;

  private readonly originX: number;

  private readonly originY: number;

  constructor(public readonly origin: LonLat) {
    this.scale = Math.cos(origin.lat * DEG);
    const m = lonLatToMercator(origin);
    this.originX = m.x;
    this.originY = m.y;
  }

  toLocal(p: LonLat, heightM = 0): { x: number; y: number; z: number } {
    const m = lonLatToMercator(p);
    return {
      x: (m.x - this.originX) * this.scale,
      y: heightM,
      z: -(m.y - this.originY) * this.scale,
    };
  }

  toLonLat(x: number, z: number): LonLat {
    return mercatorToLonLat(
      this.originX + x / this.scale,
      this.originY - z / this.scale,
    );
  }

  /** Tile bounds in local metres; minZ is the north edge, maxZ the south edge. */
  tileBoundsLocal(t: TileCoord): { minX: number; maxX: number; minZ: number; maxZ: number } {
    const b = tileBoundsMercator(t);
    return {
      minX: (b.minX - this.originX) * this.scale,
      maxX: (b.maxX - this.originX) * this.scale,
      minZ: -(b.maxY - this.originY) * this.scale,
      maxZ: -(b.minY - this.originY) * this.scale,
    };
  }
}
