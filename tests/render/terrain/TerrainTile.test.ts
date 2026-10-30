import { describe, it, expect, vi } from 'vitest';
import { BufferGeometry, MeshBasicMaterial, SRGBColorSpace, Texture } from 'three';
import { Atmosphere } from '@/render/Atmosphere';
import {
  TerrainTile,
  TileBounds,
  buildTileGeometry,
  gridSizeForZoom,
  updateTileHeights,
} from '@/render/terrain/TerrainTile';

/** A tile a hundred metres across, with its north edge at minZ. */
const b: TileBounds = { minX: 0, maxX: 100, minZ: 0, maxZ: 100 };

function x(geo: BufferGeometry, i: number): number {
  return geo.getAttribute('position').getX(i);
}

function y(geo: BufferGeometry, i: number): number {
  return geo.getAttribute('position').getY(i);
}

function z(geo: BufferGeometry, i: number): number {
  return geo.getAttribute('position').getZ(i);
}

function u(geo: BufferGeometry, i: number): number {
  return geo.getAttribute('uv').getX(i);
}

function v(geo: BufferGeometry, i: number): number {
  return geo.getAttribute('uv').getY(i);
}

describe('gridSizeForZoom', () => {
  it('grid sizes by zoom', () => {
    expect(gridSizeForZoom(18)).toBe(65);
    expect(gridSizeForZoom(16)).toBe(65);
    expect(gridSizeForZoom(14)).toBe(33);
    expect(gridSizeForZoom(12)).toBe(33);
    expect(gridSizeForZoom(8)).toBe(17);
  });
});

describe('buildTileGeometry', () => {
  it('builds gridSize² + 4*(gridSize) skirt vertices', () => {
    const g = buildTileGeometry({ bounds: b, gridSize: 5, skirtDepth: 10 }, () => 0);
    expect(g.getAttribute('position').count).toBe(25 + 20);
  });

  it('puts uv (0,0) at the north-west corner and (1,1) at the south-east', () => {
    const g = buildTileGeometry({ bounds: b, gridSize: 5, skirtDepth: 10 }, () => 0);

    // Vertex 0 sits at the north-west corner, the last one at the south-east.
    expect(u(g, 0)).toBeCloseTo(0, 10);
    expect(v(g, 0)).toBeCloseTo(0, 10);
    expect(x(g, 0)).toBeCloseTo(-50, 10);
    expect(z(g, 0)).toBeCloseTo(-50, 10);

    const last = 24;
    expect(u(g, last)).toBeCloseTo(1, 10);
    expect(v(g, last)).toBeCloseTo(1, 10);
    expect(x(g, last)).toBeCloseTo(50, 10);
    expect(z(g, last)).toBeCloseTo(50, 10);
  });

  it('applies heights and tile-relative positions', () => {
    const g = buildTileGeometry({ bounds: b, gridSize: 5, skirtDepth: 10 }, (px) => px);

    // The middle vertex of a 5×5 grid: the tile centre, 50 m east.
    const centre = 2 * 5 + 2;
    expect(x(g, centre)).toBeCloseTo(0, 10);
    expect(y(g, centre)).toBeCloseTo(50, 10);
  });

  it('lowers skirt vertices by skirtDepth', () => {
    const g = buildTileGeometry({ bounds: b, gridSize: 5, skirtDepth: 10 }, (px, pz) => px + pz);

    // Every skirt vertex repeats an edge vertex, ten metres lower.
    const edge = new Map<string, number>();
    for (let i = 0; i < 25; i++) {
      edge.set(`${x(g, i)}:${z(g, i)}`, y(g, i));
    }
    for (let i = 25; i < 45; i++) {
      const top = edge.get(`${x(g, i)}:${z(g, i)}`);
      expect(top).toBeDefined();
      expect(y(g, i)).toBeCloseTo((top as number) - 10, 10);
    }
  });

  it('indexes the grid and the skirts', () => {
    const g = buildTileGeometry({ bounds: b, gridSize: 5, skirtDepth: 10 }, () => 0);
    const index = g.getIndex();
    expect(index).not.toBeNull();

    // 4×4 cells of two triangles, plus a quad along each of the four edges.
    expect(index?.count ?? 0).toBe(4 * 4 * 6 + 4 * 4 * 6);
  });

  it('winds the grid to look up and the skirts to look outwards', () => {
    const g = buildTileGeometry({ bounds: b, gridSize: 5, skirtDepth: 10 }, () => 0);
    g.computeVertexNormals();
    const n = g.getAttribute('normal');

    for (let row = 0; row < 5; row++) {
      for (let col = 0; col < 5; col++) {
        const i = row * 5 + col;
        const onEdge = row === 0 || row === 4 || col === 0 || col === 4;
        // The grid faces the sky; the edges carry the wall of the skirt too.
        expect(n.getY(i)).toBeGreaterThan(0);
        if (!onEdge) expect(n.getY(i)).toBeCloseTo(1, 6);
      }
    }
    // The skirt walls stand up, so their normals are horizontal.
    for (let i = 25; i < 45; i++) {
      expect(Math.abs(n.getY(i))).toBeCloseTo(0, 6);
    }
  });
});

