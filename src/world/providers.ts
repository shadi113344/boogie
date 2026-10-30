/**
 * The tile providers Boogie reads terrain and imagery from.
 *
 * Each provider is a URL template with `{z}`, `{x}` and `{y}` placeholders; the
 * placeholder order in the template is the provider's own (Esri and EOX both
 * put the row before the column). This module imports nothing from three.js or
 * the DOM.
 */

import type { TileCoord } from './geo';

export interface TileProvider {
  id: string;
  urlTemplate: string;
  minZoom: number;
  maxZoom: number;
  attribution: string;
}

const ESRI_ATTRIBUTION =
  'Imagery © Esri, Maxar, Earthstar Geographics, and the GIS User Community';
const EOX_ATTRIBUTION = 'Sentinel-2 cloudless by EOX (CC BY-NC-SA 4.0)';
const MAPZEN_ATTRIBUTION = 'Terrain: Mapzen / AWS Terrain Tiles';

/** The single line of attribution shown on the page. */
export const ATTRIBUTION_TEXT = `${ESRI_ATTRIBUTION} · ${EOX_ATTRIBUTION} · ${MAPZEN_ATTRIBUTION}`;

/** Terrain heights: Mapzen Terrarium PNGs on AWS Terrain Tiles, no key needed. */
export const ELEVATION_PROVIDER: TileProvider = {
  id: 'terrarium',
  urlTemplate: 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png',
  minZoom: 0,
  maxZoom: 15,
  attribution: MAPZEN_ATTRIBUTION,
};

/** Near-field imagery: Esri World Imagery, `{z}/{y}/{x}` order. */
export const IMAGERY_NEAR_PROVIDER: TileProvider = {
  id: 'esri-world-imagery',
  urlTemplate:
    'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
  minZoom: 0,
  maxZoom: 19,
  attribution: ESRI_ATTRIBUTION,
};

/** Far-field imagery and fallback: EOX Sentinel-2 cloudless, `{z}/{y}/{x}` order. */
export const IMAGERY_FAR_PROVIDER: TileProvider = {
  id: 'eox-s2cloudless-2020',
  urlTemplate:
    'https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2020_3857/default/g/{z}/{y}/{x}.jpg',
  minZoom: 0,
  maxZoom: 14,
  attribution: EOX_ATTRIBUTION,
};

/**
 * Build the URL of one tile. The provider's template decides the order of the
 * placeholders, so `{y}` before `{x}` stays that way.
 */
export function tileUrl(p: TileProvider, t: TileCoord): string {
  return p.urlTemplate
    .replace('{z}', String(t.z))
    .replace('{x}', String(t.x))
    .replace('{y}', String(t.y));
}

/**
 * The imagery provider for a zoom level: the coarse, far-field Sentinel-2
 * tiles up to zoom 11, Esri World Imagery from zoom 12 up.
 */
export function imageryProviderForZoom(z: number): TileProvider {
  return z <= 11 ? IMAGERY_FAR_PROVIDER : IMAGERY_NEAR_PROVIDER;
}
