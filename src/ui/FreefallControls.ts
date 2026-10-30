/**
 * The touch layer of the freefall.
 *
 * Two ways to fly it, one per scheme. With the tilt, the phone turns and
 * drives the jumper and a thumb on the left half of the screen changes the
 * fall rate. With the fingers, a thumb pad on the left turns and drives and
 * a drag on the right half changes the fall rate. Either way there is a
 * track button, because tracking is a decision, and the pull handle at the
 * lower right, where the hackey sits on the right hip.
 *
 * The elements that take a finger say so with `pointer-events: auto`; the
 * rest of the layer stays transparent to touches, so the world behind keeps
 * the fingers that are not ours.
 */

import { axisToInput } from '@/ui/input/tilt';
import type { TiltSource } from '@/ui/input/tilt';
import { dragToFallRate, isPullSwipe, padToBody } from '@/ui/input/gestures';
import type { PointerSample } from '@/ui/input/gestures';
import type { FreefallInput, JumpInput } from '@/sim/inputs';
import type { ControlScheme } from '@/ui/StartScreen';

/** The parts of the screen that take a finger. */
type Region = 'fall' | 'pad' | 'pull';

/** A finger on the glass, and where it started. */
interface Tracked {
  /** What the finger is doing. */
  region: Region;
  /** Where the finger went down. */
  startX: number;
  startY: number;
  /** When the finger went down. */
  startTMs: number;
  /** Where the finger is now. */
  x: number;
  /** Where the finger is now. */
  y: number;
}

/** The size of the thumb pad, in pixels. */
const PAD_SIZE = 120;

/** How far the thumb pad sits from the corner, in pixels. */
const PAD_MARGIN = 16;

/** The width of the screen, when the window will not say. */
const FALLBACK_WIDTH = 390;

/** The height of the screen, when the window will not say. */
const FALLBACK_HEIGHT = 844;

/** How close together two taps have to be to count as one, in milliseconds. */
const TAP_WINDOW_MS = 100;

/** The touch layer of the freefall. */
export class FreefallControls {
  /** The layer that holds the controls. */
  private readonly layer: HTMLDivElement;

  /** The button that turns the track on and off. */
  private readonly trackButton: HTMLButtonElement;

  /** The handle that is swiped to pull. */
  private readonly pullHandle: HTMLDivElement;

  /** The elements that may take the first finger. */
  private readonly targets: HTMLElement[] = [];

  /** The fingers that are down, by pointer id. */
  private readonly pointers = new Map<number, Tracked>();

  /** Whether the jumper is in the track position. */
  private track = false;

  /** The pull, for the sample that follows the swipe. */
  private pullEdge = false;

  /** The fall rate of the last drag. */
  private fallRate = 0;

  /** Set when the thumb has just lifted: the arch holds for one more sample. */
  private fallHeld = false;

  /** When the track button was last tapped with a finger. */
  private lastTrackTapMs = Number.NEGATIVE_INFINITY;

  constructor(
    root: HTMLElement,
    private readonly scheme: ControlScheme,
    private readonly tilt: TiltSource | null,
  ) {
    this.layer = document.createElement('div');
    this.layer.className = 'ff-controls';
    this.layer.dataset.scheme = scheme;
    this.layer.hidden = true;
    this.targets.push(this.layer);

    if (scheme === 'tilt') {
      // With the tilt, the left half of the screen is the fall rate.
      this.layer.appendChild(this.region('fall', 'ff-fall ff-fall-left'));
    } else {
      // With the fingers, the left thumb pad flies the body and the right
      // half of the screen changes the fall rate.
      this.layer.appendChild(this.region('pad', 'ff-pad'));
      this.layer.appendChild(this.region('fall', 'ff-fall ff-fall-right'));
    }

    this.trackButton = document.createElement('button');
    this.trackButton.type = 'button';
    this.trackButton.className = 'ff-track';
    this.trackButton.dataset.action = 'track';
    this.trackButton.textContent = 'Track';
    this.trackButton.setAttribute('aria-pressed', 'false');
    this.layer.appendChild(this.trackButton);
    this.targets.push(this.trackButton);

    this.pullHandle = document.createElement('div');
    this.pullHandle.className = 'ff-pull';
    this.pullHandle.dataset.action = 'pull';
    this.pullHandle.setAttribute('role', 'button');
    this.pullHandle.setAttribute('aria-label', 'Pull');
    this.layer.appendChild(this.pullHandle);
    this.targets.push(this.pullHandle);

    root.appendChild(this.layer);

    // A finger that goes down on a region is caught there, one that goes
    // down on the background is caught by the layer, and one that is let go
    // outside is caught by the window.
    for (const target of this.targets) {
      target.addEventListener('pointerdown', this.onPointerDown);
      target.addEventListener('pointermove', this.onPointerMove);
      target.addEventListener('pointerup', this.onPointerUp);
      target.addEventListener('pointercancel', this.onPointerCancel);
    }
    window.addEventListener('pointermove', this.onPointerMove);
    window.addEventListener('pointerup', this.onPointerUp);
    window.addEventListener('pointercancel', this.onPointerCancel);

    this.trackButton.addEventListener('click', this.onTrackClick);
    this.trackButton.addEventListener('pointerup', this.onTrackTap);
  }

