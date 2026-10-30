/**
 * The keyboard, as the inputs of the simulation.
 *
 * The keys are read by their code, so the layout of the keyboard does not
 * matter. The freefall and the canopy commands are filled from the same key
 * state; the session decides which phase reads which.
 *
 * | key                | freefall              | canopy              |
 * | ------------------ | --------------------- | ------------------- |
 * | A / left arrow     | turn left             | left toggle         |
 * | D / right arrow    | turn right            | right toggle        |
 * | S / down arrow     | drive back            | both toggles        |
 * | W / up arrow       | drive forward         | rear risers         |
 * | R                  | arch (fall faster)    |                     |
 * | F                  | de-arch (fall slower) |                     |
 * | T                  | toggle the track      |                     |
 * | P                  | pull                  |                     |
 * | Q, E               |                       | front risers        |
 * | U                  |                       | unstow the brakes   |
 * | L                  |                       | look up             |
 * | space              |                       | parachute landing   |
 */

import type { JumpInput } from '@/sim/inputs';

/** How long a toggle takes to reach full, in seconds. */
const TOGGLE_UP_S = 0.6;

/** How long a released toggle takes to come back, in seconds. */
const TOGGLE_DOWN_S = 0.3;

/** The keys that scroll the page and are used here instead. */
const SCROLL_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Space']);

/** Moves a value toward its target at the rate of the toggle. */
function ramp(current: number, target: number, dtS: number): number {
  if (target > current) return Math.min(target, current + (dtS / TOGGLE_UP_S));
  if (target < current) return Math.max(target, current - (dtS / TOGGLE_DOWN_S));
  return current;
}

/** The keyboard of one window, sampled once per frame. */
export class KeyboardSource {
  private readonly target: Window;

  /** The keys that are down right now, by code. */
  private readonly down = new Set<string>();

  /** Whether the jumper is in the track position. */
  private track = false;

  /** The pull, for the sample that follows the key. */
  private pullEdge = false;

  /** The unstow, for the sample that follows the key. */
  private unstowEdge = false;

  /** The parachute landing fall, for the sample that follows the key. */
  private plfEdge = false;

  /** How far the left toggle is pulled. */
  private left = 0;

  /** How far the right toggle is pulled. */
  private right = 0;

  constructor(target: Window) {
    this.target = target;
    this.onKeyDown = this.onKeyDown.bind(this);
    this.onKeyUp = this.onKeyUp.bind(this);
    target.addEventListener('keydown', this.onKeyDown);
    target.addEventListener('keyup', this.onKeyUp);
  }

  /**
   * The commands of the jumper right now.
   *
   * @param dtS the time since the last sample, in seconds: the toggles move
   *   at their own rate, so the sample has to know how long it was
   */
  sample(dtS: number): JumpInput & { lookUp: number } {
    const dt = Number.isFinite(dtS) && dtS > 0 ? dtS : 0;

    const leftKey = this.down.has('KeyA') || this.down.has('ArrowLeft');
    const rightKey = this.down.has('KeyD') || this.down.has('ArrowRight');
    // Down drives back in freefall and pulls both toggles under canopy.
    const downKey = this.down.has('KeyS') || this.down.has('ArrowDown');
    const upKey = this.down.has('KeyW') || this.down.has('ArrowUp');

    this.left = ramp(this.left, leftKey || downKey ? 1 : 0, dt);
    this.right = ramp(this.right, rightKey || downKey ? 1 : 0, dt);

    const pull = this.pullEdge;
    const unstow = this.unstowEdge;
    const plf = this.plfEdge;
    this.pullEdge = false;
    this.unstowEdge = false;
    this.plfEdge = false;

    return {
      freefall: {
        turn: (rightKey ? 1 : 0) - (leftKey ? 1 : 0),
        drive: (upKey ? 1 : 0) - (downKey ? 1 : 0),
        fallRate: (this.down.has('KeyR') ? 1 : 0) - (this.down.has('KeyF') ? 1 : 0),
        track: this.track,
      },
      pull,
      canopy: {
        left: this.left,
        right: this.right,
        frontLeft: this.down.has('KeyQ') ? 1 : 0,
        frontRight: this.down.has('KeyE') ? 1 : 0,
        rear: this.down.has('KeyW') ? 1 : 0,
        unstow,
      },
      plf,
      lookUp: this.down.has('KeyL') ? 1 : 0,
    };
  }

  /** Stops listening to the keyboard. */
  dispose(): void {
    this.target.removeEventListener('keydown', this.onKeyDown);
    this.target.removeEventListener('keyup', this.onKeyUp);
  }

  private onKeyDown(event: KeyboardEvent): void {
    if (event.repeat) return;
    this.down.add(event.code);
    if (event.code === 'KeyT') {
      // The track is a decision, so the key turns it on and off.
      this.track = !this.track;
    } else if (event.code === 'KeyP') {
      this.pullEdge = true;
    } else if (event.code === 'KeyU') {
      this.unstowEdge = true;
    } else if (event.code === 'Space') {
      this.plfEdge = true;
    }
    if (SCROLL_KEYS.has(event.code)) event.preventDefault();
  }

  private onKeyUp(event: KeyboardEvent): void {
    this.down.delete(event.code);
  }
}
