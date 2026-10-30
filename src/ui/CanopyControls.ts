/**
 * The touch layer of the canopy.
 *
 * Two ways to fly it, one per scheme. With the fingers, the two edges of
 * the screen are the two toggles: a thumb dragged down pulls that brake
 * and letting go lets it out, a thumb that goes in and then down pulls
 * that side's front riser, and two thumbs that go up pull the rear
 * risers. With the tilt, the phone banks the canopy and the slider at
 * the bottom of the screen gives the symmetric brakes.
 *
 * The brakes are stowed when the canopy opens. With the toggles the
 * jumper unstows them by pulling both down together; with the tilt and
 * the slider there is a pill for it. The phone tilted back looks up at
 * the canopy in either scheme, and a quick roll is the parachute landing
 * fall; a phone that cannot be rolled gets a pill that does it instead.
 *
 * The elements that take a finger say so with `pointer-events: auto`; the
 * rest of the layer stays transparent to touches, so the world behind
 * keeps the fingers that are not ours.
 */

import { axisToInput } from '@/ui/input/tilt';
import type { TiltSource } from '@/ui/input/tilt';
import { isPlfRoll, toggleDepth } from '@/ui/input/gestures';
import type { CanopyInput, JumpInput } from '@/sim/inputs';

/** The two ways the canopy can be flown. */
export type CanopyScheme = 'toggles' | 'tilt-slider';

/** What a finger on the glass is doing. */
type Region = 'toggle-left' | 'toggle-right' | 'slider';

/** A finger on the glass, and where it started. */
interface Tracked {
  /** What the finger is doing. */
  region: Region;
  /** Which edge the finger started on; null for the slider. */
  side: 'left' | 'right' | null;
  /** Where the finger went down. */
  startX: number;
  /** Where the finger went down. */
  startY: number;
  /** Where the finger is now. */
  x: number;
  /** Where the finger is now. */
  y: number;
  /** True once the finger has turned into that side's front riser. */
  front: boolean;
  /** Where the finger was when it turned into a front riser. */
  anchorY: number;
}

/** The part of the screen at each edge that takes a toggle. */
const EDGE_FRACTION = 0.3;

/** How far in a finger has to go to be a front riser, as a fraction of the width. */
const FRONT_INWARD_FRACTION = 0.04;

/** The downward drift that is noise, as a fraction of the height. */
const FRONT_ORDER_NOISE_FRACTION = 0.03;

/** The toggle depth that counts as unstowing the brakes. */
const UNSTOW_DEPTH = 0.3;

/** How close together the two toggles have to be to unstow, in milliseconds. */
const UNSTOW_WINDOW_MS = 500;

/** The pitch that looks all the way up at the canopy, in degrees. */
const LOOK_UP_PITCH_DEG = 35;

/** How far up the fingers have to go before the rear risers come in, as a fraction of the height. */
const REAR_THRESHOLD_FRACTION = 0.02;

/** The travel that pulls the rear risers all the way, as a fraction of the height. */
const REAR_TRAVEL_FRACTION = 0.2;

/** The height of the slider at the bottom, as a fraction of the height of the screen. */
const SLIDER_HEIGHT_FRACTION = 0.22;

/** How far the slider sits from the bottom of the screen, in pixels. */
const SLIDER_BOTTOM_PX = 28;

/** The width of the slider, in pixels. */
const SLIDER_WIDTH_PX = 72;

/** The size of the knob of the slider, in pixels: a thumb-sized target. */
const KNOB_SIZE_PX = 44;

/** The width of the screen, when the window will not say. */
const FALLBACK_WIDTH = 390;

/** The height of the screen, when the window will not say. */
const FALLBACK_HEIGHT = 844;

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

/** The touch layer of the canopy. */
export class CanopyControls {
  /** The layer that holds the controls. */
  private readonly layer: HTMLDivElement;

  /** The elements that may take the first finger. */
  private readonly targets: HTMLElement[] = [];

  /** The fingers that are down, by pointer id. */
  private readonly pointers = new Map<number, Tracked>();

  /** The thin line along the left edge, when the toggles are there. */
  private readonly leftDepth: HTMLDivElement | null = null;

  /** The thin line along the right edge, when the toggles are there. */
  private readonly rightDepth: HTMLDivElement | null = null;

  /** The slider that gives the symmetric brakes, in the tilt scheme. */
  private slider: HTMLDivElement | null = null;

  /** The knob of the slider. */
  private sliderKnob: HTMLDivElement | null = null;

  /** The pill that is the parachute landing fall, when there is no roll. */
  private readonly plfPill: HTMLButtonElement;

  /** How far the symmetric brakes are pulled, from the slider. */
  private sliderValue = 0;

  /** Whether the Fronts button is held down. */
  private frontsHeld = false;

