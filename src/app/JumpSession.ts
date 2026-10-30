/**
 * One jump, from the exit to the pull.
 *
 * The session is the bridge between the pure simulation and the app: it
 * samples the controls once a frame, hands the input to the fixed 120 Hz
 * step, and drives everything that follows from the state of the jump — the
 * first-person camera, the wrist altimeter on the overlay, and the sound.
 *
 * The session does not own the app: it is given a narrow host, so it can be
 * flown in a test without a WebGL context and without a ground of its own.
 *
 * The rules it keeps:
 *
 * - The simulation never runs faster than real time. A frame that arrives
 *   late catches up at most twelve steps and lets the rest of the time go.
 * - Every step of a frame uses the input sampled for that frame, and the
 *   edges (the pull) are given to the first step only.
 * - A tab that comes back from the background does not jump the jumper
 *   ahead: the time spent in the background is not given to the simulation.
 */

import * as THREE from 'three';
import { JumpAudio } from '@/audio/JumpAudio';
import { CANOPIES, DEFAULT_CANOPY, type CanopyId } from '@/data/canopies';
import type { DropZone } from '@/data/dropzones';
import { JumpCamera, freefallEye } from '@/render/JumpCamera';
import { WristAltimeter } from '@/render/WristAltimeter';
import { DEFAULT_AUDIBLE, type AudibleAlarm } from '@/sim/audible';
import { FixedStep } from '@/sim/FixedStep';
import { bodyFrame } from '@/sim/freefall/freefall';
import { NEUTRAL_INPUT, type JumpInput } from '@/sim/inputs';
import { Jump } from '@/sim/Jump';
import type { JumperParams } from '@/sim/jumper';
import { Rng } from '@/sim/rng';
import { defaultExit } from '@/sim/spot';
import { FT, KT, formatAltitude } from '@/sim/units';
import { Wind, type WindProfile } from '@/sim/wind';
import { FreefallControls } from '@/ui/FreefallControls';
import type { ControlScheme } from '@/ui/StartScreen';
import { KeyboardSource } from '@/ui/input/keyboard';
import { TiltSource } from '@/ui/input/tilt';

/**
 * What the session needs from the app it is flying in.
 *
 * The host is narrow on purpose: the session never draws the world, never
 * fetches a tile and never reads the URL. It asks where the ground is, where
 * the world has been rebased to, and it puts the watch on the overlay.
 */
export interface JumpHost {
  /** The camera of the world: the jumper's eye. */
  camera: THREE.PerspectiveCamera;
  /** The scene and the camera of the first-person instruments. */
  overlay: { scene: THREE.Scene; camera: THREE.PerspectiveCamera };
  /** Where the world has been rebased to, in metres. */
  originOffset(): { x: number; z: number };
  /** The height of the ground at a place in the local frame, in metres. */
  groundY(x: number, z: number): number;
  /** The height of the landing area above mean sea level, in metres. */
  lzGroundY: number;
  /** Where the controls and the cards of the app go. */
  uiRoot: HTMLElement;
  /** True when the developer overlay is on. */
  debug: boolean;
  /** The window the jump is in. */
  window: Window;
  /** The sound of the jump, when the app has one of its own. */
  audio?: JumpAudio;
}

/** Everything the session needs to know before the jump starts. */
export interface JumpSessionOptions {
  /** The drop zone the jump is made over. */
  dz: DropZone;
  /** The jumper and their gear. */
  jumper: JumperParams;
  /** The wind over the drop zone. */
  wind: WindProfile;
  /** The canopy the jumper is going to fly. */
  canopyId: string;
  /** The seed of the jump: the same seed and the same inputs fly it again. */
  seed: number;
  /** The way the jumper is flying: with the phone or with the fingers. */
  scheme: ControlScheme;
}

/** The speed of the aircraft at the exit: 95 knots true. */
const AIRCRAFT_TAS_MS = 95 * KT;

