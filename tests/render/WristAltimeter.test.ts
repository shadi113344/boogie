import { describe, it, expect } from 'vitest';
import { Mesh, Object3D } from 'three';
import { needleAngleRad, WristAltimeter } from '@/render/WristAltimeter';
import { FT } from '@/sim/units';

describe('needleAngleRad', () => {
  it('reads zero on the landing area', () => {
    expect(needleAngleRad(0, 'ft')).toBeCloseTo(0, 9);
    expect(needleAngleRad(0, 'm')).toBeCloseTo(0, 9);
  });

  it('is half a turn at 6,000 feet', () => {
    expect(needleAngleRad(6000 * FT, 'ft')).toBeCloseTo(Math.PI, 9);
  });

  it('wraps round after a full turn of 12,000 feet', () => {
    expect(needleAngleRad(13500 * FT, 'ft')).toBeCloseTo(Math.PI / 4, 9);
    expect(needleAngleRad(12000 * FT, 'ft')).toBeCloseTo(0, 9);
  });

  it('is half a turn at 2,000 metres', () => {
    expect(needleAngleRad(2000, 'm')).toBeCloseTo(Math.PI, 9);
  });

  it('turns clockwise, so the needle always sits inside one turn', () => {
    for (let ft = 0; ft <= 20000; ft += 250) {
      const angle = needleAngleRad(ft * FT, 'ft');
      expect(angle).toBeGreaterThanOrEqual(0);
      expect(angle).toBeLessThan(2 * Math.PI);
    }
  });
});

describe('WristAltimeter', () => {
  it('sits at the lower left, a third of a metre ahead', () => {
    const altimeter = new WristAltimeter('ft');

    expect(altimeter.object.position.x).toBeCloseTo(-0.09, 6);
    expect(altimeter.object.position.y).toBeCloseTo(-0.11, 6);
    expect(altimeter.object.position.z).toBeCloseTo(-0.3, 6);
  });

  it('turns the needle to the altitude', () => {
    const altimeter = new WristAltimeter('ft');
    const needle = altimeter.object.getObjectByName('needle');
    expect(needle).toBeInstanceOf(Mesh);

    altimeter.setAltitude(13500 * FT);

    expect((needle as Mesh).rotation.z).toBeCloseTo(-needleAngleRad(13500 * FT, 'ft'), 9);
  });

  it('turns the needle the other way on the way down', () => {
    const altimeter = new WristAltimeter('ft');
    const needle = altimeter.object.getObjectByName('needle') as Mesh;

    altimeter.setAltitude(3500 * FT);
    const high = needle.rotation.z;
    altimeter.setAltitude(1000 * FT);
    const low = needle.rotation.z;

    expect(high).not.toBeCloseTo(low, 6);
    expect(low).toBeCloseTo(-needleAngleRad(1000 * FT, 'ft'), 9);
  });

  it('has a strap, a bezel, a face and a needle', () => {
    const altimeter = new WristAltimeter('m');

    expect(altimeter.object.getObjectByName('band')).toBeInstanceOf(Mesh);
    expect(altimeter.object.getObjectByName('bezel')).toBeInstanceOf(Mesh);
    expect(altimeter.object.getObjectByName('face')).toBeInstanceOf(Mesh);
    expect(altimeter.object.getObjectByName('needle')).toBeInstanceOf(Mesh);
  });

  it('keeps the face when the canvas has no drawing context', () => {
    const altimeter = new WristAltimeter('ft');
    const face = altimeter.object.getObjectByName('face') as Mesh;

    expect(face).toBeInstanceOf(Mesh);
    expect(face.geometry).toBeTruthy();
  });

  it('is under 200 triangles', () => {
    const altimeter = new WristAltimeter('ft');

    let triangles = 0;
    altimeter.object.traverse((child: Object3D) => {
      const mesh = child as Mesh;
      const geometry = mesh.geometry as { index?: { count: number } } | undefined;
      if (!geometry) return;
      const count = geometry.index ? geometry.index.count : 0;
      triangles += count / 3;
    });

    expect(triangles).toBeLessThan(200);
  });

  it('is about six centimetres across', () => {
    const altimeter = new WristAltimeter('ft');
    const face = altimeter.object.getObjectByName('face') as Mesh;
    const radius = (face.geometry as { parameters?: { radius?: number } }).parameters?.radius ?? 0;

    expect(radius).toBeGreaterThan(0.025);
    expect(radius).toBeLessThan(0.032);
  });
});
