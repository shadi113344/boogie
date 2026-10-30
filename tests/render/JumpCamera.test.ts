import { describe, it, expect } from 'vitest';
import { PerspectiveCamera, Vector3 } from 'three';
import {
  canopyEye,
  freefallEye,
  JumpCamera,
  openingEye,
  type CameraPose,
} from '@/render/JumpCamera';
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

describe('canopyEye', () => {
  const here = { x: 0, y: 1000, z: 0 };

  it('looks 15 degrees below the horizon along the heading', () => {
    const pose = canopyEye({
      pos: here,
      headingRad: 0,
      swingFore: 0,
      swingSide: 0,
      lookUp: 0,
    });

    expect(pitchDeg(pose.forward)).toBeGreaterThan(-16);
    expect(pitchDeg(pose.forward)).toBeLessThan(-14);
    // Along the heading: north.
    expect(pose.forward.z).toBeLessThan(0);
    expect(Math.abs(pose.forward.x)).toBeLessThan(1e-9);
  });

  it('looks along the heading it is given', () => {
    const pose = canopyEye({
      pos: here,
      headingRad: 90 * DEG,
      swingFore: 0,
      swingSide: 0,
      lookUp: 0,
    });

    // East.
    expect(pose.forward.x).toBeGreaterThan(0.9);
    expect(Math.abs(pose.forward.z)).toBeLessThan(0.1);
  });

  it('puts the eye a quarter of a metre above the jumper', () => {
    const pose = canopyEye({
      pos: { x: 10, y: 1000, z: 20 },
      headingRad: 0,
      swingFore: 0,
      swingSide: 0,
      lookUp: 0,
    });

    expect(pose.position.x).toBeCloseTo(10, 9);
    expect(pose.position.y).toBeCloseTo(1000.25, 9);
    expect(pose.position.z).toBeCloseTo(20, 9);
  });

  it('looks straight up the lines when the player looks up', () => {
    const pose = canopyEye({
      pos: here,
      headingRad: 0,
      swingFore: 0,
      swingSide: 0,
      lookUp: 1,
    });

    const fromUp = (Math.acos(pose.forward.y) / DEG);
    expect(fromUp).toBeLessThan(10);
    // The world is still upright: the up of the screen is the heading.
    expect(pose.up.z).toBeLessThan(0);
  });

  it('tips the view with the swing', () => {
    const still = canopyEye({
      pos: here,
      headingRad: 0,
      swingFore: 0,
      swingSide: 0,
      lookUp: 0,
    });
    const swung = canopyEye({
      pos: here,
      headingRad: 0,
      swingFore: 15 * DEG,
      swingSide: 0,
      lookUp: 0,
    });

    // The jumper swung ahead of the canopy has their head tipped back.
    expect(pitchDeg(swung.forward)).toBeGreaterThan(pitchDeg(still.forward));
  });

  it('keeps the up square to the view', () => {
    const pose = canopyEye({
      pos: here,
      headingRad: 30 * DEG,
      swingFore: 5 * DEG,
      swingSide: 5 * DEG,
      lookUp: 0.4,
    });

    const along =
      pose.up.x * pose.forward.x +
      pose.up.y * pose.forward.y +
      pose.up.z * pose.forward.z;
    expect(along).toBeCloseTo(0, 9);
  });
});

describe('openingEye', () => {
  const from: CameraPose = {
    position: { x: 0, y: 1000, z: 0 },
    forward: { x: 0, y: -1, z: 0 },
    up: { x: 0, y: 0, z: -1 },
  };
  const to: CameraPose = {
    position: { x: 0, y: 1000, z: 0 },
    forward: { x: 0, y: -0.2, z: -0.98 },
    up: { x: 0, y: 0.98, z: -0.2 },
  };

  it('looks down at the start and ahead at the end', () => {
    const start = openingEye(from, to, 0);
    expect(start.forward.y).toBeCloseTo(-1, 6);

    const end = openingEye(from, to, 1);
    expect(end.forward.z).toBeCloseTo(to.forward.z, 6);
    expect(end.forward.y).toBeCloseTo(to.forward.y, 6);
  });

  it('swings through the snivel on the way', () => {
    const middle = openingEye(from, to, 0.5);

    expect(middle.forward.y).toBeLessThan(0);
    expect(middle.forward.z).toBeLessThan(0);
    expect(middle.forward.y).toBeGreaterThan(-1);
  });

  it('keeps the up square to the view', () => {
    const middle = openingEye(from, to, 0.5);

    const along =
      middle.up.x * middle.forward.x +
      middle.up.y * middle.forward.y +
      middle.up.z * middle.forward.z;
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