  /** Whether the PLF pill may be used. */
  private plfAvailable = false;

  /** The unstow, for the sample that follows the gesture or the tap. */
  private unstowEdge = false;

  /** Whether the brakes have already been unstowed. */
  private unstowDone = false;

  /** When the left toggle first went past the unstow depth. */
  private leftCrossMs: number | null = null;

  /** When the right toggle first went past the unstow depth. */
  private rightCrossMs: number | null = null;

  /** The PLF, for the sample that follows the roll or the tap. */
  private plfEdge = false;

  /** Whether the roll that is being counted has already been counted. */
  private rollCounted = false;

  constructor(
    root: HTMLElement,
    private readonly scheme: CanopyScheme,
    private readonly tilt: TiltSource | null,
  ) {
    this.layer = document.createElement('div');
    this.layer.className = 'cn-controls';
    this.layer.dataset.scheme = scheme;
    this.layer.hidden = true;
    this.targets.push(this.layer);

    if (scheme === 'toggles') {
      // With the fingers, the two edges of the screen are the two toggles.
      const left = this.edge('toggle-left', 'cn-toggle cn-toggle-left');
      const right = this.edge('toggle-right', 'cn-toggle cn-toggle-right');
      this.leftDepth = this.depthLine('left');
      this.rightDepth = this.depthLine('right');
      left.appendChild(this.leftDepth);
      right.appendChild(this.rightDepth);
      this.layer.appendChild(left);
      this.layer.appendChild(right);
    } else {
      this.buildSlider();
      this.buildFronts();
      this.buildUnstow();
    }

    this.plfPill = document.createElement('button');
    this.plfPill.type = 'button';
    this.plfPill.className = 'cn-plf';
    this.plfPill.dataset.action = 'plf';
    this.plfPill.textContent = 'PLF';
    this.plfPill.setAttribute('aria-label', 'Parachute landing fall');
    this.plfPill.hidden = true;
    this.plfPill.addEventListener('click', () => {
      this.plfEdge = true;
    });
    this.layer.appendChild(this.plfPill);

    root.appendChild(this.layer);

    // A finger that goes down on a control is caught there, and one that
    // is let go outside is caught by the window.
    for (const target of this.targets) {
      target.addEventListener('pointerdown', this.onPointerDown);
      target.addEventListener('pointermove', this.onPointerMove);
      target.addEventListener('pointerup', this.onPointerUp);
      target.addEventListener('pointercancel', this.onPointerCancel);
    }
    window.addEventListener('pointermove', this.onPointerMove);
    window.addEventListener('pointerup', this.onPointerUp);
    window.addEventListener('pointercancel', this.onPointerCancel);
  }

  /**
   * The commands of the jumper right now.
   *
   * The unstow and the PLF are edges: they are true for the sample that
   * follows the gesture and for no other.
   */
  sample(): Pick<JumpInput, 'canopy' | 'plf'> & { lookUp: number } {
    const canopy: CanopyInput = {
      left: 0,
      right: 0,
      frontLeft: 0,
      frontRight: 0,
      rear: 0,
      unstow: false,
    };

    const axes = this.tilt?.axes() ?? null;
    const bank = axes ? axisToInput(axes.roll) : 0;

    if (this.scheme === 'toggles') {
      canopy.left = this.toggleDepth('left');
      canopy.right = this.toggleDepth('right');
      canopy.frontLeft = this.frontDepth('left');
      canopy.frontRight = this.frontDepth('right');
      canopy.rear = this.rearDepth();
    } else {
      // The slider gives the symmetric brakes; the tilt banks on top of them.
      canopy.left = clamp01(this.sliderValue + Math.max(0, -bank));
      canopy.right = clamp01(this.sliderValue + Math.max(0, bank));
      const fronts = this.frontsHeld ? 1 : 0;
      canopy.frontLeft = fronts;
      canopy.frontRight = fronts;
    }

    const unstow = this.unstowEdge;
    this.unstowEdge = false;
    canopy.unstow = unstow;

    // A quick roll is the PLF, once per roll.
    const rolling = this.tilt !== null && isPlfRoll(this.tilt.rollRateDegS());
    if (rolling && !this.rollCounted) {
      this.rollCounted = true;
      this.plfEdge = true;
    } else if (!rolling) {
      this.rollCounted = false;
    }
    const plf = this.plfEdge;
    this.plfEdge = false;

    this.showDepth(this.leftDepth, canopy.left);
    this.showDepth(this.rightDepth, canopy.right);

    // The phone tilted back looks up at the canopy.
    const lookUp = axes ? clamp01(-axes.pitch / LOOK_UP_PITCH_DEG) : 0;

    return { canopy, plf, lookUp };
  }

