/**
 * The floating origin: the world is rebased around the camera.
 *
 * The scene works in metres, so a camera that has flown a hundred kilometres
 * would put the ground a hundred thousand metres away from the origin, and
 * the single-precision floats of the vertex buffers would start to jitter.
 * The fix is to move the world instead of the camera: when the camera has
 * wandered far enough, its position is rounded to the nearest metre, that
 * rounded value is added to the offset and the camera is put back at the
 * origin. The world group moves the other way, so nothing on screen moves at
 * all.
 *
 * The offset is what the world code needs: the true position of the camera in
 * the local frame is the camera's own position plus the offset.
 */

import * as THREE from 'three';

/** How far the camera may stray before the world is rebased, in metres. */
const DEFAULT_THRESHOLD_M = 2000;

export class FloatingOrigin {
  /** The offset between the scene's origin and the world's origin, in metres. */
  readonly offset: { x: number; z: number } = { x: 0, z: 0 };

  private readonly world: THREE.Group;

  private readonly thresholdM: number;

  constructor(world: THREE.Group, thresholdM: number = DEFAULT_THRESHOLD_M) {
    this.world = world;
    this.thresholdM = thresholdM;
  }

  /**
   * Rebase the world if the camera has wandered too far.
   *
   * Returns true when the world was rebased. The camera's height is never
   * touched: only the ground plane moves.
   */
  update(camera: THREE.Camera): boolean {
    const dx = camera.position.x;
    const dz = camera.position.z;
    if (Math.hypot(dx, dz) <= this.thresholdM) return false;

    // The camera's position is rounded to whole metres: the offset stays a
    // whole number, so the ground never creeps by a fraction of a metre.
    this.offset.x += Math.round(dx);
    this.offset.z += Math.round(dz);
    camera.position.x = 0;
    camera.position.z = 0;

    // The world moves the other way, so the tiles keep their place.
    this.world.position.set(-this.offset.x, 0, -this.offset.z);
    return true;
  }

  /** Where the camera really is, in the local frame's metres. */
  truePosition(camera: THREE.Camera): { x: number; y: number; z: number } {
    return {
      x: camera.position.x + this.offset.x,
      y: camera.position.y,
      z: camera.position.z + this.offset.z,
    };
  }
}
