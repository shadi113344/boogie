/**
 * Vectors and quaternions as plain objects.
 *
 * Everything here is immutable: every function returns a new object and
 * never touches its arguments. The simulation runs on plain numbers so that
 * a jump can be replayed exactly and logged without three.js anywhere near
 * it. This module imports nothing from three.js or the DOM.
 */

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface Quat {
  x: number;
  y: number;
  z: number;
  w: number;
}

/** A vector in the world frame: x east, y up, z south. */
export function vec3(x: number, y: number, z: number): Vec3 {
  return { x, y, z };
}

/** The sum of two vectors. */
export function add(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}

/** The difference of two vectors. */
export function sub(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

/** A vector scaled by a factor. */
export function scale(a: Vec3, s: number): Vec3 {
  return { x: a.x * s, y: a.y * s, z: a.z * s };
}

/** The dot product of two vectors. */
export function dot(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

/** The cross product of two vectors. */
export function cross(a: Vec3, b: Vec3): Vec3 {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}

/** The length of a vector. */
export function length(a: Vec3): number {
  return Math.hypot(a.x, a.y, a.z);
}

/** A vector of length one in the same direction; the zero vector stays zero. */
export function normalize(a: Vec3): Vec3 {
  const len = length(a);
  if (len === 0) return { x: 0, y: 0, z: 0 };
  return { x: a.x / len, y: a.y / len, z: a.z / len };
}

/** The quaternion that rotates nothing. */
export function quatIdentity(): Quat {
  return { x: 0, y: 0, z: 0, w: 1 };
}

/** The quaternion of a rotation of `rad` radians about `axis`. */
export function quatFromAxisAngle(axis: Vec3, rad: number): Quat {
  const len = length(axis);
  if (len === 0) return quatIdentity();
  const half = rad / 2;
  const s = Math.sin(half) / len;
  return { x: axis.x * s, y: axis.y * s, z: axis.z * s, w: Math.cos(half) };
}

/** The product of two quaternions: `a` applied after `b`. */
export function quatMultiply(a: Quat, b: Quat): Quat {
  return {
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
  };
}

/** Rotates a vector by a quaternion. */
export function quatRotate(q: Quat, v: Vec3): Vec3 {
  const u = vec3(q.x, q.y, q.z);
  const uv = cross(u, v);
  const uuv = cross(u, uv);
  return {
    x: v.x + 2 * (q.w * uv.x + uuv.x),
    y: v.y + 2 * (q.w * uv.y + uuv.y),
    z: v.z + 2 * (q.w * uv.z + uuv.z),
  };
}

/** The head of the canonical body frame: it points north. */
const CANONICAL_FORWARD: Vec3 = { x: 0, y: 0, z: -1 };

/** The back of the canonical body frame: it points up. */
const CANONICAL_UP: Vec3 = { x: 0, y: 1, z: 0 };

/** A unit vector perpendicular to `v`, or the zero vector if `v` is zero. */
function perpendicularTo(v: Vec3): Vec3 {
  const ax = Math.abs(v.x);
  const ay = Math.abs(v.y);
  const az = Math.abs(v.z);
  let axis: Vec3;
  if (ax <= ay && ax <= az) axis = vec3(1, 0, 0);
  else if (ay <= az) axis = vec3(0, 1, 0);
  else axis = vec3(0, 0, 1);
  return normalize(cross(v, axis));
}

/**
 * The rotation of the shortest arc that turns the direction `from` into the
 * direction `to`. Two opposite vectors have no shortest arc, so the
 * rotation of half a turn about any axis perpendicular to `from` is used.
 */
export function quatFromUnitVectors(from: Vec3, to: Vec3): Quat {
  const a = normalize(from);
  const b = normalize(to);
  const r = dot(a, b) + 1;
  if (r < 1e-8) return quatFromAxisAngle(perpendicularTo(a), Math.PI);
  const c = cross(a, b);
  return quatNormalize({ x: c.x, y: c.y, z: c.z, w: r });
}

/** A quaternion of length one; the zero quaternion becomes the identity. */
export function quatNormalize(q: Quat): Quat {
  const len = Math.hypot(q.x, q.y, q.z, q.w);
  if (len === 0) return quatIdentity();
  return { x: q.x / len, y: q.y / len, z: q.z / len, w: q.w / len };
}

/**
 * The rotation that presents the canonical body frame to a pair of axes.
 *
 * The canonical frame has the head along (0, 0, −1), the back along
 * (0, 1, 0) and the right hand along (1, 0, 0). This maps the canonical
 * head onto `forward` and the canonical back onto `up`; the canonical right
 * hand then follows as their cross product, because a rotation that keeps
 * two axes perpendicular keeps the third one perpendicular as well. The
 * pair has to be unit vectors at right angles to each other.
 */
export function quatFromBasis(forward: Vec3, up: Vec3): Quat {
  const f = normalize(forward);
  const u = normalize(up);
  // Turn the canonical back onto `up` first. The canonical head stays
  // perpendicular to the new back, because a rotation keeps angles.
  const toUp = quatFromUnitVectors(CANONICAL_UP, u);
  const head = quatRotate(toUp, CANONICAL_FORWARD);
  // Then roll about `up` until the head is on `forward`.
  const angle = Math.atan2(dot(cross(head, f), u), dot(head, f));
  const aboutUp = quatFromAxisAngle(u, angle);
  return quatNormalize(quatMultiply(aboutUp, toUp));
}