  /**
   * Says whether the PLF pill may be used.
   *
   * The pill is only for a phone that cannot be rolled, so it stays away
   * as long as there is a tilt sensor to roll.
   */
  setPlfAvailable(on: boolean): void {
    this.plfAvailable = on;
    this.plfPill.hidden = !(this.plfAvailable && this.tilt === null);
  }

  /** Shows the controls, or puts them away. */
  show(on: boolean): void {
    this.layer.hidden = !on;
    if (!on) {
      this.pointers.clear();
      this.frontsHeld = false;
    }
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
    this.pointers.clear();
    this.frontsHeld = false;
    this.layer.remove();
  }

  /** The zone at an edge of the screen that takes a toggle. */
  private edge(region: Region, className: string): HTMLDivElement {
    const node = document.createElement('div');
    node.className = className;
    node.dataset.region = region;
    this.targets.push(node);
    return node;
  }

  /** The thin line along an edge that shows how far the toggle is pulled. */
  private depthLine(side: 'left' | 'right'): HTMLDivElement {
    const line = document.createElement('div');
    line.className = `cn-depth cn-depth-${side}`;
    line.dataset.depth = side;
    return line;
  }

  /** Shows how far a toggle is pulled, as a line that grows. */
  private showDepth(line: HTMLDivElement | null, depth: number): void {
    if (!line) return;
    line.style.transform = `scaleY(${clamp01(depth)})`;
  }

  /** The slider at the bottom, which gives the symmetric brakes. */
  private buildSlider(): void {
    const slider = document.createElement('div');
    slider.className = 'cn-slider';
    slider.dataset.region = 'slider';
    slider.setAttribute('role', 'slider');
    slider.setAttribute('aria-label', 'Brakes');
    slider.setAttribute('aria-valuemin', '0');
    slider.setAttribute('aria-valuemax', '1');

    const height = SLIDER_HEIGHT_FRACTION * this.viewportHeight();
    const top = this.viewportHeight() - SLIDER_BOTTOM_PX - height;
    slider.style.top = `${top}px`;
    slider.style.height = `${height}px`;
    slider.style.width = `${SLIDER_WIDTH_PX}px`;
    slider.style.marginLeft = `${-SLIDER_WIDTH_PX / 2}px`;

    const knob = document.createElement('div');
    knob.className = 'cn-slider-knob';
    knob.dataset.role = 'knob';
    knob.style.width = `${KNOB_SIZE_PX}px`;
    knob.style.height = `${KNOB_SIZE_PX}px`;
    knob.style.marginLeft = `${-KNOB_SIZE_PX / 2}px`;
    slider.appendChild(knob);

    this.slider = slider;
    this.sliderKnob = knob;
    this.targets.push(slider);
    this.layer.appendChild(slider);
    this.moveKnob();
  }

