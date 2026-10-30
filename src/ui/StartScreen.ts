/**
 * The screen before the jump.
 *
 * It says where the jump is, whether the ground under the landing area is
 * ready yet, and how the jumper wants to fly: with the phone or with the
 * fingers. Tilt is the default, but the choice is remembered, and a phone
 * that will not give up its orientation sensor falls back to the touch
 * controls with a word of explanation rather than a refusal.
 */

import { requestTiltPermission } from '@/ui/input/tilt';
import type { TiltPermission } from '@/ui/input/tilt';
import type { UnitSystem } from '@/sim/units';

/** The two ways the jumper can fly. */
export type ControlScheme = 'tilt' | 'touch';

/** The way the browser is asked for the orientation sensor. */
export type TiltPermissionRequester = () => Promise<TiltPermission>;

/** The key the chosen scheme is remembered under. */
const SCHEME_KEY = 'boogie.controlScheme';

/** The names the choice may be found under, so an older spelling is not lost. */
const SCHEME_KEYS = [SCHEME_KEY];

/** What the jumper is told when the sensor is not available. */
const TILT_FALLBACK_NOTE = 'Tilt is not available on this device, using touch.';

/** What the tilt controls do, in one line. */
const TILT_EXPLANATION =
  'Tilt the phone to turn and to drive; a thumb on the left half of the screen, ' +
  'dragged up, slows the fall and dragged down speeds it up.';

/** What the touch controls do, in one line. */
const TOUCH_EXPLANATION =
  'A thumb pad on the left turns and drives; a drag on the right half of the ' +
  'screen changes the fall rate, up for slower and down for faster.';

/** The way the browser is asked, unless a test or a caller says otherwise. */
let permissionRequester: TiltPermissionRequester = requestTiltPermission;

/**
 * Replaces the way the browser is asked for the orientation sensor.
 *
 * Passing null puts the real one back. The start screen asks through this,
 * so a test can answer "denied" without pretending to be a browser.
 */
export function setTiltPermissionRequester(fn: TiltPermissionRequester | null): void {
  permissionRequester = fn ?? requestTiltPermission;
}

/** Builds an element with a class and, maybe, some text. */
function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** The screen: the drop zone, the loading line, the schemes and the jump. */
export class StartScreen {
  /** The whole screen, over the world behind it. */
  private readonly screen: HTMLDivElement;

  /** The panel the jumper reads. */
  private readonly panel: HTMLDivElement;

  /** The line that says what is still loading. */
  private readonly loadingLine: HTMLParagraphElement;

  /** The line that says why the tilt is not being used. */
  private readonly note: HTMLParagraphElement;

  /** The button that starts the jump. */
  private readonly jumpButton: HTMLButtonElement;

  /** The button that picks the tilt. */
  private readonly tiltButton: HTMLButtonElement;

  /** The button that picks the touch controls. */
  private readonly touchButton: HTMLButtonElement;

  /** The scheme the jumper has chosen. */
  private scheme: ControlScheme;

  /** Whether the ground under the landing area is ready. */
  private ready = false;

  /** Set while the browser is being asked for the orientation sensor. */
  private asking = false;

  /** The way the browser is asked, when the caller gave one of its own. */
  private readonly ask: TiltPermissionRequester | null;

  /** Called when the jumper is ready to leave the aircraft. */
  onJump: ((scheme: ControlScheme) => void) | null = null;

