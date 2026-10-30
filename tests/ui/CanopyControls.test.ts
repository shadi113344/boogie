import { describe, it, expect, beforeEach } from 'vitest';
import { CanopyControls } from '@/ui/CanopyControls';
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
  private readonly rate: number;

  constructor(reading: TiltAxes, rateDegS = 0) {
    super(window);
    this.reading = reading;
    this.rate = rateDegS;
  }

  override axes(): TiltAxes | null {
    return { ...this.reading };
  }

  override rollRateDegS(): number {
    return this.rate;
  }
}

interface Built {
  root: HTMLElement;
  controls: CanopyControls;
  element: (selector: string) => HTMLElement;
}

function build(scheme: 'toggles' | 'tilt-slider', tilt: TiltSource | null = null): Built {
  const root = document.createElement('div');
  document.body.appendChild(root);
  const controls = new CanopyControls(root, scheme, tilt);
  const element = (selector: string): HTMLElement => {
    const found = root.querySelector<HTMLElement>(selector);
    if (!found) throw new Error(`the controls have no ${selector}`);
    return found;
  };
  return { root, controls, element };
}

/** How long to wait, so that two gestures are further apart in time. */
function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

beforeEach(() => {
  window.innerWidth = WIDTH;
  window.innerHeight = HEIGHT;
});

