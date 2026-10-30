import { describe, it, expect } from 'vitest';
import {
  EARTH_RADIUS,
  EARTH_MEAN_RADIUS,
  lonLatToMercator,
  mercatorToLonLat,
  lonLatToTile,
  tileBoundsMercator,
  tileBoundsLonLat,
  tileKey,
  parentTile,
  childTiles,
  metersPerPixel,
  curvatureDrop,
  LocalFrame,
} from '@/world/geo';

describe('geo', () => {
  it('exposes the two earth radii', () => {
    expect(EARTH_RADIUS).toBe(6378137);
    expect(EARTH_MEAN_RADIUS).toBe(6371000);
  });

  it('metersPerPixel at the equator, zoom 0', () =>
    expect(metersPerPixel(0, 0)).toBeCloseTo(156543.03, 1));

  it('metersPerPixel at Interlaken, zoom 14', () => {
    expect(metersPerPixel(46.68, 14)).toBeGreaterThan(6.5);
    expect(metersPerPixel(46.68, 14)).toBeLessThan(6.6);
  });

  it('tile bounds contain the point used to find the tile', () => {
    const p = { lon: 7.88, lat: 46.68 };
    const b = tileBoundsLonLat(lonLatToTile(p, 14));
    expect(p.lon).toBeGreaterThanOrEqual(b.west);
    expect(p.lon).toBeLessThan(b.east);
    expect(p.lat).toBeGreaterThan(b.south);
    expect(p.lat).toBeLessThanOrEqual(b.north);
  });

  it('mercator round trip', () => {
    const p = { lon: 55.14, lat: 25.09 };
    const m = lonLatToMercator(p);
    const q = mercatorToLonLat(m.x, m.y);
    expect(q.lon).toBeCloseTo(p.lon, 9);
    expect(q.lat).toBeCloseTo(p.lat, 9);
  });

  it('parent and children are consistent', () => {
    const t = { z: 14, x: 8550, y: 5784 };
    for (const c of childTiles(t)) expect(parentTile(c)).toEqual(t);
  });

  it('curvature drop', () => {
    expect(curvatureDrop(10_000)).toBeCloseTo(7.85, 1);
    expect(curvatureDrop(100_000)).toBeCloseTo(784.8, 0);
  });

  it('local frame measures 1 km east as 1 km at 46.68 N', () => {
    const f = new LocalFrame({ lon: 7.88, lat: 46.68 });
    const dLon = 1000 / (111_320 * Math.cos((46.68 * Math.PI) / 180));
    const l = f.toLocal({ lon: 7.88 + dLon, lat: 46.68 });
    expect(l.x).toBeCloseTo(1000, -1);
    expect(Math.abs(l.z)).toBeLessThan(1);
  });

  it('local frame measures 1 km north as -z at 60.3 N (Gryttjom)', () => {
    const f = new LocalFrame({ lon: 17.43, lat: 60.3 });
    const l = f.toLocal({ lon: 17.43, lat: 60.3 + 1000 / 111_320 });
    expect(l.z).toBeCloseTo(-1000, -1);
    expect(Math.abs(l.x)).toBeLessThan(1);
  });

  it('toLonLat inverts toLocal', () => {
    const f = new LocalFrame({ lon: 7.88, lat: 46.68 });
    const p = f.toLonLat(1234, -5678);
    const l = f.toLocal(p);
    expect(l.x).toBeCloseTo(1234, 3);
    expect(l.z).toBeCloseTo(-5678, 3);
  });

  it('tileBoundsLocal north edge has the smaller z', () => {
    const f = new LocalFrame({ lon: 7.88, lat: 46.68 });
    const b = f.tileBoundsLocal(lonLatToTile(f.origin, 14));
    expect(b.minZ).toBeLessThan(b.maxZ);
    expect(b.maxX - b.minX).toBeCloseTo(b.maxZ - b.minZ, 0);
  });

  it('tile key is z/x/y', () => {
    expect(tileKey({ z: 14, x: 8550, y: 5784 })).toBe('14/8550/5784');
  });

  it('parentTile is null at zoom 0', () => {
    expect(parentTile({ z: 0, x: 0, y: 0 })).toBeNull();
  });

  it('tile bounds in mercator agree with the lon/lat bounds', () => {
    const t = lonLatToTile({ lon: 7.88, lat: 46.68 }, 14);
    const m = tileBoundsMercator(t);
    const b = tileBoundsLonLat(t);
    expect(mercatorToLonLat(m.minX, 0).lon).toBeCloseTo(b.west, 9);
    expect(mercatorToLonLat(m.maxX, 0).lon).toBeCloseTo(b.east, 9);
    expect(mercatorToLonLat(0, m.minY).lat).toBeCloseTo(b.south, 9);
    expect(mercatorToLonLat(0, m.maxY).lat).toBeCloseTo(b.north, 9);
  });
});