/** The height the jumper pulls at, in feet above the landing area. */
const PULL_ALTITUDE_FT = 3500;

/** How far the watch sits in front of the eye, in metres. */
const WATCH_DISTANCE_M = 0.3;

/** How far to the left of the centre the watch sits, of the half width. */
const WATCH_LEFT_FRACTION = 0.55;

/** How far below the centre the watch sits, of the half height. */
const WATCH_DOWN_FRACTION = 0.6;

/** The canopy of the jumper, when the name is one the app knows. */
function canopyIdOf(id: string): CanopyId {
  return id in CANOPIES ? (id as CanopyId) : DEFAULT_CANOPY;
}

/** The stronger of two commands on an axis: the one that is further from zero. */
function stronger(a: number, b: number): number {
  return Math.abs(a) >= Math.abs(b) ? a : b;
}

export class JumpSession {
  /** The jump: the simulation of the jumper, from the exit to the ground. */
  readonly jump: Jump;

  /**
   * Called when the jump is over and the app should go back to the start
   * screen: when the player asks for another jump, and, once the canopy
   * lands, when the jumper is on the ground.
   */
  onEnd: ((jump: Jump) => void) | null = null;

  /** The input of the last frame, for the developer overlay. */
  get input(): JumpInput {
    return this.currentInput;
  }

  /** The heading the jumper is flying, in radians clockwise from north. */
  get headingRad(): number {
    const forward = bodyFrame(this.jump.freefall).forward;
    return Math.atan2(forward.x, -forward.z);
  }

  private readonly host: JumpHost;

  /** The fixed step the simulation runs at. */
  private readonly fixed: FixedStep;

  /** The touch layer of the freefall. */
  private readonly controls: FreefallControls;

  /** The keyboard of the window. */
  private readonly keyboard: KeyboardSource;

  /** The tilt of the phone, when the jumper is flying with it. */
  private readonly tilt: TiltSource | null;

  /** The camera of the first-person view. */
  private readonly camera: JumpCamera;

  /** The watch on the wrist. */
  private readonly altimeter: WristAltimeter;

  /** The sound of the jump. */
  private readonly audio: JumpAudio;

  /** True when the session made the sound itself, and has to let it go. */
  private readonly ownsAudio: boolean;

  /** The units of the drop zone. */
  private readonly units: 'ft' | 'm';

  /** The input of this frame, used by every step of the frame. */
  private currentInput: JumpInput = { ...NEUTRAL_INPUT };

  /** The pull that has not been given to the simulation yet. */
  private pendingPull = false;

  /** How many of the jump's events have been handled. */
  private eventCursor = 0;

  /** True once the simulation has been frozen, after the pull. */
  private frozen = false;

  /** True while the page is in the background. */
  private paused = false;

  /** The card shown after the pull. */
  private card: HTMLDivElement | null = null;

  /** True once the session has been let go. */
  private disposed = false;