  /** The button that pulls both front risers, for as long as it is held. */
  private buildFronts(): void {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'cn-fronts';
    button.dataset.action = 'fronts';
    button.textContent = 'Fronts';
    button.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      this.frontsHeld = true;
    });
    this.layer.appendChild(button);
  }

  /** The pill that unstows the brakes, until it is tapped. */
  private buildUnstow(): void {
    const pill = document.createElement('button');
    pill.type = 'button';
    pill.className = 'cn-unstow';
    pill.dataset.action = 'unstow';
    pill.textContent = 'Unstow';
    pill.addEventListener('click', () => {
      this.unstowEdge = true;
      this.unstowDone = true;
      pill.hidden = true;
    });
    this.layer.appendChild(pill);
  }

  /** Puts the knob of the slider where the brakes are. */
  private moveKnob(): void {
    if (!this.sliderKnob) return;
    const travel = SLIDER_HEIGHT_FRACTION * this.viewportHeight() - KNOB_SIZE_PX;
    this.sliderKnob.style.top = `${this.sliderValue * travel}px`;
    this.slider?.setAttribute('aria-valuenow', this.sliderValue.toFixed(2));
  }

  /** How far the slider is pulled, from where the finger is. */
  private setSlider(y: number): void {
    const height = SLIDER_HEIGHT_FRACTION * this.viewportHeight();
    const top = this.viewportHeight() - SLIDER_BOTTOM_PX - height;
    const travel = height - KNOB_SIZE_PX;
    this.sliderValue = travel > 0 ? clamp01((y - top - KNOB_SIZE_PX / 2) / travel) : 0;
    this.moveKnob();
  }

  /** How far one side's toggle is pulled. */
  private toggleDepth(side: 'left' | 'right'): number {
    let depth = 0;
    for (const tracked of this.pointers.values()) {
      if (tracked.side !== side || tracked.front) continue;
      depth = Math.max(depth, toggleDepth(tracked.y - tracked.startY, this.viewportHeight()));
    }
    return depth;
  }

  /** How far one side's front riser is pulled. */
  private frontDepth(side: 'left' | 'right'): number {
    let depth = 0;
    for (const tracked of this.pointers.values()) {
      if (tracked.side !== side || !tracked.front) continue;
      depth = Math.max(depth, toggleDepth(tracked.y - tracked.anchorY, this.viewportHeight()));
    }
    return depth;
  }

  /**
   * How far the rear risers are pulled.
   *
   * The rear risers need two hands, so they only come in when two fingers
   * have gone up together.
   */
  private rearDepth(): number {
    const fingers = [...this.pointers.values()].filter((tracked) => tracked.region !== 'slider');
    if (fingers.length < 2) return 0;
    const height = this.viewportHeight();
    let up = Number.POSITIVE_INFINITY;
    for (const tracked of fingers) up = Math.min(up, tracked.startY - tracked.y);
    if (up < REAR_THRESHOLD_FRACTION * height) return 0;
    return clamp01(up / (REAR_TRAVEL_FRACTION * height));
  }

  /**
   * Watches for the two toggles going down together.
   *
   * That is how the brakes are unstowed: both toggles past 0.3, within
   * half a second of each other, and only the first time.
   */
  private checkUnstow(event: PointerEvent): void {
    if (this.unstowDone) return;
    const now = this.eventTimeMs(event);
    if (this.leftCrossMs === null && this.toggleDepth('left') > UNSTOW_DEPTH) {
      this.leftCrossMs = now;
    }
    if (this.rightCrossMs === null && this.toggleDepth('right') > UNSTOW_DEPTH) {
      this.rightCrossMs = now;
    }
    if (this.leftCrossMs === null || this.rightCrossMs === null) return;
    if (Math.abs(this.leftCrossMs - this.rightCrossMs) > UNSTOW_WINDOW_MS) return;
    this.unstowEdge = true;
    this.unstowDone = true;
  }

  /**
   * What the finger that went down is doing.
   *
   * The element it landed on says; a finger that landed on the layer is
   * judged by where it landed.
   */
  private regionFor(event: PointerEvent): Region | null {
    const target = event.target as Element | null;
    if (target && typeof target.closest === 'function') {
      // The pills and the buttons take their own fingers.
      if (target.closest('[data-action]')) return null;
      const region = target.closest('[data-region]');
      const name = region?.getAttribute('data-region');
      if (name === 'toggle-left' || name === 'toggle-right' || name === 'slider') return name;
    }

    // The outer third of each side is that side's toggle; the middle of
    // the screen belongs to the jumper.
    if (this.scheme === 'toggles') {
      const width = this.viewportWidth();
      if (event.clientX <= EDGE_FRACTION * width) return 'toggle-left';
      if (event.clientX >= (1 - EDGE_FRACTION) * width) return 'toggle-right';
    }
    return null;
  }

  /** A finger goes down. */
  private readonly onPointerDown = (event: PointerEvent): void => {
    // A finger that is already down is the same finger, heard twice.
    if (this.pointers.has(event.pointerId)) return;
    // Only the primary mouse button flies the canopy.
    if (typeof event.button === 'number' && event.button !== 0) return;

    const region = this.regionFor(event);
    if (!region) return;

    this.pointers.set(event.pointerId, {
      region,
      side: region === 'toggle-left' ? 'left' : region === 'toggle-right' ? 'right' : null,
      startX: event.clientX,
      startY: event.clientY,
      x: event.clientX,
      y: event.clientY,
      front: false,
      anchorY: event.clientY,
    });

    if (region === 'slider') this.setSlider(event.clientY);

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

    if (tracked.region === 'slider') {
      this.setSlider(tracked.y);
      return;
    }

    // A finger that goes far enough inward is that side's front riser,
    // as long as it has not been pulled down yet.
    if (!tracked.front) {
      const width = this.viewportWidth();
      const height = this.viewportHeight();
      const inward =
        tracked.side === 'left' ? tracked.x - tracked.startX : tracked.startX - tracked.x;
      const down = tracked.y - tracked.startY;
      if (
        inward >= FRONT_INWARD_FRACTION * width &&
        down <= FRONT_ORDER_NOISE_FRACTION * height
      ) {
        tracked.front = true;
        tracked.anchorY = tracked.y;
      }
    }

    this.checkUnstow(event);
  };

  /** A finger is let go. */
  private readonly onPointerUp = (event: PointerEvent): void => {
    this.frontsHeld = false;
    this.pointers.delete(event.pointerId);
  };

  /** A finger is taken away, by a call or by the browser. */
  private readonly onPointerCancel = (event: PointerEvent): void => {
    this.frontsHeld = false;
    this.pointers.delete(event.pointerId);
  };

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
}
