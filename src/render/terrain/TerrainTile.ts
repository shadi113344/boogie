/**
 * The geometry and the material of one terrain tile.
 *
 * A tile is a regular grid of vertices draped over the heights the caller
 * samples, plus a skirt: a ring of vertices that repeats the four edges a
 * little lower down, so a gap between neighbouring tiles shows the skirt
 * instead of the sky.
 *
 * The vertices are relative to the centre of the tile, which keeps the
 * numbers small enough to stay exact in single precision; the mesh itself is
 * placed at the centre of the tile in the local frame.
 */

import * as THREE from 'three';
import type { TileCoord } from '../../world/geo';
import type { Atmosphere } from '../Atmosphere';

/** The edges of a tile in the local frame, in metres. */
export interface TileBounds {
  minX: number;
  maxX: number;
  /** The north edge: the smaller z, because z runs south. */
  minZ: number;
  maxZ: number;
}

/**
 * Vertices per side of a tile, by zoom.
 *
 * Fine tiles get a dense grid, coarse ones stay cheap: a tile of the far
 * horizon does not need to describe every bump of the ground.
 */
export function gridSizeForZoom(z: number): number {
  if (z >= 16) return 65;
  if (z >= 12) return 33;
  return 17;
}

export interface TileGeometryOptions {
  bounds: TileBounds;
  /** Vertices per side of the grid. */
  gridSize: number;
  /** How far the skirt hangs below the edge, in metres. */
  skirtDepth: number;
}

/** The skirt reaches two percent of the way across the tile. */
const SKIRT_FRACTION = 0.02;

/** The centre of a tile in the local frame. */
function tileCentre(bounds: TileBounds): { x: number; z: number } {
  return { x: (bounds.minX + bounds.maxX) / 2, z: (bounds.minZ + bounds.maxZ) / 2 };
}

/** The world x of a grid column. */
function columnX(bounds: TileBounds, gridSize: number, col: number): number {
  return bounds.minX + (col * (bounds.maxX - bounds.minX)) / (gridSize - 1);
}

/** The world z of a grid row, counted from the north edge. */
function rowZ(bounds: TileBounds, gridSize: number, row: number): number {
  return bounds.minZ + (row * (bounds.maxZ - bounds.minZ)) / (gridSize - 1);
}

/**
 * The grid indices of the four edges, in the order the skirt walks them:
 * north, east, south, west. Each edge runs so that the skirt faces away
 * from the tile.
 */
function edgeIndices(gridSize: number): number[][] {
  const north: number[] = [];
  const east: number[] = [];
  const south: number[] = [];
  const west: number[] = [];
  for (let i = 0; i < gridSize; i++) {
    north.push(i); // the north edge, west to east
    east.push(i * gridSize + (gridSize - 1)); // the east edge, north to south
    south.push((gridSize - 1) * gridSize + (gridSize - 1 - i)); // the south edge, east to west
    west.push((gridSize - 1 - i) * gridSize); // the west edge, south to north
  }
  return [north, east, south, west];
}

/**
 * The mesh of one tile: a grid of vertices draped over the heights, with a
 * skirt around the edge.
 *
 * The positions are relative to the centre of the tile. The heights are the
 * absolute ones the caller samples, curvature included.
 */
