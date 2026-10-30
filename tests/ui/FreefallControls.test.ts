import { describe, it, expect, beforeEach } from 'vitest';
import { FreefallControls } from '@/ui/FreefallControls';
import { TiltSource } from '@/ui/input/tilt';
import type { TiltAxes } from '@/ui/input/tilt';

/** The screen the controls are laid out on. */
const WIDTH = 390;
const HEIGHT = 844;

interface PointerOptions {
  clientX: number;
  clientY: number;
  pointerId: number;
  bubbles?: boolean;
}

/** A finger on the glass. */
function pointer(type: string, o: PointerOptions): PointerEvent {
  return new PointerEvent(type, {
    clientX: o.clientX,
    clientY: o.clientY,
    pointerId: o.pointerId,
    button: 0,
    pointerType: 'touch',
    isPrimary: true,
    bubbles: o.bubbles ?? true,
    cancelable: true,
  });
}

/** A tilt sensor that always reads the same thing. */
class StubTilt extends TiltSource {
  private readonly reading: TiltAxes;

  constructor(reading: TiltAxes) {
    super(window);
    this.reading = reading;
  }

  override axes(): TiltAxes | null {
    return { ...this.reading };
  }
}

interface Built {
  root: HTMLElement;
  controls: FreefallControls;
  element: (selector: string) => HTMLElement;
}

function build(scheme: 'tilt' | 'touch', tilt: TiltSource | null = null): Built {
  const root = document.createElement('div');
  document.body.appendChild(root);
  const controls = new FreefallControls(root, scheme, tilt);
  const element = (selector: string): HTMLElement => {
    const found = root.querySelector<HTMLElement>(selector);
    if (!found) throw new Error(`the controls have no ${selector}`);
    return found;
  };
  return { root, controls, element };
}

beforeEach(() => {
  window.innerWidth = WIDTH;
  window.innerHeight = HEIGHT;
});

