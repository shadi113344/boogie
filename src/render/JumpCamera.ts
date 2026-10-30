/**
 * The first-person camera.
 *
 * During freefall the view is the jumper's own: the eye sits in the body and
 * looks along a line between the relative wind and the head, so the ground
 * fills the view in a belly and the sky fills it in the exit. The camera
 * shakes with the deceleration of the fall.
 *
 * The camera's own position is the position in the scene, so the caller puts
 * the rebasing of the world back in.
 */

import * as THREE from 'three';
import { type Vec3, add, cross, dot, normalize, scale, sub } from '@/sim/vec3';
import type { BodyFrame } from '@/sim/freefall/aero';

/** The angle of the view from the relative wind towards the head, in radians. */
const LOOK_FROM_WIND_RAD = (40 * Math.PI) / 180;

/** How far in front of the body the eye sits, in metres. */
const EYE_OFFSET_M = 0.15;

/** How far below the horizon the view looks under canopy, in radians. */
const CANOPY_PITCH_RAD = (15 * Math.PI) / 180;

/** How far the eye sits above the jumper's shoulders, in metres. */
const EYE_HEIGHT_M = 0.25;

/** The largest shake for one g of deceleration, in radians. */
const SHAKE_RAD_PER_G = (0.4 * Math.PI) / 180;

/** The frequency of the shake about the camera's own axes, in hertz. */
const SHAKE_YAW_HZ = 1.7;
const SHAKE_PITCH_HZ = 2.9;

/** The phase of the pitch of the shake, in radians. */
const SHAKE_PITCH_PHASE = 1.1;

/** Where the jumper is looking from, and which way is up. */
export interface CameraPose {
  position: Vec3;
  forward: Vec3;
  up: Vec3;
}

/**
 * The pose of the eye in a freefall.
 *
 * `airDir` is the direction the relative wind comes from: the direction the
 * body travels through the air, which is the body velocity less the wind's
 * own. In a belly at terminal that is straight down, because the wind comes
 * from below; in the exit it is the direction of the plane.
 *
 * The view looks 40 degrees from the wind towards the head, which puts the
 * ground 50 degrees below the horizon in a belly and the sky 40 degrees
 * above it in the exit. The screen's up is the head, made square to the
 * view.
 */
export function freefallEye(body: BodyFrame, airDir: Vec3, pos: Vec3): CameraPose {
  const air = normalize(airDir);
  const head = normalize(body.forward);

  const forward = normalize({
    x: air.x * Math.cos(LOOK_FROM_WIND_RAD) + head.x * Math.sin(LOOK_FROM_WIND_RAD),
    y: air.y * Math.cos(LOOK_FROM_WIND_RAD) + head.y * Math.sin(LOOK_FROM_WIND_RAD),
    z: air.z * Math.cos(LOOK_FROM_WIND_RAD) + head.z * Math.sin(LOOK_FROM_WIND_RAD),
  });

  // The head, made square to the view: the screen's up. When the head points
  // straight into the wind there is nothing left of it, and the back of the
  // body takes over.
  const up =
    perpendicular(head, forward) ??
    perpendicular(normalize(body.up), forward) ??
    anyPerpendicular(forward);

  return {
    position: add(pos, scale(head, EYE_OFFSET_M)),
    forward,
    up,
  };
}

/**
 * The pose of the eye under canopy.
 *
 * The jumper hangs from the risers, so the head tips with the swing: a
 * jumper swung ahead of the canopy has their head tipped back and looks
 * up, and a jumper hanging to the right of the canopy has their head tipped
 * to the left. The view looks fifteen degrees below the horizon along the
 * heading, and `lookUp` takes it up the lines instead, which is the canopy
 * check: the player tilts the phone back and looks at the wing.
 */
export function canopyEye(o: {
  pos: Vec3;
  headingRad: number;
  swingFore: number;
  swingSide: number;
  lookUp: number;
}): CameraPose {
  const lookUp = clamp01(o.lookUp);

  // The heading: the way the canopy is flying, on the level.
  const heading: Vec3 = { x: Math.sin(o.headingRad), y: 0, z: -Math.cos(o.headingRad) };

  // The body of the jumper: the head hangs from the risers, so it tips
  // forward when the jumper swings ahead of the canopy and to the left when
  // the jumper hangs to the right of it.
  const bodyForward = normalize({
    x: heading.x * Math.cos(o.swingFore),
    y: Math.sin(o.swingFore),
    z: heading.z * Math.cos(o.swingFore),
  });
  const aft: Vec3 = { x: -heading.x, y: 0, z: -heading.z };
  const tipped = normalize({
    x: aft.x * Math.sin(o.swingFore),
    y: Math.cos(o.swingFore),
    z: aft.z * Math.sin(o.swingFore),
  });
  const left = cross(tipped, bodyForward);
  const bodyUp = normalize({
    x: tipped.x * Math.cos(o.swingSide) + left.x * Math.sin(o.swingSide),
    y: tipped.y * Math.cos(o.swingSide) + left.y * Math.sin(o.swingSide),
    z: tipped.z * Math.cos(o.swingSide) + left.z * Math.sin(o.swingSide),
  });

  // The view: fifteen degrees below the body, swinging up the lines as the
  // player looks up.
  const base = normalize({
    x: bodyForward.x * Math.cos(CANOPY_PITCH_RAD) - bodyUp.x * Math.sin(CANOPY_PITCH_RAD),
    y: bodyForward.y * Math.cos(CANOPY_PITCH_RAD) - bodyUp.y * Math.sin(CANOPY_PITCH_RAD),
    z: bodyForward.z * Math.cos(CANOPY_PITCH_RAD) - bodyUp.z * Math.sin(CANOPY_PITCH_RAD),
  });
  const forward = slerp(base, bodyUp, lookUp);

  // The screen's up: the head while the player looks ahead, the way the
  // jumper was facing once they look up at the canopy.
  const wanted = slerp(bodyUp, bodyForward, lookUp);
  const up = perpendicular(wanted, forward) ?? anyPerpendicular(forward);

  return {
    position: { x: o.pos.x, y: o.pos.y + EYE_HEIGHT_M, z: o.pos.z },
    forward,
    up,
  };
}