export function buildTileGeometry(
  opts: TileGeometryOptions,
  heightAt: (x: number, z: number) => number,
): THREE.BufferGeometry {
  const { bounds, gridSize, skirtDepth } = opts;
  const centre = tileCentre(bounds);
  const gridCount = gridSize * gridSize;
  const vertexCount = gridCount + 4 * gridSize;

  const position = new THREE.BufferAttribute(new Float32Array(vertexCount * 3), 3);
  // The heights are rewritten as finer elevation tiles arrive.
  position.setUsage(THREE.DynamicDrawUsage);
  const uv = new THREE.BufferAttribute(new Float32Array(vertexCount * 2), 2);

  // The grid: row by row, from the north edge to the south edge.
  for (let row = 0; row < gridSize; row++) {
    const z = rowZ(bounds, gridSize, row);
    for (let col = 0; col < gridSize; col++) {
      const x = columnX(bounds, gridSize, col);
      const i = row * gridSize + col;
      position.setXYZ(i, x - centre.x, heightAt(x, z), z - centre.z);
      uv.setXY(i, col / (gridSize - 1), row / (gridSize - 1));
    }
  }

  // The skirt: every edge vertex repeated, `skirtDepth` lower down.
  const edges = edgeIndices(gridSize);
  let skirt = gridCount;
  for (const edge of edges) {
    for (const i of edge) {
      position.setXYZ(skirt, position.getX(i), position.getY(i) - skirtDepth, position.getZ(i));
      uv.setXY(skirt, uv.getX(i), uv.getY(i));
      skirt++;
    }
  }

  const indices: number[] = [];

  // The grid: two triangles per cell, wound so the face looks up.
  for (let row = 0; row < gridSize - 1; row++) {
    for (let col = 0; col < gridSize - 1; col++) {
      const nw = row * gridSize + col;
      const ne = nw + 1;
      const sw = nw + gridSize;
      const se = sw + 1;
      indices.push(nw, sw, ne, ne, sw, se);
    }
  }

  // The skirts: a quad per edge segment, hanging down and facing outwards.
  let base = gridCount;
  for (const edge of edges) {
    let previous = -1;
    let bottom = base;
    for (const top of edge) {
      if (previous >= 0) {
        // The top edge of the wall, then the wall itself.
        indices.push(previous, top, bottom - 1, top, bottom, bottom - 1);
      }
      previous = top;
      bottom++;
    }
    base += edge.length;
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', position);
  geometry.setAttribute('uv', uv);
  geometry.setIndex(indices);
  geometry.computeBoundingSphere();
  return geometry;
}

/**
 * Rewrite the heights of a tile in place, for when a finer elevation tile
 * arrives. The skirt follows its edge down.
 */
export function updateTileHeights(
  geo: THREE.BufferGeometry,
  opts: TileGeometryOptions,
  heightAt: (x: number, z: number) => number,
): void {
  const { bounds, gridSize, skirtDepth } = opts;
  const position = geo.getAttribute('position');
  const gridCount = gridSize * gridSize;
  const vertexCount = gridCount + 4 * gridSize;

  if (position.count < vertexCount) {
    throw new RangeError(
      `tile geometry holds ${position.count} vertices, expected at least ${vertexCount}`,
    );
  }

  for (let row = 0; row < gridSize; row++) {
    const z = rowZ(bounds, gridSize, row);
    for (let col = 0; col < gridSize; col++) {
      const x = columnX(bounds, gridSize, col);
      position.setY(row * gridSize + col, heightAt(x, z));
    }
  }

  let skirt = gridCount;
  for (const edge of edgeIndices(gridSize)) {
    for (const i of edge) {
      position.setY(skirt, position.getY(i) - skirtDepth);
      skirt++;
    }
  }

  position.needsUpdate = true;
  geo.computeBoundingSphere();
}

/**
 * One tile of terrain: the mesh, the imagery on it and the heights under it.
 *
 * The texture belongs to the tile cache, so disposing the tile leaves the
 * texture alone.
 */
export class TerrainTile {
  readonly coord: TileCoord;

  readonly bounds: TileBounds;

  readonly mesh: THREE.Mesh;

  /** The zoom of the elevation tile the heights came from. */
  elevZoom: number;

  /** The zoom of the imagery on the tile, once it is known. */
  textureZoom: number | null = null;

  private readonly geometry: THREE.BufferGeometry;

  private readonly material: THREE.MeshBasicMaterial;

  private readonly geometryOptions: TileGeometryOptions;

  private readonly atmo: Atmosphere;

  private atmosphereApplied = false;

  private textured = false;

  constructor(
    coord: TileCoord,
    bounds: TileBounds,
    atmo: Atmosphere,
    heightAt: (x: number, z: number) => number,
    elevZoom: number,
  ) {
    this.coord = coord;
    this.bounds = bounds;
    this.atmo = atmo;
    this.elevZoom = elevZoom;

    this.geometryOptions = {
      bounds,
      gridSize: gridSizeForZoom(coord.z),
      skirtDepth: (bounds.maxX - bounds.minX) * SKIRT_FRACTION,
    };

    this.geometry = buildTileGeometry(this.geometryOptions, heightAt);
    // Unlit: the terrain takes its colour from the imagery alone.
    this.material = new THREE.MeshBasicMaterial();

    const centre = tileCentre(bounds);
    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.position.set(centre.x, 0, centre.z);
    this.mesh.name = `tile ${coord.z}/${coord.x}/${coord.y}`;
  }

  /**
   * Put the imagery on the tile. The imagery is sRGB and comes from the top
   * left, so the texture is not flipped; the anisotropy is the caller's
   * business, because it depends on the renderer.
   */
  setTexture(tex: THREE.Texture): void {
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.flipY = false;

    this.material.map = tex;
    this.material.needsUpdate = true;

    // The atmosphere patches the shader; it only has to happen once.
    if (!this.atmosphereApplied) {
      this.atmo.applyTo(this.material);
      this.atmosphereApplied = true;
    }

    this.textured = true;
  }

  /** Re-drape the tile over the heights of a finer elevation tile. */
  rebuildHeights(heightAt: (x: number, z: number) => number, elevZoom: number): void {
    this.elevZoom = elevZoom;
    updateTileHeights(this.geometry, this.geometryOptions, heightAt);
  }

  /** True once the tile has imagery to show. */
  get ready(): boolean {
    return this.textured;
  }

  /** Let go of the geometry and the material. The texture belongs to the cache. */
  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }
}