  /**
   * The commands of the jumper right now.
   *
   * The pull is an edge: it is true for the sample that follows the swipe
   * and for no other.
   */
  sample(): Pick<JumpInput, 'freefall' | 'pull'> {
    const freefall: FreefallInput = {
      turn: 0,
      drive: 0,
      fallRate: this.currentFallRate(),
      track: this.track,
    };

    if (this.scheme === 'tilt') {
      const axes = this.tilt?.axes();
      if (axes) {
        freefall.turn = axisToInput(axes.roll);
        freefall.drive = axisToInput(axes.pitch);
      }
    } else {
      const pad = this.pointerIn('pad');
      if (pad) {
        const body = padToBody(pad.x - pad.startX, pad.y - pad.startY, this.viewportWidth());
        freefall.turn = body.turn;
        freefall.drive = body.drive;
      }
    }

    const pull = this.pullEdge;
    this.pullEdge = false;
    return { freefall, pull };
  }

  /** Shows the controls, or puts them away. */
  show(on: boolean): void {
    this.layer.hidden = !on;
    if (!on) this.pointers.clear();
  }

  /** Takes the controls off the screen and stops listening. */
  dispose(): void {
    for (const target of this.targets) {
      target.removeEventListener('pointerdown', this.onPointerDown);
      target.removeEventListener('pointermove', this.onPointerMove);
      target.removeEventListener('pointerup', this.onPointerUp);
      target.removeEventListener('pointercancel', this.onPointerCancel);
    }
    window.removeEventListener('pointermove', this.onPointerMove);
    window.removeEventListener('pointerup', this.onPointerUp);
    window.removeEventListener('pointercancel', this.onPointerCancel);
    this.trackButton.removeEventListener('click', this.onTrackClick);
    this.trackButton.removeEventListener('pointerup', this.onTrackTap);
    this.pointers.clear();
    this.layer.remove();
  }

  /** A region of the screen that takes a finger. */
  private region(region: Region, className: string): HTMLDivElement {
    const node = document.createElement('div');
    node.className = className;
    node.dataset.region = region;
    this.targets.push(node);
    return node;
  }

  /** The finger that is doing something in a region, if there is one. */
  private pointerIn(region: Region): Tracked | undefined {
    for (const tracked of this.pointers.values()) {
      if (tracked.region === region) return tracked;
    }
    return undefined;
  }

  /**
   * The fall rate of the drag.
   *
   * The arch is held for the sample in which the thumb lifts, so letting go
   * does not snap the body back before the jumper has seen it.
   */
  private currentFallRate(): number {
    const drag = this.pointerIn('fall');
    if (drag) {
      const rate = dragToFallRate(drag.y - drag.startY, this.viewportHeight());
      this.fallRate = rate;
      this.fallHeld = false;
      return rate;
    }
    if (this.fallHeld) {
      this.fallHeld = false;
      return this.fallRate;
    }
    return 0;
  }

  /** The width of the screen, in pixels. */
  private viewportWidth(): number {
    const width = window.innerWidth;
    return Number.isFinite(width) && width > 0 ? width : FALLBACK_WIDTH;
  }

  /** The height of the screen, in pixels. */
  private viewportHeight(): number {
    const height = window.innerHeight;
    return Number.isFinite(height) && height > 0 ? height : FALLBACK_HEIGHT;
  }

  /** When the event happened, in milliseconds. */
  private eventTimeMs(event: Event): number {
    const stamp = event.timeStamp;
    if (typeof stamp === 'number' && Number.isFinite(stamp)) return stamp;
    return typeof performance !== 'undefined' ? performance.now() : Date.now();
  }

