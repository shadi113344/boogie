import { describe, it, expect } from 'vitest';
import { Group, PerspectiveCamera } from 'three';
import { FloatingOrigin } from '@/render/FloatingOrigin';

describe('FloatingOrigin', () => {
  it('rebases when the camera passes the threshold', () => {
    const world = new Group();
    const camera = new PerspectiveCamera();
    camera.position.set(2500, 100, -300);
    const origin = new FloatingOrigin(world);

    expect(origin.update(camera)).toBe(true);
    expect(origin.offset).toEqual({ x: 2500, z: -300 });
    expect(camera.position.x).toBe(0);
    expect(camera.position.z).toBe(0);
    expect(world.position.x).toBe(-2500);
    expect(world.position.z).toBe(300);
    expect(origin.truePosition(camera)).toEqual({ x: 2500, y: 100, z: -300 });
  });

  it('does not rebase inside the threshold', () => {
    const world = new Group();
    const camera = new PerspectiveCamera();
    camera.position.set(500, 100, 0);
    const origin = new FloatingOrigin(world);

    expect(origin.update(camera)).toBe(false);
    expect(origin.offset).toEqual({ x: 0, z: 0 });
    expect(camera.position.x).toBe(500);
    expect(camera.position.z).toBe(0);
    expect(world.position.x).toBe(0);
    expect(world.position.z).toBe(0);
  });

  it('keeps the true position over several rebases', () => {
    const world = new Group();
    const camera = new PerspectiveCamera();
    const origin = new FloatingOrigin(world);

    camera.position.set(3000, 500, 0);
    origin.update(camera);
    camera.position.set(2500, 500, 0);
    origin.update(camera);
    camera.position.set(-2600, 500, 0);
    origin.update(camera);

    expect(origin.offset).toEqual({ x: 2900, z: 0 });
    expect(camera.position.x).toBe(0);
    expect(world.position.x).toBe(-2900);
    expect(origin.truePosition(camera)).toEqual({ x: 2900, y: 500, z: 0 });
  });

  it('honours a custom threshold', () => {
    const world = new Group();
    const camera = new PerspectiveCamera();
    camera.position.set(120, 10, 0);
    const origin = new FloatingOrigin(world, 100);

    expect(origin.update(camera)).toBe(true);
    expect(origin.offset).toEqual({ x: 120, z: 0 });
  });

  it('leaves the height alone', () => {
    const world = new Group();
    const camera = new PerspectiveCamera();
    camera.position.set(2500, 4115, 0);
    const origin = new FloatingOrigin(world);

    origin.update(camera);
    expect(camera.position.y).toBe(4115);
    expect(origin.truePosition(camera).y).toBe(4115);
    expect(world.position.y).toBe(0);
  });
});
