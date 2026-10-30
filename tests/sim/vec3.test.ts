import { describe, it, expect } from 'vitest';
import { Rng } from '@/sim/rng';
import {
  vec3,
  add,
  sub,
  scale,
  dot,
  cross,
  length,
  normalize,
  quatIdentity,
  quatFromAxisAngle,
  quatMultiply,
  quatRotate,
  quatFromUnitVectors,
  quatNormalize,
  quatFromBasis,
  type Vec3,
} from '@/sim/vec3';

/** Compares two vectors to `digits` decimal places. */
function expectVecClose(a: Vec3, b: Vec3, digits = 9): void {
  expect(a.x).toBeCloseTo(b.x, digits);
  expect(a.y).toBeCloseTo(b.y, digits);
  expect(a.z).toBeCloseTo(b.z, digits);
}

function unit(rng: Rng): Vec3 {
  const v = vec3(rng.range(-1, 1), rng.range(-1, 1), rng.range(-1, 1));
  return normalize(v);
}

describe('vec3', () => {
  it('adds, subtracts and scales without touching the inputs', () => {
    const a = vec3(1, 2, 3);
    const b = vec3(10, 20, 30);
    expect(add(a, b)).toEqual(vec3(11, 22, 33));
    expect(sub(b, a)).toEqual(vec3(9, 18, 27));
    expect(scale(a, 2)).toEqual(vec3(2, 4, 6));
    expect(a).toEqual(vec3(1, 2, 3));
  });

  it('takes the dot and the cross product', () => {
    expect(dot(vec3(1, 0, 0), vec3(0, 1, 0))).toBe(0);
    expect(dot(vec3(1, 2, 3), vec3(4, 5, 6))).toBe(32);
    expect(cross(vec3(1, 0, 0), vec3(0, 1, 0))).toEqual(vec3(0, 0, 1));
    expect(cross(vec3(0, 0, 1), vec3(1, 0, 0))).toEqual(vec3(0, 1, 0));
  });

  it('measures length and normalizes', () => {
    expect(length(vec3(3, 4, 0))).toBe(5);
    expect(length(normalize(vec3(0, 5, 0)))).toBe(1);
    expect(normalize(vec3(0, 5, 0))).toEqual(vec3(0, 1, 0));
  });

  it('leaves the zero vector alone when normalizing', () => {
    expect(normalize(vec3(0, 0, 0))).toEqual(vec3(0, 0, 0));
  });
});

describe('quaternions', () => {
  it('has an identity that rotates nothing', () => {
    expect(quatIdentity()).toEqual({ x: 0, y: 0, z: 0, w: 1 });
    expect(quatRotate(quatIdentity(), vec3(1, 2, 3))).toEqual(vec3(1, 2, 3));
  });

  it('rotates about an axis', () => {
    const q = quatFromAxisAngle(vec3(0, 0, 1), Math.PI / 2);
    const v = quatRotate(q, vec3(1, 0, 0));
    expectVecClose(v, vec3(0, 1, 0), 12);
  });

  it('multiplies in the order a then b', () => {
    const a = quatFromAxisAngle(vec3(0, 0, 1), Math.PI / 2);
    const b = quatFromAxisAngle(vec3(0, 1, 0), Math.PI / 2);
    const v = vec3(1, 0.3, -0.7);
    const once = quatRotate(quatMultiply(a, b), v);
    const twice = quatRotate(a, quatRotate(b, v));
    expectVecClose(once, twice, 12);
  });

  it('normalizes without changing the rotation', () => {
    const q = quatFromAxisAngle(vec3(0, 1, 0), 0.7);
    const scaled = { x: q.x * 3, y: q.y * 3, z: q.z * 3, w: q.w * 3 };
    const v = vec3(0.2, -1, 4);
    expectVecClose(quatRotate(quatNormalize(scaled), v), quatRotate(q, v), 12);
  });

  it('turns one unit vector into another along the shortest arc', () => {
    const rng = new Rng(1234);
    for (let i = 0; i < 200; i++) {
      const a = unit(rng);
      const b = unit(rng);
      const q = quatFromUnitVectors(a, b);
      expectVecClose(quatRotate(q, a), b, 9);
    }
  });

  it('turns a vector into its opposite', () => {
    const rng = new Rng(99);
    for (let i = 0; i < 50; i++) {
      const a = unit(rng);
      const b = scale(a, -1);
      const q = quatFromUnitVectors(a, b);
      expectVecClose(quatRotate(q, a), b, 9);
    }
  });

  it('turns a scaled vector onto the direction of the target', () => {
    const a = vec3(0, 0, 2);
    const b = vec3(-3, 0, 0);
    const q = quatFromUnitVectors(a, b);
    expectVecClose(quatRotate(q, a), vec3(-2, 0, 0), 9);
  });
});

describe('quatFromBasis', () => {
  /** The canonical body frame: head north, back up, right hand east. */
  const HEAD = vec3(0, 0, -1);
  const BACK = vec3(0, 1, 0);
  const RIGHT = vec3(1, 0, 0);

  it('presents the canonical frame to the pair it is given', () => {
    const rng = new Rng(4242);
    for (let i = 0; i < 200; i++) {
      const up = unit(rng);
      const seed = unit(rng);
      const forward = normalize(sub(seed, scale(up, dot(seed, up))));
      if (length(forward) < 1e-6) continue;
      const q = quatFromBasis(forward, up);
      expectVecClose(quatRotate(q, HEAD), forward, 9);
      expectVecClose(quatRotate(q, BACK), up, 9);
      expectVecClose(quatRotate(q, RIGHT), cross(forward, up), 9);
    }
  });

  it('leaves the canonical frame alone when it is given the canonical frame', () => {
    const q = quatFromBasis(HEAD, BACK);
    expectVecClose(quatRotate(q, HEAD), HEAD, 12);
    expectVecClose(quatRotate(q, BACK), BACK, 12);
    expectVecClose(quatRotate(q, RIGHT), RIGHT, 12);
  });

  it('turns the head and the back together', () => {
    // head east, back up: a quarter turn about the vertical
    const q = quatFromBasis(vec3(1, 0, 0), BACK);
    expectVecClose(quatRotate(q, HEAD), vec3(1, 0, 0), 9);
    expectVecClose(quatRotate(q, BACK), BACK, 9);
    expectVecClose(quatRotate(q, RIGHT), cross(vec3(1, 0, 0), BACK), 9);
  });
});