describe('updateTileHeights', () => {
  it('updateTileHeights rewrites y without changing count', () => {
    const g = buildTileGeometry({ bounds: b, gridSize: 5, skirtDepth: 10 }, () => 0);
    updateTileHeights(g, { bounds: b, gridSize: 5, skirtDepth: 10 }, () => 5);

    expect(g.getAttribute('position').count).toBe(45);
    for (let i = 0; i < 25; i++) {
      expect(y(g, i)).toBeCloseTo(5, 10);
    }
    // The skirts follow their edge down.
    for (let i = 25; i < 45; i++) {
      expect(y(g, i)).toBeCloseTo(-5, 10);
    }
  });

  it('recomputes the bounding sphere', () => {
    const g = buildTileGeometry({ bounds: b, gridSize: 5, skirtDepth: 10 }, () => 0);
    const before = g.boundingSphere?.center.y ?? 0;
    updateTileHeights(g, { bounds: b, gridSize: 5, skirtDepth: 10 }, () => 500);
    // The whole tile moved up, so the sphere around it moved with it.
    expect(g.boundingSphere?.center.y ?? 0).toBeCloseTo(before + 500, 6);
  });
});

describe('TerrainTile', () => {
  const coord = { z: 14, x: 8550, y: 5784 };

  it('sits at the centre of its tile', () => {
    const tile = new TerrainTile(coord, b, new Atmosphere(), () => 0, 14);
    expect(tile.mesh.position.x).toBeCloseTo(50, 6);
    expect(tile.mesh.position.z).toBeCloseTo(50, 6);
    expect(tile.coord).toEqual(coord);
    expect(tile.bounds).toEqual(b);
    expect(tile.elevZoom).toBe(14);
    expect(tile.textureZoom).toBeNull();
    expect(tile.ready).toBe(false);
  });

  it('takes the texture as sRGB, unflipped', () => {
    const tile = new TerrainTile(coord, b, new Atmosphere(), () => 0, 14);
    const tex = new Texture();
    tile.setTexture(tex);

    expect(tex.colorSpace).toBe(SRGBColorSpace);
    expect(tex.flipY).toBe(false);
    const material = tile.mesh.material as MeshBasicMaterial;
    expect(material.map).toBe(tex);
    expect(tile.ready).toBe(true);
  });

  it('applies the atmosphere to the material once', () => {
    const atmo = new Atmosphere();
    const spy = vi.spyOn(atmo, 'applyTo');
    const tile = new TerrainTile(coord, b, atmo, () => 0, 14);

    tile.setTexture(new Texture());
    tile.setTexture(new Texture());
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('rebuilds the heights in place', () => {
    const tile = new TerrainTile(coord, b, new Atmosphere(), () => 0, 14);
    const gridSize = gridSizeForZoom(14);
    tile.rebuildHeights(() => 7, 12);

    expect(tile.elevZoom).toBe(12);
    const pos = tile.mesh.geometry.getAttribute('position');
    for (let i = 0; i < gridSize * gridSize; i++) {
      expect(pos.getY(i)).toBeCloseTo(7, 6);
    }
  });

  it('disposes the geometry and the material, but not the texture', () => {
    const tile = new TerrainTile(coord, b, new Atmosphere(), () => 0, 14);
    const tex = new Texture();
    const texSpy = vi.spyOn(tex, 'dispose');
    const geoSpy = vi.spyOn(tile.mesh.geometry, 'dispose');
    const matSpy = vi.spyOn(tile.mesh.material as MeshBasicMaterial, 'dispose');

    tile.setTexture(tex);
    tile.dispose();

    expect(geoSpy).toHaveBeenCalled();
    expect(matSpy).toHaveBeenCalled();
    expect(texSpy).not.toHaveBeenCalled();
  });
});
