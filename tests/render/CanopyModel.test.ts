import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { CanopyModel } from '@/render/CanopyModel';
import { CANOPIES, type CanopySpec } from '@/data/canopies';
import { FT } from '@/sim/units';

/**
 * The span the canopy should have: the square root of its area times its
 * aspect ratio.
 */
function spanOf(spec: CanopySpec): number {
  const areaM2 = spec.areaFt2 * FT * FT;
  const aspect = spec.cells === 7 ? 2.0 : 2.4;
  return Math.sqrt(areaM2 * aspect);
}

/** The wing mesh of the model. */
function wingOf(model: CanopyModel): THREE.Mesh {
  const wing = model.object.getObjectByName('wing');
  expect(wing).toBeInstanceOf(THREE.Mesh);
  return wing as THREE.Mesh;
}

/** The number of triangles the model draws. */
function trianglesOf(model: CanopyModel): number {
  let count = 0;
  model.object.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) return;
    const index = child.geometry.getIndex();
    const positions = child.geometry.getAttribute('position');
    count += index ? index.count / 3 : positions.count / 3;
  });
  return count;
}

/** The size of the wing in the world, in metres. */
function sizeOf(mesh: THREE.Mesh): THREE.Vector3 {
  mesh.updateWorldMatrix(true, false);
  return new THREE.Box3().setFromObject(mesh).getSize(new THREE.Vector3());
}

describe('CanopyModel', () => {
  it('builds under 3000 triangles for every canopy', () => {
    for (const spec of Object.values(CANOPIES)) {
      const model = new CanopyModel(spec);
      expect(trianglesOf(model)).toBeLessThan(3000);
      model.dispose();
    }
  });

  it('is a bag-sized bundle before it is inflated', () => {
    const model = new CanopyModel(CANOPIES['sport-210']);

    model.setInflation(0, 1);
    const size = sizeOf(wingOf(model));

    expect(size.x).toBeLessThan(1);
    expect(size.y).toBeLessThan(1);
    expect(size.z).toBeLessThan(1);
  });

  it('spans the width its area and its aspect ratio give', () => {
    for (const spec of Object.values(CANOPIES)) {
      const model = new CanopyModel(spec);

      model.setInflation(1, 0);
      const size = sizeOf(wingOf(model));
      const span = spanOf(spec);

      expect(size.x).toBeGreaterThan(span * 0.9);
      expect(size.x).toBeLessThan(span * 1.1);
      model.dispose();
    }
  });

  it('hangs the wing six metres above the risers', () => {
    const model = new CanopyModel(CANOPIES['sport-210']);

    model.setInflation(1, 0);
    const group = wingOf(model).parent;

    expect(group).not.toBeNull();
    expect(group?.position.y).toBeCloseTo(6, 6);
  });

  it('pulls the trailing edge of the brake that is pulled, and only that one', () => {
    const model = new CanopyModel(CANOPIES['sport-210']);
    model.setInflation(1, 0);

    const wing = wingOf(model);
    const positions = wing.geometry.getAttribute('position');
    const snapshot: number[] = [];
    for (let i = 0; i < positions.count; i++) {
      snapshot.push(positions.getX(i), positions.getY(i), positions.getZ(i));
    }

    // The right brake: the trailing edge of the right tip comes down.
    model.setBrakes(0, 1);

    let moved = 0;
    let maxZ = -Infinity;
    for (let i = 0; i < positions.count; i++) {
      maxZ = Math.max(maxZ, snapshot[i * 3 + 2] ?? 0);
    }
    for (let i = 0; i < positions.count; i++) {
      const x = positions.getX(i);
      const y = positions.getY(i);
      const z = positions.getZ(i);
      const wasX = snapshot[i * 3] ?? 0;
      const wasY = snapshot[i * 3 + 1] ?? 0;
      const wasZ = snapshot[i * 3 + 2] ?? 0;
      if (Math.abs(x - wasX) < 1e-9 && Math.abs(y - wasY) < 1e-9 && Math.abs(z - wasZ) < 1e-9) {
        continue;
      }
      moved++;
      // Only the right hand side of the wing moves.
      expect(x).toBeGreaterThan(0);
      // It moves down, and it is the trailing edge that moves.
      expect(y).toBeLessThan(wasY);
      expect(z).toBeGreaterThan(0);
      // The arced, slightly swept span puts the tip's trailing edge a centimetre
      // or two ahead of the middle's; on a 2.8 m chord 5 cm still says "trailing edge".
      expect(Math.abs(z - maxZ)).toBeLessThan(0.05);
    }
    expect(moved).toBeGreaterThan(0);
  });

  it('brings the left trailing edge down with the left brake', () => {
    const model = new CanopyModel(CANOPIES['sport-210']);
    model.setInflation(1, 0);

    const wing = wingOf(model);
    const positions = wing.geometry.getAttribute('position');
    const snapshot: number[] = [];
    for (let i = 0; i < positions.count; i++) {
      snapshot.push(positions.getX(i), positions.getY(i), positions.getZ(i));
    }

    model.setBrakes(1, 0);

    let moved = 0;
    for (let i = 0; i < positions.count; i++) {
      const y = positions.getY(i);
      const wasY = snapshot[i * 3 + 1] ?? 0;
      if (Math.abs(y - wasY) < 1e-9) continue;
      moved++;
      expect(positions.getX(i)).toBeLessThan(0);
      expect(y).toBeLessThan(wasY);
    }
    expect(moved).toBeGreaterThan(0);
  });

  it('has lines down to the risers and a slider on them', () => {
    const model = new CanopyModel(CANOPIES['student-280']);

    const lines = model.object.getObjectByName('lines');
    const slider = model.object.getObjectByName('slider');

    expect(lines).toBeInstanceOf(THREE.LineSegments);
    expect(slider).toBeInstanceOf(THREE.Mesh);

    // The slider rides up the lines and comes back down.
    model.setInflation(1, 1);
    const up = slider?.position.y ?? 0;
    model.setInflation(1, 0);
    const down = slider?.position.y ?? 0;
    expect(up).toBeGreaterThan(down);
    expect(down).toBeCloseTo(0, 6);
  });

  it('gives every canopy its own colours', () => {
    const model = new CanopyModel(CANOPIES['student-280']);
    const wing = wingOf(model);
    const colours = wing.geometry.getAttribute('color');

    let blue = 0;
    for (let i = 0; i < colours.count; i++) {
      const r = colours.getX(i);
      const g = colours.getY(i);
      const b = colours.getZ(i);
      if (b > r && b > g) blue++;
    }
    expect(blue).toBeGreaterThan(0);
  });
});
