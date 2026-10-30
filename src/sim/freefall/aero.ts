/**
 * The air forces on a freefalling body.
 *
 * One model covers the belly box and the jumpsuit track: the body is a
 * lifting plate whose area and polar come from the kit and the position,
 * and the forces follow from the attitude against the relative wind. The
 * player's inputs set that attitude, never the flight path. This module
 * imports nothing from three.js or the DOM.
 */

import { type Vec3, dot, length, normalize, scale, sub } from '../vec3';

/**
 * The belly box: a flat body that flies at a low angle of attack and turns
 * its pitch into a little drive.
 */
export const BELLY = {
  /** The drag area of a flat belly box, in m². */
  cdaNeutral: 0.55,
  /** The drag area of a hard arch, in m². */
  cdaArch: 0.45,
  /** The drag area of a de-arched body, in m². */
  cdaDeArch: 0.68,
  /** How much of the sideways force the belly makes into drive. */
  driveLift: 0.24,
  /** The pitch of the full forward drive, in radians. */
  maxPitchRad: (25 * Math.PI) / 180,
};

/**
 * The flat track in a jumpsuit: a wing of about 0.7 m² with a polar of its
 * own, trimmed to a small angle of attack.
 */
export const JUMPSUIT_TRACK = {
  /** The wing area of the jumpsuit track, in m². */
  area: 0.7,
  /** The drag coefficient at zero lift. */
  cd0: 0.45,
  /** The induced drag factor. */
  k: 1.0,
  /** The lift slope, per radian of angle of attack. */
  clAlpha: 2.3,
  /** The largest lift coefficient the wing will hold. */
  clMax: 0.9,
  /** The angle of attack the trim holds, in radians. */
  trimAlphaRad: (10 * Math.PI) / 180,
};

/** The orientation of the body: where the head points and where the back faces. */
export interface BodyFrame {
  /** The direction of the head. */
  forward: Vec3;
  /** The direction of the back; the belly faces the other way. */
  up: Vec3;
}

/** What the air forces need to know about the fall. */
export interface FreefallAeroInput {
  /** The velocity of the body through the air, in m/s. */
  airVel: Vec3;
  /** The density of the air, in kg/m³. */
  rho: number;
  /** The attitude of the body. */
  body: BodyFrame;
  /** The arch input: -1 de-arched, 0 neutral, +1 hard arched. */
  fallRate: number;
  /** How much of the track is mixed in: 0 is a belly box, 1 is a full track. */
  trackBlend: number;
  /** How much bigger this jumper is than the reference jumper. */
  areaScale: number;
}

function clamp(value: number, low: number, high: number): number {
  if (value < low) return low;
  if (value > high) return high;
  return value;
}

/**
 * The drag area of the belly box, in m², for the arch input.
 *
 * The box is 0.55 m² flat, 0.45 m² in a hard arch and 0.68 m² de-arched,
 * and the area of the jumper scales it.
 */
export function bellyCdA(fallRate: number, areaScale: number): number {
  const rate = clamp(fallRate, -1, 1);
  const cda =
    rate >= 0
      ? BELLY.cdaNeutral + (BELLY.cdaArch - BELLY.cdaNeutral) * rate
      : BELLY.cdaNeutral + (BELLY.cdaDeArch - BELLY.cdaNeutral) * -rate;
  return cda * areaScale;
}

/**
 * The force of the air on the body, in newtons, in the world frame.
 *
 * The belly and the track are worked out separately and mixed, so the
 * jumper slides from one to the other as the track comes in.
 */
export function freefallForce(a: FreefallAeroInput): Vec3 {
  const speed = length(a.airVel);
  if (!(speed > 0) || !(a.rho > 0)) return { x: 0, y: 0, z: 0 };

  const q = 0.5 * a.rho * speed * speed;
  const d = scale(a.airVel, 1 / speed);
  const blend = clamp(a.trackBlend, 0, 1);
  const belly = bellyForce(q, d, a);
  if (blend <= 0) return belly;

  const track = trackForce(q, d, a);
  return {
    x: belly.x + (track.x - belly.x) * blend,
    y: belly.y + (track.y - belly.y) * blend,
    z: belly.z + (track.z - belly.z) * blend,
  };
}

/**
 * The force of the belly box: drag, plus the little bit of drive the
 * pitch of the body turns into.
 *
 * The belly normal points out of the belly, so a body flat to the wind has
 * its normal along the wind and makes pure drag. A head-low pitch tilts the
 * normal towards the feet, and the part of it across the wind pushes the
 * jumper along the head.
 */
function bellyForce(q: number, d: Vec3, a: FreefallAeroInput): Vec3 {
  const cda = bellyCdA(a.fallRate, a.areaScale);
  const n = scale(a.body.up, -1);
  const nPerp = sub(n, scale(d, dot(n, d)));
  const k = q * cda;
  return {
    x: k * (-d.x - BELLY.driveLift * nPerp.x),
    y: k * (-d.y - BELLY.driveLift * nPerp.y),
    z: k * (-d.z - BELLY.driveLift * nPerp.z),
  };
}

/**
 * The force of the track: a wing on its polar, lifting across the wind and
 * dragging along it.
 */
function trackForce(q: number, d: Vec3, a: FreefallAeroInput): Vec3 {
  const up = a.body.up;
  const alpha = Math.atan2(-dot(d, up), dot(d, a.body.forward));
  const cl = clamp(
    JUMPSUIT_TRACK.clAlpha * alpha,
    -JUMPSUIT_TRACK.clMax,
    JUMPSUIT_TRACK.clMax,
  );
  const cd = JUMPSUIT_TRACK.cd0 + JUMPSUIT_TRACK.k * cl * cl;
  const l = normalize(sub(up, scale(d, dot(up, d))));
  const k = q * JUMPSUIT_TRACK.area * a.areaScale;
  return {
    x: k * (cl * l.x - cd * d.x),
    y: k * (cl * l.y - cd * d.y),
    z: k * (cl * l.z - cd * d.z),
  };
}