  /**
   * @param host the app the jump is flown in
   * @param opts everything the jump needs to know before it starts
   */
  constructor(host: JumpHost, opts: JumpSessionOptions) {
    this.host = host;
    this.units = opts.dz.units;

    // The wind of the spot. The spot is made of the mean wind, and the
    // mean does not depend on the seed, so the wind here is only used to
    // put the exit where it belongs.
    const spotWind = new Wind(opts.wind, new Rng(opts.seed));

    const exit = defaultExit({
      lzGroundY: host.lzGroundY,
      exitAltitudeAglM: opts.dz.exitAltitudeFt * FT,
      wind: spotWind,
      aircraftTasMs: AIRCRAFT_TAS_MS,
      jumpRunHeadingDeg: opts.dz.jumpRunHeadingDeg,
    });

    this.jump = new Jump({
      seed: opts.seed,
      jumper: opts.jumper,
      wind: opts.wind,
      temperatureOffsetC: 0,
      exitPos: exit.pos,
      exitHeadingRad: exit.headingRad,
      aircraftTasMs: AIRCRAFT_TAS_MS,
      lzGroundY: host.lzGroundY,
      ground: (x, z) => host.groundY(x, z),
      canopyId: canopyIdOf(opts.canopyId),
      pullAltitudeFt: PULL_ALTITUDE_FT,
      audible: DEFAULT_AUDIBLE,
    });

    // The tilt: the attitude the phone is held in now is the zero.
    this.tilt = opts.scheme === 'tilt' ? new TiltSource(host.window) : null;
    if (this.tilt) {
      this.tilt.start();
      this.tilt.calibrate();
    }

    this.controls = new FreefallControls(host.uiRoot, opts.scheme, this.tilt);
    this.controls.show(true);
    this.keyboard = new KeyboardSource(host.window);

    this.camera = new JumpCamera(host.camera);
    this.altimeter = new WristAltimeter(opts.dz.units);
    host.overlay.scene.add(this.altimeter.object);

    this.ownsAudio = host.audio === undefined;
    this.audio = host.audio ?? new JumpAudio();

    this.fixed = new FixedStep(this.onStep);
    this.currentInput = { ...NEUTRAL_INPUT };

    host.window.addEventListener('visibilitychange', this.onVisibilityChange);
  }

  /**
   * One frame of the jump.
   *
   * The controls are sampled once, the simulation is advanced by the time
   * the frame took, and the camera, the watch and the sound follow the
   * state of the jump.
   *
   * @param dtS the time since the last frame, in seconds
   */
  frame(dtS: number): void {
    if (this.disposed) return;
    // A tab in the background does not fly: the time spent there is not
    // given to the simulation.
    if (this.paused) return;

    if (!this.frozen) {
      this.currentInput = this.sampleInput(dtS);
      this.fixed.advance(dtS);
      this.handleEvents();
    }

    this.updateCamera();
    this.updateAltimeter();
    this.updateAudio();
  }

  /** Lets go of the session: the controls, the watch and the card. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;

    this.host.window.removeEventListener('visibilitychange', this.onVisibilityChange);
    this.controls.dispose();
    this.keyboard.dispose();
    this.tilt?.dispose();
    this.host.overlay.scene.remove(this.altimeter.object);
    this.card?.remove();
    this.card = null;
    if (this.ownsAudio) this.audio.dispose();
  }

  /**
   * The commands of the jumper, from the fingers and from the keys.
   *
   * The two are merged: the stronger command wins on every axis, and the
   * buttons are on if either of them says so. The pull is an edge: it is
   * held until the simulation has taken it.
   */
  private sampleInput(dtS: number): JumpInput {
    const touch = this.controls.sample();
    const keys = this.keyboard.sample(dtS);

    if (touch.pull || keys.pull) this.pendingPull = true;

    return {
      freefall: {
        turn: stronger(touch.freefall.turn, keys.freefall.turn),
        drive: stronger(touch.freefall.drive, keys.freefall.drive),
        fallRate: stronger(touch.freefall.fallRate, keys.freefall.fallRate),
        track: touch.freefall.track || keys.freefall.track,
      },
      pull: false,
      canopy: keys.canopy,
      plf: keys.plf,
    };
  }

  /**
   * One step of the simulation.
   *
   * Every step of the frame uses the input of the frame, and the pull is
   * given to the first step only: the edge is delivered once.
   */
  private readonly onStep = (_dt: number, first: boolean): void => {
    const pull = first && this.pendingPull;
    if (pull) this.pendingPull = false;
    this.jump.step({ ...this.currentInput, pull });
  };