describe('FreefallControls', () => {
  it('pulls once when the handle is swiped outward', () => {
    const { controls, element } = build('tilt');
    const handle = element('[data-action="pull"]');

    handle.dispatchEvent(pointer('pointerdown', { clientX: 300, clientY: 700, pointerId: 1 }));
    handle.dispatchEvent(pointer('pointerup', { clientX: 360, clientY: 700, pointerId: 1 }));

    expect(controls.sample().pull).toBe(true);
    expect(controls.sample().pull).toBe(false);
  });

  it('pulls when the swipe is given as a move and a release without a position', () => {
    const { controls, element } = build('tilt');
    const handle = element('[data-action="pull"]');

    handle.dispatchEvent(pointer('pointerdown', { clientX: 300, clientY: 700, pointerId: 1 }));
    handle.dispatchEvent(pointer('pointermove', { clientX: 360, clientY: 700, pointerId: 1 }));
    handle.dispatchEvent(pointer('pointerup', { clientX: 0, clientY: 0, pointerId: 1 }));

    expect(controls.sample().pull).toBe(true);
  });

  it('does not pull when the handle is only touched', () => {
    const { controls, element } = build('tilt');
    const handle = element('[data-action="pull"]');

    handle.dispatchEvent(pointer('pointerdown', { clientX: 300, clientY: 700, pointerId: 1 }));
    handle.dispatchEvent(pointer('pointerup', { clientX: 305, clientY: 700, pointerId: 1 }));

    expect(controls.sample().pull).toBe(false);
  });

  it('gives the fall rate from a drag on the left half in the tilt scheme', () => {
    const { controls, element } = build('tilt');
    const left = element('[data-region="fall"]');

    left.dispatchEvent(pointer('pointerdown', { clientX: 100, clientY: 600, pointerId: 2 }));
    left.dispatchEvent(pointer('pointermove', { clientX: 100, clientY: 600 - 0.15 * HEIGHT, pointerId: 2 }));

    expect(controls.sample().freefall.fallRate).toBeCloseTo(-1, 6);
  });

  it('arches when the drag on the left half goes down', () => {
    const { controls, element } = build('tilt');
    const left = element('[data-region="fall"]');

    left.dispatchEvent(pointer('pointerdown', { clientX: 100, clientY: 600, pointerId: 2 }));
    left.dispatchEvent(pointer('pointermove', { clientX: 100, clientY: 600 + 0.15 * HEIGHT, pointerId: 2 }));

    expect(controls.sample().freefall.fallRate).toBeCloseTo(1, 6);
  });

  it('takes the drag even when the pointer events do not bubble', () => {
    const { controls, element } = build('tilt');
    const left = element('[data-region="fall"]');

    left.dispatchEvent(
      pointer('pointerdown', { clientX: 100, clientY: 600, pointerId: 2, bubbles: false }),
    );
    left.dispatchEvent(
      pointer('pointermove', { clientX: 100, clientY: 600 - 0.15 * HEIGHT, pointerId: 2, bubbles: false }),
    );

    expect(controls.sample().freefall.fallRate).toBeCloseTo(-1, 6);
  });

  it('turns and drives with the tilt in the tilt scheme', () => {
    const tilt = new StubTilt({ pitch: 25, roll: 25 });
    const { controls } = build('tilt', tilt);

    const freefall = controls.sample().freefall;
    expect(freefall.turn).toBeCloseTo(1, 6);
    expect(freefall.drive).toBeCloseTo(1, 6);
    expect(freefall.fallRate).toBe(0);
  });

  it('turns and drives from the thumb pad in the touch scheme', () => {
    const { controls, element } = build('touch');
    const pad = element('[data-region="pad"]');

    pad.dispatchEvent(pointer('pointerdown', { clientX: 80, clientY: 760, pointerId: 3 }));
    pad.dispatchEvent(pointer('pointermove', { clientX: 80 + 0.12 * WIDTH, clientY: 760 - 0.12 * WIDTH, pointerId: 3 }));

    const freefall = controls.sample().freefall;
    expect(freefall.turn).toBeCloseTo(1, 6);
    expect(freefall.drive).toBeCloseTo(1, 6);
  });

  it('gives the fall rate from a drag on the right in the touch scheme', () => {
    const { controls, element } = build('touch');
    const right = element('[data-region="fall"]');

    right.dispatchEvent(pointer('pointerdown', { clientX: 300, clientY: 600, pointerId: 4 }));
    right.dispatchEvent(
      pointer('pointermove', { clientX: 300, clientY: 600 - 0.15 * HEIGHT, pointerId: 4 }),
    );

    expect(controls.sample().freefall.fallRate).toBeCloseTo(-1, 6);
  });

  it('flips the track when the track button is tapped', () => {
    const { controls, element } = build('tilt');
    const track = element('[data-action="track"]');

    expect(controls.sample().freefall.track).toBe(false);

    track.click();
    expect(controls.sample().freefall.track).toBe(true);

    track.click();
    expect(controls.sample().freefall.track).toBe(false);
  });

  it('flips the track when the track button is tapped with a finger', () => {
    const { controls, element } = build('tilt');
    const track = element('[data-action="track"]');

    track.dispatchEvent(pointer('pointerdown', { clientX: 40, clientY: 40, pointerId: 5 }));
    track.dispatchEvent(pointer('pointerup', { clientX: 40, clientY: 40, pointerId: 5 }));

    expect(controls.sample().freefall.track).toBe(true);
  });

  it('shows and hides the controls', () => {
    const { controls, element } = build('tilt');
    const layer = element('.ff-controls');

    controls.show(true);
    expect(layer.hidden).toBe(false);

    controls.show(false);
    expect(layer.hidden).toBe(true);
  });

  it('hears nothing after it is disposed', () => {
    const { root, controls, element } = build('tilt');
    const handle = element('[data-action="pull"]');

    controls.dispose();
    expect(root.querySelector('.ff-controls')).toBeNull();

    handle.dispatchEvent(pointer('pointerdown', { clientX: 300, clientY: 700, pointerId: 6 }));
    handle.dispatchEvent(pointer('pointerup', { clientX: 360, clientY: 700, pointerId: 6 }));

    expect(controls.sample().pull).toBe(false);
  });
});
