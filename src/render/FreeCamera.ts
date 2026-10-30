/**
 * The free camera: the camera you fly the app with.
 *
 * One finger looks around, two fingers fly: the middle of the pair moves the
 * camera along the ground and the distance between them changes the height.
 * The keyboard does the same from a desktop. The camera never goes through
 * the ground: it keeps two metres of clearance over it.
 *
 * The camera's own position is the position in the scene, which the floating
 * origin rebases around the camera; the ground is sampled through the
 * `groundY` function the caller gives, which is where the caller puts the
 * rebasing back in.
 */

import * as THREE from 'three';

/** Radians of turn per pixel of drag. */
const LOOK_PER_PIXEL = 0.004;

/** The pitch is clamped to this, in radians: nearly straight up or down. */
const PITCH_LIMIT = 1.5;

/** The height above the ground the camera keeps, in metres. */
const MIN_CLEARANCE_M = 2;

/** The slowest the camera flies, in metres per second. */
const MIN_SPEED = 5;

/** The fastest the camera flies, in metres per second. */
const MAX_SPEED = 400;

/** How much faster the camera flies with the shift key down. */
const BOOST = 4;

/** A drag of this many pixels is one second of travel at the current speed. */
const DRAG_REFERENCE_PX = 100;

/** Where one pointer is on the screen. */
interface Pointer {
  x: number;
  y: number;
}

export class FreeCamera {
  /** The heading, in radians: zero looks north, to the right of the screen. */
  yaw = 0;

  /** The tilt, in radians: negative looks down. */
  pitch = 0;

  private readonly camera: THREE.PerspectiveCamera;
  private readonly dom: HTMLElement;
  private readonly groundY: (x: number, z: number) => number;

  /** The pointers on the screen, by pointer id. */
  private readonly pointers = new Map<number, Pointer>();

  /** The keys that are down, by their lower-case name. */
  private readonly keys = new Set<string>();

  /** The middle of the two pointers, while there are two. */
  private centroid: Pointer | null = null;

  /** The distance between the two pointers, while there are two. */
  private pinch = 0;

  /** The height above the ground, from the last update. */
  private lastAgl = 0;

  /** Whether the user has taken the camera over. */
  private _userMoved = false;

  constructor(
    camera: THREE.PerspectiveCamera,
    dom: HTMLElement,
    groundY: (x: number, z: number) => number,
  ) {
    this.camera = camera;
    this.dom = dom;
    this.groundY = groundY;

    this.dom.addEventListener('pointerdown', this.onPointerDown);
    this.dom.addEventListener('pointermove', this.onPointerMove);
    this.dom.addEventListener('pointerup', this.onPointerUp);
    this.dom.addEventListener('pointercancel', this.onPointerUp);
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', this.onBlur);
  }

  /** The height of the camera above the ground, in metres. */
  get agl(): number {
    return this.lastAgl;
  }

  /**
   * Whether the user has moved the camera.
   *
   * The flag is never taken back: once the user has taken the camera over,
   * the app stops putting it where the exit is. A pointer or a key sets it.
   */
  get userMoved(): boolean {
    return this._userMoved;
  }

  /**
   * Put the camera where it is told to, and point it there.
   *
   * The position is the one the camera has in the scene, so the caller puts
   * the rebasing of the world back in.
   */
  setPose(x: number, y: number, z: number, yaw: number, pitch: number): void {
    this.yaw = yaw;
    this.pitch = clamp(pitch, -PITCH_LIMIT, PITCH_LIMIT);
    this.camera.position.set(x, y, z);
    this.applyRotation();
    this.lastAgl = y - this.groundY(x, z);
  }

  /**
   * One step of the flight: the keys, then the ground.
   *
   * The camera flies at a speed that depends on the height above the
   * ground: slow near the ground, fast in the sky.
   */
  update(dt: number): void {
    const step = this.speed() * this.boost() * dt;

    let forward = 0;
    let strafe = 0;
    let vertical = 0;
    if (this.keys.has('w') || this.keys.has('arrowup')) forward += 1;
    if (this.keys.has('s') || this.keys.has('arrowdown')) forward -= 1;
    if (this.keys.has('d') || this.keys.has('arrowright')) strafe += 1;
    if (this.keys.has('a') || this.keys.has('arrowleft')) strafe -= 1;
    if (this.keys.has('e')) vertical += 1;
    if (this.keys.has('q')) vertical -= 1;

    if (forward !== 0 || strafe !== 0) {
      const heading = this.heading();
      this.camera.position.x += (heading.fx * forward + heading.rx * strafe) * step;
      this.camera.position.z += (heading.fz * forward + heading.rz * strafe) * step;
    }
    if (vertical !== 0) {
      this.camera.position.y += vertical * step;
    }

    this.clampToGround();
    this.applyRotation();
    this.lastAgl =
      this.camera.position.y -
      this.groundY(this.camera.position.x, this.camera.position.z);
  }