/**
 * The pose of the eye through the opening.
 *
 * The opening starts with the jumper looking down at the ground and ends
 * with them looking ahead through the snivel, at the canopy and the world
 * beyond it. The inflation drives the swing from one to the other.
 */
export function openingEye(from: CameraPose, to: CameraPose, inflation: number): CameraPose {
  const t = clamp01(inflation);

  const forward = slerp(from.forward, to.forward, t);
  const up = perpendicular(slerp(from.up, to.up, t), forward) ?? anyPerpendicular(forward);

  return {
    position: {
      x: from.position.x + (to.position.x - from.position.x) * t,
      y: from.position.y + (to.position.y - from.position.y) * t,
      z: from.position.z + (to.position.z - from.position.z) * t,
    },
    forward,
    up,
  };
}

/**
 * The camera of the first-person view.
 *
 * The shake is a jitter of the camera's own axes, driven by the clock rather
 * than by a random number, so it is the same every time it is looked at and
 * it never jumps about between frames.
 */
export class JumpCamera {
  private readonly camera: THREE.PerspectiveCamera;

  private readonly timeSource: () => number;

  /**
   * @param camera The camera to drive.
   * @param timeSource Where the shake's time comes from, in seconds. A test
   *   puts its own clock here.
   */
  constructor(camera: THREE.PerspectiveCamera, timeSource: () => number = wallClock) {
    this.camera = camera;
    this.timeSource = timeSource;
  }

  /**
   * Put the camera where the pose says, and point it there.
   *
   * The position is the pose less the floating origin, so the caller puts
   * the rebasing of the world back in. `shakeG` is the deceleration of the
   * fall in g, which shakes the view.
   */
  apply(pose: CameraPose, originOffset: { x: number; z: number }, shakeG: number): void {
    const forward = normalize(pose.forward);

    this.camera.position.set(
      pose.position.x - originOffset.x,
      pose.position.y,
      pose.position.z - originOffset.z,
    );
    this.camera.up.set(pose.up.x, pose.up.y, pose.up.z);

    // The camera looks at the point a metre ahead of it.
    this.camera.lookAt(
      this.camera.position.x + forward.x,
      this.camera.position.y + forward.y,
      this.camera.position.z + forward.z,
    );

    this.shake(shakeG);
  }

  /** Jitter the camera about its own axes, with the deceleration. */
  private shake(shakeG: number): void {
    const amplitude = SHAKE_RAD_PER_G * Math.abs(shakeG);
    if (amplitude === 0) return;

    const t = this.timeSource();
    // Half the amplitude on each axis, so the whole shake stays inside it.
    const yaw = amplitude * 0.5 * Math.sin(2 * Math.PI * SHAKE_YAW_HZ * t);
    const pitch =
      amplitude * 0.5 * Math.sin(2 * Math.PI * SHAKE_PITCH_HZ * t + SHAKE_PITCH_PHASE);

    this.camera.rotateY(yaw);
    this.camera.rotateX(pitch);
  }
}

/** The part of `v` square to `axis`, or nothing when there is none. */
function perpendicular(v: Vec3, axis: Vec3): Vec3 | null {
  const part = sub(v, scale(axis, dot(v, axis)));
  if (Math.hypot(part.x, part.y, part.z) < 1e-6) return null;
  return normalize(part);
}

/**
 * The direction between two directions, the short way round.
 *
 * The two directions are unit vectors and the result is one: a camera
 * swinging from one to the other keeps the same speed the whole way, which
 * a straight line between the two would not.
 */
function slerp(a: Vec3, b: Vec3, t: number): Vec3 {
  const cos = Math.max(-1, Math.min(1, dot(a, b)));
  const theta = Math.acos(cos);
  if (theta < 1e-6) return normalize(lerp(a, b, t));

  const sinTheta = Math.sin(theta);
  const first = Math.sin((1 - t) * theta) / sinTheta;
  const second = Math.sin(t * theta) / sinTheta;
  return {
    x: a.x * first + b.x * second,
    y: a.y * first + b.y * second,
    z: a.z * first + b.z * second,
  };
}

/** The straight line between two vectors. */
function lerp(a: Vec3, b: Vec3, t: number): Vec3 {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t };
}

/** Keeps a number inside the range from zero to one. */
function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/** Any unit vector square to `axis`. */
function anyPerpendicular(axis: Vec3): Vec3 {
  const ax = Math.abs(axis.x);
  const ay = Math.abs(axis.y);
  const az = Math.abs(axis.z);
  const other: Vec3 =
    ax <= ay && ax <= az ? { x: 1, y: 0, z: 0 } : ay <= az ? { x: 0, y: 1, z: 0 } : { x: 0, y: 0, z: 1 };
  return perpendicular(other, axis) ?? { x: 0, y: 1, z: 0 };
}

/** The clock the shake runs on, in seconds. */
function wallClock(): number {
  if (typeof performance === 'undefined') return 0;
  return performance.now() / 1000;
}