describe('CanopyControls', () => {
  it('pulls the right toggle with a drag down the right edge', () => {
    const { controls, element } = build('toggles');
    const right = element('[data-region="toggle-right"]');

    right.dispatchEvent(pointer('pointerdown', { clientX: WIDTH - 10, clientY: 400, pointerId: 1 }));
    right.dispatchEvent(
      pointer('pointermove', { clientX: WIDTH - 10, clientY: 400 + 0.35 * HEIGHT, pointerId: 1 }),
    );

    expect(controls.sample().canopy.right).toBeCloseTo(1, 6);
    expect(controls.sample().canopy.left).toBe(0);
  });

  it('lets the toggle out when the finger is let go', () => {
    const { controls, element } = build('toggles');
    const right = element('[data-region="toggle-right"]');

    right.dispatchEvent(pointer('pointerdown', { clientX: WIDTH - 10, clientY: 400, pointerId: 1 }));
    right.dispatchEvent(
      pointer('pointermove', { clientX: WIDTH - 10, clientY: 400 + 0.35 * HEIGHT, pointerId: 1 }),
    );
    right.dispatchEvent(
      pointer('pointerup', { clientX: WIDTH - 10, clientY: 400 + 0.35 * HEIGHT, pointerId: 1 }),
    );

    expect(controls.sample().canopy.right).toBe(0);
  });

  it('gives the flare when both edges are pulled down', () => {
    const { controls, element } = build('toggles');
    const left = element('[data-region="toggle-left"]');
    const right = element('[data-region="toggle-right"]');

    left.dispatchEvent(pointer('pointerdown', { clientX: 10, clientY: 400, pointerId: 1 }));
    right.dispatchEvent(pointer('pointerdown', { clientX: WIDTH - 10, clientY: 400, pointerId: 2 }));
    left.dispatchEvent(
      pointer('pointermove', { clientX: 10, clientY: 400 + 0.35 * HEIGHT, pointerId: 1 }),
    );
    right.dispatchEvent(
      pointer('pointermove', { clientX: WIDTH - 10, clientY: 400 + 0.35 * HEIGHT, pointerId: 2 }),
    );

    const canopy = controls.sample().canopy;
    expect(canopy.left).toBeCloseTo(1, 6);
    expect(canopy.right).toBeCloseTo(1, 6);
  });

  it('pulls the front riser when the finger goes in and then down', () => {
    const { controls, element } = build('toggles');
    const left = element('[data-region="toggle-left"]');

    left.dispatchEvent(pointer('pointerdown', { clientX: 20, clientY: 400, pointerId: 1 }));
    left.dispatchEvent(
      pointer('pointermove', { clientX: 20 + 0.05 * WIDTH, clientY: 400, pointerId: 1 }),
    );
    left.dispatchEvent(
      pointer('pointermove', {
        clientX: 20 + 0.05 * WIDTH,
        clientY: 400 + 0.35 * HEIGHT,
        pointerId: 1,
      }),
    );

    const canopy = controls.sample().canopy;
    expect(canopy.frontLeft).toBeCloseTo(1, 6);
    expect(canopy.left).toBe(0);
    expect(canopy.frontRight).toBe(0);
  });

  it('pulls the rear risers when two fingers go up', () => {
    const { controls, element } = build('toggles');
    const left = element('[data-region="toggle-left"]');
    const right = element('[data-region="toggle-right"]');

    left.dispatchEvent(pointer('pointerdown', { clientX: 10, clientY: 500, pointerId: 1 }));
    right.dispatchEvent(pointer('pointerdown', { clientX: WIDTH - 10, clientY: 500, pointerId: 2 }));
    left.dispatchEvent(
      pointer('pointermove', { clientX: 10, clientY: 500 - 0.2 * HEIGHT, pointerId: 1 }),
    );
    right.dispatchEvent(
      pointer('pointermove', { clientX: WIDTH - 10, clientY: 500 - 0.2 * HEIGHT, pointerId: 2 }),
    );

    const canopy = controls.sample().canopy;
    expect(canopy.rear).toBeCloseTo(1, 6);
    expect(canopy.left).toBe(0);
    expect(canopy.right).toBe(0);
  });

  it('leaves the rear risers alone when only one finger goes up', () => {
    const { controls, element } = build('toggles');
    const left = element('[data-region="toggle-left"]');

    left.dispatchEvent(pointer('pointerdown', { clientX: 10, clientY: 500, pointerId: 1 }));
    left.dispatchEvent(
      pointer('pointermove', { clientX: 10, clientY: 500 - 0.2 * HEIGHT, pointerId: 1 }),
    );

    expect(controls.sample().canopy.rear).toBe(0);
  });

  it('keeps the toggle when the finger is pulled down before it goes in', () => {
    const { controls, element } = build('toggles');
    const left = element('[data-region="toggle-left"]');

    left.dispatchEvent(pointer('pointerdown', { clientX: 20, clientY: 400, pointerId: 1 }));
    left.dispatchEvent(
      pointer('pointermove', { clientX: 20, clientY: 400 + 0.35 * HEIGHT, pointerId: 1 }),
    );
    left.dispatchEvent(
      pointer('pointermove', {
        clientX: 20 + 0.05 * WIDTH,
        clientY: 400 + 0.35 * HEIGHT,
        pointerId: 1,
      }),
    );

    const canopy = controls.sample().canopy;
    expect(canopy.frontLeft).toBe(0);
    expect(canopy.left).toBeCloseTo(1, 6);
  });

  it('unstows the brakes when both toggles go past 0.3 together', () => {
    const { controls, element } = build('toggles');
    const left = element('[data-region="toggle-left"]');
    const right = element('[data-region="toggle-right"]');

    left.dispatchEvent(pointer('pointerdown', { clientX: 10, clientY: 400, pointerId: 1 }));
    right.dispatchEvent(pointer('pointerdown', { clientX: WIDTH - 10, clientY: 400, pointerId: 2 }));
    left.dispatchEvent(
      pointer('pointermove', { clientX: 10, clientY: 400 + 0.35 * HEIGHT, pointerId: 1 }),
    );
    right.dispatchEvent(
      pointer('pointermove', { clientX: WIDTH - 10, clientY: 400 + 0.35 * HEIGHT, pointerId: 2 }),
    );

    expect(controls.sample().canopy.unstow).toBe(true);
    expect(controls.sample().canopy.unstow).toBe(false);
  });

  it('unstows the brakes only once', () => {
    const { controls, element } = build('toggles');
    const left = element('[data-region="toggle-left"]');
    const right = element('[data-region="toggle-right"]');

    const pullBoth = (id: number): void => {
      left.dispatchEvent(pointer('pointerdown', { clientX: 10, clientY: 400, pointerId: id }));
      right.dispatchEvent(pointer('pointerdown', { clientX: WIDTH - 10, clientY: 400, pointerId: id + 1 }));
      left.dispatchEvent(
        pointer('pointermove', { clientX: 10, clientY: 400 + 0.35 * HEIGHT, pointerId: id }),
      );
      right.dispatchEvent(
        pointer('pointermove', { clientX: WIDTH - 10, clientY: 400 + 0.35 * HEIGHT, pointerId: id + 1 }),
      );
    };

    pullBoth(1);
    expect(controls.sample().canopy.unstow).toBe(true);

    left.dispatchEvent(pointer('pointerup', { clientX: 10, clientY: 400 + 0.35 * HEIGHT, pointerId: 1 }));
    right.dispatchEvent(
      pointer('pointerup', { clientX: WIDTH - 10, clientY: 400 + 0.35 * HEIGHT, pointerId: 2 }),
    );

    pullBoth(3);
    expect(controls.sample().canopy.unstow).toBe(false);
  });

  it('does not unstow when the two toggles are too far apart in time', async () => {
    const { controls, element } = build('toggles');
    const left = element('[data-region="toggle-left"]');
    const right = element('[data-region="toggle-right"]');

    left.dispatchEvent(pointer('pointerdown', { clientX: 10, clientY: 400, pointerId: 1 }));
    left.dispatchEvent(
      pointer('pointermove', { clientX: 10, clientY: 400 + 0.35 * HEIGHT, pointerId: 1 }),
    );

    await wait(600);

    right.dispatchEvent(pointer('pointerdown', { clientX: WIDTH - 10, clientY: 400, pointerId: 2 }));
    right.dispatchEvent(
      pointer('pointermove', { clientX: WIDTH - 10, clientY: 400 + 0.35 * HEIGHT, pointerId: 2 }),
    );

    expect(controls.sample().canopy.unstow).toBe(false);
  });

  it('banks with the tilt and adds the slider in the tilt-slider scheme', () => {
    const tilt = new StubTilt({ pitch: 0, roll: 25 });
    const { controls, element } = build('tilt-slider', tilt);
    const slider = element('[data-region="slider"]');
    const knob = element('[data-role="knob"]');

    const top = Number.parseFloat(slider.style.top);
    const height = Number.parseFloat(slider.style.height);
    const knobSize = Number.parseFloat(knob.style.height);
    const travel = height - knobSize;
    const y = top + knobSize / 2 + 0.4 * travel;

    slider.dispatchEvent(pointer('pointerdown', { clientX: WIDTH / 2, clientY: y, pointerId: 1 }));
    slider.dispatchEvent(pointer('pointermove', { clientX: WIDTH / 2, clientY: y, pointerId: 1 }));

    const canopy = controls.sample().canopy;
    expect(canopy.right).toBeCloseTo(1, 6);
    expect(canopy.left).toBeCloseTo(0.4, 6);
  });

  it('gives both front risers while the Fronts button is held', () => {
    const { controls, element } = build('tilt-slider');
    const fronts = element('[data-action="fronts"]');

    fronts.dispatchEvent(pointer('pointerdown', { clientX: 60, clientY: 780, pointerId: 1 }));
    expect(controls.sample().canopy.frontLeft).toBe(1);
    expect(controls.sample().canopy.frontRight).toBe(1);

    window.dispatchEvent(pointer('pointerup', { clientX: 60, clientY: 780, pointerId: 1 }));
    expect(controls.sample().canopy.frontLeft).toBe(0);
    expect(controls.sample().canopy.frontRight).toBe(0);
  });

  it('unstows the brakes from the pill in the tilt-slider scheme', () => {
    const { controls, element } = build('tilt-slider');
    const pill = element('[data-action="unstow"]');

    expect(pill.hidden).toBe(false);

    pill.click();
    expect(controls.sample().canopy.unstow).toBe(true);
    expect(controls.sample().canopy.unstow).toBe(false);
    expect(pill.hidden).toBe(true);
  });

  it('looks up when the phone is tilted back', () => {
    const tilt = new StubTilt({ pitch: -35, roll: 0 });
    const { controls } = build('toggles', tilt);

    expect(controls.sample().lookUp).toBeCloseTo(1, 6);
  });

  it('does not look up when the phone is tilted forward', () => {
    const tilt = new StubTilt({ pitch: 20, roll: 0 });
    const { controls } = build('toggles', tilt);

    expect(controls.sample().lookUp).toBe(0);
  });

  it('gives the PLF from a quick roll', () => {
    const tilt = new StubTilt({ pitch: 0, roll: 0 }, 200);
    const { controls } = build('toggles', tilt);

    expect(controls.sample().plf).toBe(true);
    expect(controls.sample().plf).toBe(false);
  });

  it('sets the PLF from the pill for one sample', () => {
    const { controls, element } = build('toggles');
    const pill = element('[data-action="plf"]');

    expect(pill.hidden).toBe(true);
    controls.setPlfAvailable(true);
    expect(pill.hidden).toBe(false);

    pill.click();
    expect(controls.sample().plf).toBe(true);
    expect(controls.sample().plf).toBe(false);
  });

  it('keeps the PLF pill away when the phone can be rolled', () => {
    const tilt = new StubTilt({ pitch: 0, roll: 0 });
    const { controls, element } = build('toggles', tilt);

    controls.setPlfAvailable(true);
    expect(element('[data-action="plf"]').hidden).toBe(true);
  });

  it('shows and hides the controls', () => {
    const { controls, element } = build('toggles');
    const layer = element('.cn-controls');

    controls.show(true);
    expect(layer.hidden).toBe(false);

    controls.show(false);
    expect(layer.hidden).toBe(true);
  });

  it('hears nothing after it is disposed', () => {
    const { root, controls, element } = build('toggles');
    const right = element('[data-region="toggle-right"]');

    controls.dispose();
    expect(root.querySelector('.cn-controls')).toBeNull();

    right.dispatchEvent(pointer('pointerdown', { clientX: WIDTH - 10, clientY: 400, pointerId: 1 }));
    right.dispatchEvent(
      pointer('pointermove', { clientX: WIDTH - 10, clientY: 400 + 0.35 * HEIGHT, pointerId: 1 }),
    );

    expect(controls.sample().canopy.right).toBe(0);
  });
});