  /** Let go of the listeners. */
  dispose(): void {
    this.dom.removeEventListener('pointerdown', this.onPointerDown);
    this.dom.removeEventListener('pointermove', this.onPointerMove);
    this.dom.removeEventListener('pointerup', this.onPointerUp);
    this.dom.removeEventListener('pointercancel', this.onPointerUp);
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('blur', this.onBlur);
    this.pointers.clear();
    this.keys.clear();
  }

  /** How fast the camera flies, in metres per second. */
  private speed(): number {
    return clamp(this.lastAgl * 0.5, MIN_SPEED, MAX_SPEED);
  }

  /** The multiplier of the shift key. */
  private boost(): number {
    return this.keys.has('shift') ? BOOST : 1;
  }

  /** The direction the camera looks along, and the one to its right. */
  private heading(): { fx: number; fz: number; rx: number; rz: number } {
    const sin = Math.sin(this.yaw);
    const cos = Math.cos(this.yaw);
    return { fx: -sin, fz: -cos, rx: cos, rz: -sin };
  }

  /** Keep the camera above the ground. */
  private clampToGround(): void {
    const { x, y, z } = this.camera.position;
    const floor = this.groundY(x, z) + MIN_CLEARANCE_M;
    if (y < floor) this.camera.position.y = floor;
  }

  /** Point the camera where it looks. */
  private applyRotation(): void {
    this.camera.rotation.set(this.pitch, this.yaw, 0, 'YXZ');
  }

  private readonly onPointerDown = (event: PointerEvent): void => {
    this._userMoved = true;
    const id = pointerIdOf(event);
    this.pointers.set(id, { x: event.clientX, y: event.clientY });

    // Keep the moves coming, even when the pointer leaves the element.
    try {
      this.dom.setPointerCapture(id);
    } catch {
      // The browser may refuse it: the drag works without it.
    }

    if (this.pointers.size >= 2) {
      this.measurePair();
    } else {
      this.centroid = null;
      this.pinch = 0;
    }
  };

  private readonly onPointerMove = (event: PointerEvent): void => {
    const id = pointerIdOf(event);
    const pointer = this.pointers.get(id);
    if (!pointer) return;

    const x = event.clientX;
    const y = event.clientY;

    // One pointer looks around.
    if (this.pointers.size === 1) {
      this.yaw -= (x - pointer.x) * LOOK_PER_PIXEL;
      this.pitch = clamp(this.pitch - (y - pointer.y) * LOOK_PER_PIXEL, -PITCH_LIMIT, PITCH_LIMIT);
      pointer.x = x;
      pointer.y = y;
      this.applyRotation();
      return;
    }

    // Two pointers fly: the middle of them moves the camera along the
    // ground, the distance between them changes the height.
    pointer.x = x;
    pointer.y = y;

    const before = this.centroid;
    const beforePinch = this.pinch;
    this.measurePair();
    if (!before) return;

    const scale = this.speed() / DRAG_REFERENCE_PX;
    const heading = this.heading();
    const dx = (this.centroid?.x ?? 0) - before.x;
    const dy = (this.centroid?.y ?? 0) - before.y;

    // Dragging down moves forward, dragging right moves right.
    this.camera.position.x += (heading.fx * dy + heading.rx * dx) * scale;
    this.camera.position.z += (heading.fz * dy + heading.rz * dx) * scale;

    // Spreading the fingers climbs, pinching them descends.
    this.camera.position.y += (this.pinch - beforePinch) * scale;

    this.clampToGround();
  };

  private readonly onPointerUp = (event: PointerEvent): void => {
    const id = pointerIdOf(event);
    this.pointers.delete(id);

    try {
      this.dom.releasePointerCapture(id);
    } catch {
      // There was nothing to release.
    }

    if (this.pointers.size < 2) {
      this.centroid = null;
      this.pinch = 0;
    } else {
      this.measurePair();
    }
  };

  /** Measure the middle and the distance of the two pointers. */
  private measurePair(): void {
    const points = [...this.pointers.values()];
    const a = points[0];
    const b = points[1];
    if (!a || !b) {
      this.centroid = null;
      this.pinch = 0;
      return;
    }
    this.centroid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    this.pinch = Math.hypot(a.x - b.x, a.y - b.y);
  }

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    this._userMoved = true;
    this.keys.add(event.key.toLowerCase());
  };

  private readonly onKeyUp = (event: KeyboardEvent): void => {
    this.keys.delete(event.key.toLowerCase());
  };

  /** The window lost the focus: no key is down any more. */
  private readonly onBlur = (): void => {
    this.keys.clear();
  };
}

/** The id of the pointer of an event, or zero when it has none. */
function pointerIdOf(event: PointerEvent): number {
  const id = event.pointerId;
  return typeof id === 'number' && Number.isFinite(id) ? id : 0;
}

/** Keep a number between two bounds. */
function clamp(value: number, low: number, high: number): number {
  if (value < low) return low;
  if (value > high) return high;
  return value;
}