  /**
   * What the finger that went down is doing.
   *
   * The element it landed on says; a finger that landed on the background
   * is judged by where it landed, which is close enough for a screen that
   * is mostly empty.
   */
  private regionFor(event: PointerEvent): Region | null {
    const target = event.target as Element | null;
    if (target && typeof target.closest === 'function') {
      if (target.closest('[data-action="pull"]')) return 'pull';
      if (target.closest('[data-action="track"]')) return null;
      const region = target.closest('[data-region]');
      const name = region?.getAttribute('data-region');
      if (name === 'fall' || name === 'pad') return name;
    }

    const width = this.viewportWidth();
    const height = this.viewportHeight();
    if (this.scheme === 'tilt') {
      return event.clientX < width / 2 ? 'fall' : null;
    }
    const onPad =
      event.clientX >= PAD_MARGIN &&
      event.clientX <= PAD_MARGIN + PAD_SIZE &&
      event.clientY >= height - PAD_MARGIN - PAD_SIZE &&
      event.clientY <= height - PAD_MARGIN;
    if (onPad) return 'pad';
    return event.clientX >= width / 2 ? 'fall' : null;
  }

  /** A finger goes down. */
  private readonly onPointerDown = (event: PointerEvent): void => {
    // A finger that is already down is the same finger, heard twice.
    if (this.pointers.has(event.pointerId)) return;
    // Only the primary mouse button flies the jumper.
    if (typeof event.button === 'number' && event.button !== 0) return;

    const region = this.regionFor(event);
    if (!region) return;

    this.pointers.set(event.pointerId, {
      region,
      startX: event.clientX,
      startY: event.clientY,
      startTMs: this.eventTimeMs(event),
      x: event.clientX,
      y: event.clientY,
    });

    const target = event.target as Element | null;
    if (target && typeof target.setPointerCapture === 'function') {
      try {
        target.setPointerCapture(event.pointerId);
      } catch {
        // A browser that will not capture the pointer still delivers the
        // events to the window.
      }
    }
  };

  /** A finger moves. */
  private readonly onPointerMove = (event: PointerEvent): void => {
    const tracked = this.pointers.get(event.pointerId);
    if (!tracked) return;
    tracked.x = event.clientX;
    tracked.y = event.clientY;
  };

  /** A finger is let go. */
  private readonly onPointerUp = (event: PointerEvent): void => {
    const tracked = this.pointers.get(event.pointerId);
    if (!tracked) return;
    this.pointers.delete(event.pointerId);

    // An event without a position is the end of a drag, not a new place.
    const endX = event.clientX !== 0 ? event.clientX : tracked.x;
    const endY = event.clientY !== 0 ? event.clientY : tracked.y;

    if (tracked.region === 'pull') {
      const start: PointerSample = {
        x: tracked.startX,
        y: tracked.startY,
        tMs: tracked.startTMs,
      };
      const end: PointerSample = { x: endX, y: endY, tMs: this.eventTimeMs(event) };
      if (isPullSwipe(start, end, this.viewportWidth())) this.pullEdge = true;
    } else if (tracked.region === 'fall') {
      this.fallRate = dragToFallRate(endY - tracked.startY, this.viewportHeight());
      this.fallHeld = true;
    }
  };

  /** A finger is taken away, by a call or by the browser. */
  private readonly onPointerCancel = (event: PointerEvent): void => {
    const tracked = this.pointers.get(event.pointerId);
    if (!tracked) return;
    this.pointers.delete(event.pointerId);
    if (tracked.region === 'fall') {
      this.fallRate = dragToFallRate(tracked.y - tracked.startY, this.viewportHeight());
      this.fallHeld = true;
    }
  };

  /** The track button is tapped with a finger. */
  private readonly onTrackTap = (event: PointerEvent): void => {
    this.lastTrackTapMs = this.eventTimeMs(event);
    this.toggleTrack();
  };

  /** The track button is clicked. */
  private readonly onTrackClick = (event: MouseEvent): void => {
    // A tap with a finger has already been counted.
    const stamp = event.timeStamp;
    if (Number.isFinite(stamp) && stamp - this.lastTrackTapMs < TAP_WINDOW_MS) return;
    this.toggleTrack();
  };

  /** Tracking is a decision: the button turns it on and off. */
  private toggleTrack(): void {
    this.track = !this.track;
    this.trackButton.setAttribute('aria-pressed', String(this.track));
  }
}
