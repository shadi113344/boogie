import { describe, it, expect } from 'vitest';
import { TERRARIUM_TILE_SIZE, decodeTerrarium } from '@/world/terrarium';

describe('terrarium', () => {
  it('exposes the 256 px tile size', () => {
    expect(TERRARIUM_TILE_SIZE).toBe(256);
  });

  it('decodes sea level, one metre, half a metre and below sea level', () => {
    const px = new Uint8ClampedArray([128,0,0,255, 128,1,0,255, 128,0,128,255, 127,255,0,255]);
    const h = decodeTerrarium(px, 4, 1);
    expect(h[0]).toBe(0); expect(h[1]).toBe(1); expect(h[2]).toBe(0.5); expect(h[3]).toBe(-1);
  });

  it('decodes a full 256x256 tile to 65536 heights', () => {
    const px = new Uint8ClampedArray(256*256*4).fill(128);
    expect(decodeTerrarium(px, 256, 256).length).toBe(65536);
  });

  it('reads rows north to south, so row 0 is the north edge', () => {
    // 2x2 tile: top row at sea level, bottom row 256 m up.
    const px = new Uint8ClampedArray([
      128,0,0,255, 128,0,0,255,
      129,0,0,255, 129,0,0,255,
    ]);
    const h = decodeTerrarium(px, 2, 2);
    expect(h[0]).toBe(0);
    expect(h[1]).toBe(0);
    expect(h[2]).toBe(256);
    expect(h[3]).toBe(256);
  });

  it('accepts a plain Uint8Array as well as a clamped one', () => {
    const px = new Uint8Array([128,1,0,255]);
    const h = decodeTerrarium(px, 1, 1);
    expect(h.length).toBe(1);
    expect(h[0]).toBe(1);
  });

  it('keeps heights negative below sea level', () => {
    const px = new Uint8ClampedArray([127,255,255,255]);
    const h = decodeTerrarium(px, 1, 1);
    expect(h[0]).toBe(-0.00390625);
  });
});
