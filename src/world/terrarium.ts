/**
 * Decoding for Terrarium elevation PNGs (Mapzen / AWS Terrain Tiles).
 *
 * A Terrarium tile stores the height of each pixel as three bytes:
 *
 *   height = R * 256 + G + B / 256 - 32768   (metres above mean sea level)
 *
 * so the green channel gives the metre, the blue channel the sub-metre
 * fraction and the red channel the 256 m band. This module imports nothing
 * from three.js or the DOM.
 */

/** Edge length in pixels of a Terrarium tile. */
export const TERRARIUM_TILE_SIZE = 256;

/** Height offset that turns the stored value into metres above sea level. */
const TERRARIUM_OFFSET = 32768;

/**
 * Decode a Terrarium tile into heights in metres.
 *
 * The pixel buffer is RGBA, row major, north row first (the PNG's own order),
 * so the returned array has `height` rows of `width` heights with row 0 at the
 * north edge. Pixels missing from a short buffer decode as 0, i.e. sea level.
 */
export function decodeTerrarium(
  rgba: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
): Float32Array {
  const out = new Float32Array(width * height);
  const pixels = Math.min(width * height, Math.floor(rgba.length / 4));
  for (let i = 0; i < pixels; i++) {
    const p = i * 4;
    const r = rgba[p] ?? 0;
    const g = rgba[p + 1] ?? 0;
    const b = rgba[p + 2] ?? 0;
    out[i] = r * 256 + g + b / 256 - TERRARIUM_OFFSET;
  }
  return out;
}
