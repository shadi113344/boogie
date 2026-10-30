import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { FreeCamera } from '@/render/FreeCamera';

/**
 * Dispatch a pointer event on an element.
 *
 * The pointer id is attached by hand, so the camera sees the same events on
 * every browser that runs the tests.
 */
function pointer(el: HTMLElement, type: string, x: number, y: number, id: number): void {
  const event = new MouseEvent(type, { clientX: x, clientY: y, bubbles: true });
  Object.defineProperty(event, 'pointerId', { value: id });
  el.dispatchEvent(event);
}

interface Fixture {
  camera: THREE.PerspectiveCamera;
  free: FreeCamera;
  dom: HTMLElement;
}

/** A camera over a flat ground, with the element that takes the pointers. */
function makeCamera(groundY: (x: number, z: number) => number = () => 0): Fixture {
  const camera = new THREE.PerspectiveCamera(60, 1, 1, 1000);
  const dom = document.createElement('div');
  document.body.appendChild(dom);
  const free = new FreeCamera(camera, dom, groundY);
  return { camera, free, dom };
}

/** Press and release a key. */
function key(type: 'keydown' | 'keyup', name: string): void {
  window.dispatchEvent(new KeyboardEvent(type, { key: name }));
}

describe('FreeCamera', () => {
  it('never goes below the ground', () => {
    const { camera, free } = makeCamera(() => 100);

    free.setPose(0, 50, 0, 0, 0);
    free.update(0.016);

    expect(camera.position.y).toBeGreaterThanOrEqual(102);
  });

  it('reports the height above the ground', () => {
    const { free } = makeCamera(() => 100);

    free.setPose(0, 150, 0, 0, 0);
    free.update(0.016);

    expect(free.agl).toBeCloseTo(50, 6);
  });

  it('one-pointer drag changes yaw and pitch', () => {
    const { free, dom } = makeCamera();

    free.setPose(0, 100, 0, 0, 0);
    pointer(dom, 'pointerdown', 100, 100, 1);
    pointer(dom, 'pointermove', 200, 150, 1);
    pointer(dom, 'pointerup', 200, 150, 1);

    // Dragging right turns right, dragging down looks down.
    expect(free.yaw).toBeCloseTo(-0.4, 6);
    expect(free.pitch).toBeCloseTo(-0.2, 6);
  });

  it('clamps the pitch', () => {
    const { free, dom } = makeCamera();

    free.setPose(0, 100, 0, 0, 0);
    pointer(dom, 'pointerdown', 100, 100, 1);
    pointer(dom, 'pointermove', 100, 1000, 1);

    expect(free.pitch).toBeCloseTo(-1.5, 6);
  });

  it('flies forward with the keyboard and faster with the shift key', () => {
    const { camera, free } = makeCamera();

    free.setPose(0, 100, 0, 0, 0);

    key('keydown', 'w');
    free.update(0.1);
    key('keyup', 'w');

    // Fifty metres above the ground, the camera flies at fifty metres a second.
    expect(camera.position.z).toBeCloseTo(-5, 6);
    expect(camera.position.x).toBeCloseTo(0, 6);

    key('keydown', 'w');
    key('keydown', 'Shift');
    free.update(0.1);
    key('keyup', 'w');
    key('keyup', 'Shift');

    expect(camera.position.z).toBeCloseTo(-25, 6);
  });

  it('moves with two pointers: the centroid flies, the pinch changes the height', () => {
    const { camera, free, dom } = makeCamera();

    free.setPose(0, 100, 0, 0, 0);
    pointer(dom, 'pointerdown', 100, 100, 1);
    pointer(dom, 'pointerdown', 200, 100, 2);

    // Both fingers move down and to the right by fifty pixels.
    pointer(dom, 'pointermove', 150, 150, 1);
    pointer(dom, 'pointermove', 250, 150, 2);

    // The centroid went right and forward, the pinch did not change.
    expect(camera.position.x).toBeCloseTo(25, 6);
    expect(camera.position.z).toBeCloseTo(-25, 6);
    expect(camera.position.y).toBeCloseTo(100, 6);
  });

  it('does not turn the camera while two pointers are down', () => {
    const { free, dom } = makeCamera();

    free.setPose(0, 100, 0, 0, 0);
    pointer(dom, 'pointerdown', 100, 100, 1);
    pointer(dom, 'pointerdown', 200, 100, 2);
    pointer(dom, 'pointermove', 300, 300, 1);

    expect(free.yaw).toBeCloseTo(0, 6);
    expect(free.pitch).toBeCloseTo(0, 6);
  });

  it('remembers that the user has moved the camera', () => {
    const { free, dom } = makeCamera();

    expect(free.userMoved).toBe(false);

    pointer(dom, 'pointerdown', 100, 100, 1);
    expect(free.userMoved).toBe(true);

    // The flag is never taken back: the user has been here.
    pointer(dom, 'pointerup', 100, 100, 1);
    expect(free.userMoved).toBe(true);
  });

  it('remembers that the user has moved the camera with the keyboard', () => {
    const { free } = makeCamera();

    expect(free.userMoved).toBe(false);

    key('keydown', 'w');
    expect(free.userMoved).toBe(true);

    key('keyup', 'w');
    expect(free.userMoved).toBe(true);
  });

  it('lets go of its listeners when it is disposed', () => {
    const { free, dom } = makeCamera();

    free.setPose(0, 100, 0, 0, 0);
    free.dispose();

    pointer(dom, 'pointerdown', 100, 100, 1);
    pointer(dom, 'pointermove', 200, 150, 1);

    expect(free.yaw).toBeCloseTo(0, 6);
    expect(free.pitch).toBeCloseTo(0, 6);
  });
});