  /** The things that have happened since the last frame. */
  private handleEvents(): void {
    const events = this.jump.events;
    while (this.eventCursor < events.length) {
      const event = events[this.eventCursor];
      this.eventCursor += 1;
      if (!event) continue;

      if (event.type === 'alarm' && event.detail) {
        this.audio.alarm(event.detail as AudibleAlarm);
      } else if (event.type === 'pull') {
        this.freeze(
          `Pull at ${formatAltitude(event.aglM, this.units)}. ` +
            'The canopy arrives in the next update.',
        );
      } else if (event.type === 'touchdown') {
        this.freeze(`The jump is over at ${formatAltitude(event.aglM, this.units)}.`);
      }
    }
  }

  /**
   * Stops the simulation and tells the player what happened.
   *
   * The canopy does not fly yet: the simulation stops where the pull was,
   * and the card says so.
   */
  private freeze(message: string): void {
    if (this.frozen) return;
    this.frozen = true;
    this.controls.show(false);
    this.showCard(message);
  }

  /** The card with the message and the button that starts the next jump. */
  private showCard(message: string): void {
    const card = document.createElement('div');
    card.className = 'jump-card';
    card.dataset.role = 'pull-card';
    card.style.cssText = CARD_STYLE;

    const text = document.createElement('p');
    text.style.cssText = 'margin:0 0 10px';
    text.textContent = message;
    card.appendChild(text);

    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.action = 'jump-again';
    button.textContent = 'Jump again';
    button.style.cssText = BUTTON_STYLE;
    button.addEventListener('click', () => this.onEnd?.(this.jump));
    card.appendChild(button);

    this.host.uiRoot.appendChild(card);
    this.card = card;
  }

  /** The eye of the jumper, looking along the wind and the head. */
  private updateCamera(): void {
    const pose = freefallEye(
      bodyFrame(this.jump.freefall),
      this.jump.airVelocity(),
      this.jump.position(),
    );
    this.camera.apply(pose, this.host.originOffset(), 0);
  }

  /**
   * The watch on the wrist.
   *
   * The watch is in the overlay, in front of the eye, and it is placed from
   * the frustum of the overlay camera: the same place on the screen, on
   * every screen size.
   */
  private updateAltimeter(): void {
    const camera = this.host.overlay.camera;
    const halfHeight = WATCH_DISTANCE_M * Math.tan((camera.fov * Math.PI) / 360);
    const halfWidth = halfHeight * camera.aspect;

    this.altimeter.object.position.set(
      -WATCH_LEFT_FRACTION * halfWidth,
      -WATCH_DOWN_FRACTION * halfHeight,
      -WATCH_DISTANCE_M,
    );
    this.altimeter.setAltitude(this.jump.altitudeAglM());
  }

  /** The wind in the ears, and the siren of the audible altimeter. */
  private updateAudio(): void {
    const air = this.jump.airVelocity();
    const speed = Math.hypot(air.x, air.y, air.z);
    this.audio.setWind(speed, 'freefall');
    this.audio.setContinuous(this.jump.audible.continuous);
  }

  /** The page went to the background, or came back from it. */
  private readonly onVisibilityChange = (): void => {
    const hidden = this.host.window.document?.hidden === true;
    this.paused = hidden;
    if (hidden) {
      // The sound stops with the picture.
      this.audio.setWind(0, 'silent');
      this.audio.setContinuous(null);
    } else {
      void this.audio.resume();
    }
  };
}

/** The card that tells the player what happened. */
const CARD_STYLE = [
  'position:absolute',
  'left:50%',
  'top:50%',
  'transform:translate(-50%,-50%)',
  'padding:18px 22px',
  'border-radius:10px',
  'background:rgba(0,0,0,0.62)',
  'border:1px solid rgba(255,255,255,0.3)',
  'color:#fff',
  'font:14px/1.5 system-ui,-apple-system,sans-serif',
  'text-align:center',
  'pointer-events:auto',
].join(';');

/** The button that starts the next jump. */
const BUTTON_STYLE = [
  'min-height:44px',
  'padding:8px 18px',
  'font:inherit',
  'color:#fff',
  'background:transparent',
  'border:1px solid rgba(255,255,255,0.6)',
  'border-radius:6px',
].join(';');
