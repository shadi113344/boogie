import { describe, it, expect } from 'vitest';
import {
  ELEVATION_PROVIDER,
  IMAGERY_NEAR_PROVIDER,
  IMAGERY_FAR_PROVIDER,
  ATTRIBUTION_TEXT,
  tileUrl,
  imageryProviderForZoom,
} from '@/world/providers';

describe('providers', () => {
  it('formats provider URLs with the provider\'s placeholder order', () => {
    const t = { z: 14, x: 8550, y: 5784 };
    expect(tileUrl(ELEVATION_PROVIDER, t)).toBe('https://s3.amazonaws.com/elevation-tiles-prod/terrarium/14/8550/5784.png');
    expect(tileUrl(IMAGERY_NEAR_PROVIDER, t)).toBe('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/14/5784/8550');
    expect(tileUrl(IMAGERY_FAR_PROVIDER, { z: 8, x: 133, y: 90 })).toBe('https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2020_3857/default/g/8/90/133.jpg');
  });

  it('splits imagery providers at zoom 11', () => {
    expect(imageryProviderForZoom(11)).toBe(IMAGERY_FAR_PROVIDER);
    expect(imageryProviderForZoom(12)).toBe(IMAGERY_NEAR_PROVIDER);
  });

  it('attribution names all three sources', () => {
    for (const s of ['Esri', 'EOX', 'Mapzen']) expect(ATTRIBUTION_TEXT).toContain(s);
  });

  it('caps each provider at its documented maximum zoom', () => {
    expect(ELEVATION_PROVIDER.maxZoom).toBe(15);
    expect(IMAGERY_NEAR_PROVIDER.maxZoom).toBe(19);
    expect(IMAGERY_FAR_PROVIDER.maxZoom).toBe(14);
  });

  it('gives every provider an id, a range and an attribution', () => {
    for (const p of [ELEVATION_PROVIDER, IMAGERY_NEAR_PROVIDER, IMAGERY_FAR_PROVIDER]) {
      expect(p.id.length).toBeGreaterThan(0);
      expect(p.minZoom).toBeLessThanOrEqual(p.maxZoom);
      expect(p.attribution.length).toBeGreaterThan(0);
      expect(p.urlTemplate).toContain('{z}');
    }
  });
});
