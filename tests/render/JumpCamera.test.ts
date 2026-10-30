import { describe, it, expect } from 'vitest';
import { PerspectiveCamera, Vector3 } from 'three';
import { freefallEye, JumpCamera, type CameraPose } from '@/render/JumpCamera';
import type { BodyFrame } from '@/sim/freefall/aero';

const NORTH = { x: 0, y: 0, z: -1 };
const UP = { x: 0, y: 1, z: 0 };
const DEG = Math.PI / 180;

/** How far the view is off the horizon, in degrees, positive above it. */
function pitchDeg(forward: { x: number; y: number; z: number }): number {
  return Math.atan2(forward.y, Math.hypot(forward.x, forward.z)) / DEG;
}

describe('freefallEye', () => {
  it('puts the eye in front of the body', () => {
    const body: BodyFrame = { forward: NORTH, up: UP };
    const pose = freefallEye(body, { x: 0, y: -1, z: 0 }, { x: 10, y: 1000, z: 20 });

    expect(pose.position.x).toBeCloseTo(10, 9);
    expect(pose.position.y).toBeCloseTo(1000, 9);
    expect(pose.position.z).toBeCloseTo(19.85, 9);
  });

  it('looks north and 50 degrees below the horizon in a belly at terminal', () => {
    const body: BodyFrame = { forward: NORTH, up: UP };
    // The wind comes from below: the body falls straight down through it.
    const pose = freefallEye(body, { x: 0, y: -1, z: 0 }, { x: 0, y: 1000, z: 0 });

    // North: the horizontal part of the view points north.
    expect(pose.forward.x).toBeCloseTo(0, 6);
    expect(pose.forward.z).toBeLessThan(0);
    // Fifty degrees below the horizon.
    expect(pitchDeg(pose.forward)).toBeLessThan(-49);
    expect(pitchDeg(pose.forward)).toBeGreaterThan(-51);
    // The screen's up is up, and towards the north.
    expect(pose.up.y).toBeGreaterThan(0);
    expect(pose.up.z).toBeLessThan(0);
    // The up is square to the view.
    const along =
      pose.up.x * pose.forward.x +
      pose.up.y * pose.forward.y +
      pose.up.z * pose.forward.z;
    expect(along).toBeCloseTo(0, 9);
  });

  it('looks north and 40 degrees above the horizon at the exit', () => {
    const body: BodyFrame = { forward: UP, up: NORTH };
    // Head up in the jump run, with the wind from the north.
    const pose = freefallEye(body, NORTH, { x: 0, y: 1000, z: 0 });

    expect(pose.forward.x).toBeCloseTo(0, 6);
    expect(pose.forward.z).toBeLessThan(0);
    expect(pitchDeg(pose.forward)).toBeGreaterThan(39);
    expect(pitchDeg(pose.forward)).toBeLessThan(41);
    expect(pose.up.y).toBeGreaterThan(0);
  });

  it('keeps the view and the up square when the head points into the wind', () => {
    const body: BodyFrame = { forward: { x: 0, y: -1, z: 0 }, up: NORTH };
    const pose = freefallEye(body, { x: 0, y: -1, z: 0 }, { x: 0, y: 1000, z: 0 });

    expect(Math.hypot(pose.forward.x, pose.forward.y, pose.forward.z)).toBeCloseTo(1, 9);
    expect(Math.hypot(pose.up.x, pose.up.y, pose.up.z)).toBeCloseTo(1, 9);
    const along =
      pose.up.x * pose.forward.x +
      pose.up.y * pose.forward.y +
      pose.up.z * pose.forward.z;
    expect(along).toBeCloseTo(0, 9);
  });
});

describe('JumpCamera', () => {
  const pose: CameraPose = {
    position: { x: 1200, y: 900, z: -400 },
    forward: { x: 0, y: 0, z: -1 },
    up: { x: 0, y: 1, z: 0 },
  };

  it('puts the camera at the pose, less the floating origin', () => {
    const camera = new PerspectiveCamera();
    const jump = new JumpCamera(camera);

    jump.apply(pose, { x: 100, z: -50 }, 0);

    expect(camera.position.x).toBeCloseTo(1100, 9);
    expect(camera.position.y).toBeCloseTo(900, 9);
    expect(camera.position.z).toBeCloseTo(-350, 9);
  });

  it('looks along the pose, with the pose up', () => {
    const camera = new PerspectiveCamera();
    const jump = new JumpCamera(camera);

    jump.apply(pose, { x: 0, z: 0 }, 0);

    const direction = camera.getWorldDirection(new Vector3());
    expect(direction.x).toBeCloseTo(0, 6);
    expect(direction.y).toBeCloseTo(0, 6);
    expect(direction.z).toBeCloseTo(-1, 6);
    expect(camera.up.x).toBeCloseTo(0, 9);
    expect(camera.up.y).toBeCloseTo(1, 9);
    expect(camera.up.z).toBeCloseTo(0, 9);
  });

  it('shakes by at most 0.4 degrees a g', () => {
    const camera = new PerspectiveCamera();
    const jump = new JumpCamera(camera, () => 0.37);

    jump.apply(pose, { x: 0, z: 0 }, 0);
    const still = camera.getWorldDirection(new Vector3());
    jump.apply(pose, { x: 0, z: 0 }, 1);
    const shaken = camera.getWorldDirection(new Vector3());

    const moved = still.angleTo(shaken) / DEG;
    expect(moved).toBeGreaterThan(0);
    expect(moved).toBeLessThanOrEqual(0.4 + 1e-6);
  });

  it('shakes the same way at the same moment, and differently later', () => {
    const camera = new PerspectiveCamera();
    let clock = 1.25;
    const jump = new JumpCamera(camera, () => clock);

    jump.apply(pose, { x: 0, z: 0 }, 1);
    const first = camera.getWorldDirection(new Vector3());
    jump.apply(pose, { x: 0, z: 0 }, 1);
    const again = camera.getWorldDirection(new Vector3());
    clock = 1.75;
    jump.apply(pose, { x: 0, z: 0 }, 1);
    const later = camera.getWorldDirection(new Vector3());

    expect(first.angleTo(again)).toBeCloseTo(0, 9);
    expect(first.angleTo(later)).toBeGreaterThan(0);
  });

  it('does not shake when there is no deceleration', () => {
    const camera = new PerspectiveCamera();
    const jump = new JumpCamera(camera, () => 0.37);

    jump.apply(pose, { x: 0, z: 0 }, 0);
    const still = camera.getWorldDirection(new Vector3());
    jump.apply(pose, { x: 0, z: 0 }, 0);
    const again = camera.getWorldDirection(new Vector3());

    expect(still.angleTo(again)).toBeCloseTo(0, 9);
  });
});