  constructor(
    root: HTMLElement,
    o: { dzName: string; units: UnitSystem; requestTiltPermission?: TiltPermissionRequester },
  ) {
    this.ask = o.requestTiltPermission ?? null;

    this.panel = element('div', 'start-panel');
    this.panel.appendChild(element('h1', 'start-dz', o.dzName));

    this.loadingLine = element('p', 'start-loading');
    this.loadingLine.dataset.role = 'loading';
    this.loadingLine.hidden = true;
    this.panel.appendChild(this.loadingLine);

    this.tiltButton = element('button', 'start-scheme', 'Tilt');
    this.tiltButton.type = 'button';
    this.tiltButton.dataset.scheme = 'tilt';
    this.tiltButton.addEventListener('click', () => this.choose('tilt', true));

    this.touchButton = element('button', 'start-scheme', 'Touch');
    this.touchButton.type = 'button';
    this.touchButton.dataset.scheme = 'touch';
    this.touchButton.addEventListener('click', () => this.choose('touch', true));

    this.panel.appendChild(this.choice('tilt', this.tiltButton, TILT_EXPLANATION));
    this.panel.appendChild(this.choice('touch', this.touchButton, TOUCH_EXPLANATION));

    this.note = element('p', 'start-note');
    this.note.dataset.role = 'note';
    this.note.hidden = true;
    this.panel.appendChild(this.note);

    this.panel.appendChild(
      element(
        'p',
        'start-units',
        o.units === 'ft'
          ? 'Heights and speeds are shown in feet and miles per hour.'
          : 'Heights and speeds are shown in metres and kilometres per hour.',
      ),
    );

    this.jumpButton = element('button', 'start-jump', 'Jump');
    this.jumpButton.type = 'button';
    this.jumpButton.dataset.action = 'jump';
    this.jumpButton.disabled = true;
    this.jumpButton.addEventListener('click', () => void this.start());
    this.panel.appendChild(this.jumpButton);

    this.screen = element('div', 'start-screen');
    this.screen.appendChild(this.panel);
    root.appendChild(this.screen);

    this.scheme = this.remembered();
    this.choose(this.scheme, false);
  }

  /** Says what is still loading, or nothing when there is nothing to wait for. */
  setLoading(text: string | null): void {
    this.loadingLine.textContent = text ?? '';
    this.loadingLine.hidden = text === null;
  }

  /** Enables the jump button, once the ground is there. */
  setReady(ready: boolean): void {
    this.ready = ready;
    this.jumpButton.disabled = !ready || this.asking;
  }

  /** Shows the screen, or puts it away. */
  show(on: boolean): void {
    this.screen.hidden = !on;
  }

  /** A scheme: its button and the line that explains it. */
  private choice(
    scheme: ControlScheme,
    button: HTMLButtonElement,
    explanation: string,
  ): HTMLDivElement {
    const row = element('div', 'start-choice');
    row.dataset.choice = scheme;
    row.appendChild(button);
    row.appendChild(element('p', 'start-scheme-note', explanation));
    return row;
  }

  /** Picks a scheme, and remembers it when the jumper picked it. */
  private choose(scheme: ControlScheme, remember: boolean): void {
    this.scheme = scheme;
    this.tiltButton.setAttribute('aria-pressed', String(scheme === 'tilt'));
    this.touchButton.setAttribute('aria-pressed', String(scheme === 'touch'));
    if (remember) this.remember(scheme);
  }

  /** Writes the choice down, for the next jump. */
  private remember(scheme: ControlScheme): void {
    try {
      window.localStorage.setItem(SCHEME_KEY, scheme);
    } catch {
      // A phone that will not store anything still jumps.
    }
  }

  /** The scheme of the last jump, or tilt when there is none. */
  private remembered(): ControlScheme {
    try {
      for (const key of SCHEME_KEYS) {
        const value = window.localStorage.getItem(key);
        if (value === 'tilt' || value === 'touch') return value;
      }
    } catch {
      // No storage: the default is good enough.
    }
    return 'tilt';
  }

  /** Asks the browser for the sensor, whoever is asking. */
  private requestPermission(): Promise<TiltPermission> {
    return (this.ask ?? permissionRequester)();
  }

  /**
   * The jump: the permission dance first, then the jump itself.
   *
   * A phone that will not give up its sensor does not stop the jump: the
   * touch controls take over and the jumper is told why.
   */
  private async start(): Promise<void> {
    if (!this.ready || this.asking) return;
    this.asking = true;
    this.jumpButton.disabled = true;
    try {
      let scheme = this.scheme;
      if (scheme === 'tilt') {
        const permission = await this.requestPermission();
        if (permission !== 'granted') {
          scheme = 'touch';
          this.fallbackToTouch();
        }
      }
      this.onJump?.(scheme);
    } catch {
      // A browser that throws while asking still jumps, with the fingers.
      this.fallbackToTouch();
      this.onJump?.('touch');
    } finally {
      this.asking = false;
      this.jumpButton.disabled = !this.ready;
    }
  }

  /** Switches to the touch controls and says so. */
  private fallbackToTouch(): void {
    this.choose('touch', false);
    this.note.textContent = TILT_FALLBACK_NOTE;
    this.note.hidden = false;
  }
}
