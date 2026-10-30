/**
 * One jump, from the exit to the debrief.
 *
 * The session is the bridge between the pure simulation and the app: it
 * samples the controls once a frame, hands the input to the fixed 120 Hz
 * step, and drives everything that follows from the state of the jump — the
 * first-person camera, the wrist altimeter on the overlay, the canopy over
 * the jumper's head, the sound, and the debrief at the end.
 *
 * The session does not own the app: it is given a narrow host, so it can be
 * flown in a test without a WebGL context and without a ground of its own.
 *
 * The rules it keeps:
 *
 * - The simulation never runs faster than real time. A frame that arrives
 *   late catches up at most twelve steps and lets the rest of the time go.
 * - Every step of a frame uses the input sampled for that frame, and the
 *   edges (the pull, the unstow, the PLF) are given to the first step only.
 * - A tab that comes back from the background does not jump the jumper
 *   ahead: the time spent in the background is not given to the simulation.
 * - The phase of the jump drives the view: the jumper's eye in the freefall,
 *   the swing from the ground to the canopy through the opening, and the
 *   canopy's eye under the wing.
 */

import * as THREE from 'three';
import { JumpAudio } from '@/audio/JumpAudio';
import { CANOPIES, DEFAULT_CANOPY, type CanopyId } from '@/data/canopies';
import type { DropZone } from '@/data/dropzones';
import { CanopyModel } from '@/render/CanopyModel';
import {
  JumpCamera,
  canopyEye,
  freefallEye,
  openingEye,
  type CameraPose,
} from '@/render/JumpCamera';
import { WristAltimeter } from '@/render/WristAltimeter';
import { DEFAULT_AUDIBLE, type AudibleAlarm } from '@/sim/audible';
import { computeDebrief, type DebriefData } from '@/sim/debrief';
import { FixedStep } from '@/sim/FixedStep';
import { bodyFrame } from '@/sim/freefall/freefall';
import { NEUTRAL_INPUT, type JumpInput } from '@/sim/inputs';
import { Jump } from '@/sim/Jump';
import type { JumperParams } from '@/sim/jumper';
import type { OpeningStage } from '@/sim/opening';
import { Rng } from '@/sim/rng';
import { defaultExit } from '@/sim/spot';
import { FT, G, KT } from '@/sim/units';
import { Wind, type WindProfile } from '@/sim/wind';
import { CanopyControls, type CanopyScheme } from '@/ui/CanopyControls';
import { DebriefScreen } from '@/ui/DebriefScreen';
import { FreefallControls } from '@/ui/FreefallControls';
import type { ControlScheme } from '@/ui/StartScreen';
import { KeyboardSource } from '@/ui/input/keyboard';
import { TiltSource } from '@/ui/input/tilt';

/**
 * What the session needs from the app it is flying in.
 *
 * The host is narrow on purpose: the session never fetches a tile and never
 * reads the URL. It asks where the ground is, where the world has been
 * rebased to, it puts the watch on the overlay, and it puts the canopy in
 * the scene the jumper is flying through.
 */
export interface JumpHost {
  /** The camera of the world: the jumper's eye. */
  camera: THREE.PerspectiveCamera;
  /** The scene and the camera of the first-person instruments. */
  overlay: { scene: THREE.Scene; camera: THREE.PerspectiveCamera };
  /** The scene the world is drawn in: the canopy of the jumper goes in here. */
  scene: THREE.Scene;
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

/** How high the risers are above the jumper, in metres. */
const RISER_HEIGHT_M = 0.4;

/** How low the PLF is available, in feet above the ground. */
const PLF_HEIGHT_FT = 30;

/** The canopy of the jumper, when the name is one the app knows. */
function canopyIdOf(id: string): CanopyId {
  return id in CANOPIES ? (id as CanopyId) : DEFAULT_CANOPY;
}

/** The stronger of two commands on an axis: the one that is further from zero. */
function stronger(a: number, b: number): number {
  return Math.abs(a) >= Math.abs(b) ? a : b;
}

/** The way the canopy is flown, from the way the freefall is flown. */
function canopySchemeOf(scheme: ControlScheme): CanopyScheme {
  return scheme === 'tilt' ? 'tilt-slider' : 'toggles';
}

export class JumpSession {
  /** The jump: the simulation of the jumper, from the exit to the ground. */
  readonly jump: Jump;

  /**
   * Called when the jumper asks for another jump: the debrief is on the
   * screen and the button under it has been pressed.
   */
  onEnd: ((jump: Jump) => void) | null = null;

  /** The debrief of the jump, once the jumper is on the ground. */
  debrief: DebriefData | null = null;

  /** The input of the last frame, for the developer overlay. */
  get input(): JumpInput {
    return this.currentInput;
  }

  /** The heading the jumper is flying, in radians clockwise from north. */
  get headingRad(): number {
    if (this.jump.canopy) return this.jump.canopyHeadingRad();
    const forward = bodyFrame(this.jump.freefall).forward;
    return Math.atan2(forward.x, -forward.z);
  }

  /** The stage of the opening, for the developer overlay. */
  get openingStage(): string {
    return this.jump.opening?.stage ?? '-';
  }

  /** The biggest load the opening put on the jumper, in g. */
  get maxOpeningG(): number {
    return this.jump.maxOpeningG;
  }

  /** The brakes of the canopy, as the jumper is holding them. */
  get brakes(): string {
    const canopy = this.jump.canopy;
    if (!canopy) return '-';
    return `${canopy.brakeLeft.toFixed(2)}/${canopy.brakeRight.toFixed(2)}`;
  }

  /** The bank of the canopy, in degrees. */
  get bankDeg(): number {
    const canopy = this.jump.canopy;
    return canopy ? (canopy.bank * 180) / Math.PI : 0;
  }

  /** How fast the jumper is going through the air, in metres per second. */
  get airspeedMs(): number {
    const air = this.jump.airVelocity();
    return Math.hypot(air.x, air.y, air.z);
  }

  /** How fast the canopy is sinking, in metres per second. */
  get sinkMs(): number {
    return this.jump.canopy ? -this.jump.velocity().y : 0;
  }

  private readonly host: JumpHost;

  /** The fixed step the simulation runs at. */
  private readonly fixed: FixedStep;

  /** The touch layer of the freefall. */
  private readonly controls: FreefallControls;

  /** The touch layer of the canopy. */
  private readonly canopyControls: CanopyControls;

  /** The debrief at the end of the jump. */
  private readonly debriefScreen: DebriefScreen;

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

  /** The drop zone the jump is made over. */
  private readonly dz: DropZone;

  /** The input of this frame, used by every step of the frame. */
  private currentInput: JumpInput = { ...NEUTRAL_INPUT };

  /** The pull that has not been given to the simulation yet. */
  private pendingPull = false;

  /** The unstow that has not been given to the simulation yet. */
  private pendingUnstow = false;

  /** The PLF that has not been given to the simulation yet. */
  private pendingPlf = false;

  /** How far the jumper is looking up the lines, from 0 to 1. */
  private lookUp = 0;

  /** How many of the jump's events have been handled. */
  private eventCursor = 0;

  /** True while the page is in the background. */
  private paused = false;

  /** True once the debrief has been shown. */
  private debriefShown = false;

  /** The view of the jumper at the throw, for the opening. */
  private throwPose: CameraPose | null = null;

  /** The canopy over the jumper's head. */
  private canopyModel: CanopyModel | null = null;

  /** The velocity of the jumper at the last frame, for the load of the opening. */
  private lastVelocity: { x: number; y: number; z: number } = { x: 0, y: 0, z: 0 };

  /** The time of the jump at the last frame. */
  private lastT = 0;

  /** True once the session has been let go. */
  private disposed = false;

  /**
   * @param host the app the jump is flown in
   * @param opts everything the jump needs to know before it starts
   */
  constructor(host: JumpHost, opts: JumpSessionOptions) {
    this.host = host;
    this.dz = opts.dz;

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

    // The canopy is flown with the same scheme as the freefall: the tilt
    // banks the canopy and the slider gives the brakes, the fingers work
    // the two edges of the screen.
    this.canopyControls = new CanopyControls(
      host.uiRoot,
      canopySchemeOf(opts.scheme),
      this.tilt,
    );

    this.debriefScreen = new DebriefScreen(host.uiRoot, opts.dz.units);
    this.debriefScreen.onAgain = () => this.onEnd?.(this.jump);

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
   * the frame took, and the camera, the watch, the canopy and the sound
   * follow the state of the jump.
   *
   * @param dtS the time since the last frame, in seconds
   */
  frame(dtS: number): void {
    if (this.disposed) return;
    // A tab in the background does not fly: the time spent there is not
    // given to the simulation.
    if (this.paused) return;

    this.currentInput = this.sampleInput(dtS);
    this.fixed.advance(dtS);
    this.handleEvents();

    this.updateCamera();
    this.updateAltimeter();
    this.updateAudio();
    this.updateCanopy();
    this.updateLanding();
  }

  /** Lets go of the session: the controls, the watch, the canopy and the debrief. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;

    this.host.window.removeEventListener('visibilitychange', this.onVisibilityChange);
    this.controls.dispose();
    this.canopyControls.dispose();
    this.debriefScreen.dispose();
    this.keyboard.dispose();
    this.tilt?.dispose();
    this.host.overlay.scene.remove(this.altimeter.object);
    this.removeCanopyModel();
    if (this.ownsAudio) this.audio.dispose();
  }

  /**
   * The commands of the jumper, from the fingers and from the keys.
   *
   * The two are merged: the stronger command wins on every axis, and the
   * buttons are on if either of them says so. The pull, the unstow and the
   * PLF are edges: they are held until the simulation has taken them.
   */
  private sampleInput(dtS: number): JumpInput {
    const touch = this.controls.sample();
    const keys = this.keyboard.sample(dtS);
    const canopy = this.canopyControls.sample();

    if (touch.pull || keys.pull) this.pendingPull = true;
    if (canopy.canopy.unstow || keys.canopy.unstow) this.pendingUnstow = true;
    if (canopy.plf || keys.plf) this.pendingPlf = true;

    // The phone tilted back looks up at the canopy, and so does the key.
    this.lookUp = Math.max(canopy.lookUp, keys.lookUp);

    return {
      freefall: {
        turn: stronger(touch.freefall.turn, keys.freefall.turn),
        drive: stronger(touch.freefall.drive, keys.freefall.drive),
        fallRate: stronger(touch.freefall.fallRate, keys.freefall.fallRate),
        track: touch.freefall.track || keys.freefall.track,
      },
      pull: false,
      canopy: {
        left: stronger(canopy.canopy.left, keys.canopy.left),
        right: stronger(canopy.canopy.right, keys.canopy.right),
        frontLeft: stronger(canopy.canopy.frontLeft, keys.canopy.frontLeft),
        frontRight: stronger(canopy.canopy.frontRight, keys.canopy.frontRight),
        rear: stronger(canopy.canopy.rear, keys.canopy.rear),
        unstow: false,
      },
      plf: false,
    };
  }

  /**
   * One step of the simulation.
   *
   * Every step of the frame uses the input of the frame, and the edges are
   * given to the first step only: the edge is delivered once.
   */
  private readonly onStep = (_dt: number, first: boolean): void => {
    const pull = first && this.pendingPull;
    const unstow = first && this.pendingUnstow;
    const plf = first && this.pendingPlf;
    if (pull) this.pendingPull = false;
    if (unstow) this.pendingUnstow = false;
    if (plf) this.pendingPlf = false;
    this.jump.step({
      freefall: this.currentInput.freefall,
      pull,
      canopy: { ...this.currentInput.canopy, unstow },
      plf,
    });
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
      } else if (event.type === 'stage' && event.detail) {
        this.openingSound(event.detail as OpeningStage);
        if (event.detail === 'line-stretch') this.ensureCanopyModel();
      } else if (event.type === 'pull') {
        // The freefall controls go at the throw: the fingers are on the
        // canopy now, not on the body.
        this.controls.show(false);
        this.throwPose = this.freefallPose();
      } else if (event.type === 'aad') {
        // The reserve replaces the main: the model is built again.
        this.controls.show(false);
        this.replaceCanopyModel();
      } else if (event.type === 'open') {
        this.canopyControls.show(true);
        this.audio.opening('quiet');
      }
    }
  }

  /**
   * The sound of the opening.
   *
   * The flutter is the cloth beating, the snap is the canopy taking its
   * shape, and the quiet is the sound of the canopy flying.
   */
  private openingSound(stage: OpeningStage): void {
    if (stage === 'line-stretch') this.audio.opening('flutter');
    else if (stage === 'inflation') this.audio.opening('snap');
  }

  /**
   * The eye of the jumper.
   *
   * The freefall looks along the wind and the head, the opening swings
   * from the ground to the canopy, and under the canopy the jumper looks
   * ahead along the heading, or up the lines when they look up.
   */
  private updateCamera(): void {
    this.camera.apply(this.currentPose(), this.host.originOffset(), this.shakeG());

    // The velocity of this frame is the one the next frame is measured
    // against, for the load of the opening.
    this.lastVelocity = this.jump.velocity();
    this.lastT = this.jump.tS;
  }

  /** The pose of the eye, in the phase the jumper is in. */
  private currentPose(): CameraPose {
    const phase = this.jump.phase;
    if (phase === 'freefall') return this.freefallPose();
    if (phase === 'opening') {
      const from = this.throwPose ?? this.freefallPose();
      return openingEye(from, this.canopyPose(), this.jump.opening?.inflation ?? 0);
    }
    return this.canopyPose();
  }

  /** The eye of the jumper in the freefall. */
  private freefallPose(): CameraPose {
    return freefallEye(
      bodyFrame(this.jump.freefall),
      this.jump.airVelocity(),
      this.jump.position(),
    );
  }

  /** The eye of the jumper under the canopy. */
  private canopyPose(): CameraPose {
    const canopy = this.jump.canopy;
    return canopyEye({
      pos: this.jump.position(),
      headingRad: canopy ? this.jump.canopyHeadingRad() : this.jumperHeadingRad(),
      swingFore: canopy?.swingFore ?? 0,
      swingSide: canopy?.swingSide ?? 0,
      lookUp: this.lookUp,
    });
  }

  /**
   * The heading the jumper is going, in radians clockwise from north.
   *
   * Before the canopy is out there is no wing to ask, so the heading of the
   * jumper's own speed is used: that is the way the canopy will open.
   */
  private jumperHeadingRad(): number {
    const velocity = this.jump.velocity();
    return Math.atan2(velocity.x, -velocity.z);
  }

  /**
   * The load of the opening, in g over the one g of the fall.
   *
   * The load is what the jumper felt: the change of the velocity between
   * two frames, less the pull of the earth. The shake is the part of it
   * above one g, which is what a hard opening is.
   */
  private shakeG(): number {
    if (this.jump.phase !== 'opening') return 0;

    const dt = this.jump.tS - this.lastT;
    if (dt <= 0) return 0;

    const velocity = this.jump.velocity();
    const accel = {
      x: (velocity.x - this.lastVelocity.x) / dt,
      y: (velocity.y - this.lastVelocity.y) / dt,
      z: (velocity.z - this.lastVelocity.z) / dt,
    };
    const load = Math.hypot(accel.x, accel.y + G, accel.z) / G;
    return Math.max(0, load - 1);
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

  /**
   * The wind in the ears, and the siren of the audible altimeter.
   *
   * The wind of the freefall is loud, the wind under the canopy is soft,
   * and the wind of a jumper who is on the ground is nothing.
   */
  private updateAudio(): void {
    const phase = this.jump.phase;
    const air = this.jump.airVelocity();
    const speed = Math.hypot(air.x, air.y, air.z);

    if (phase === 'landed') this.audio.setWind(0, 'silent');
    else if (phase === 'canopy' || phase === 'landing') this.audio.setWind(speed, 'canopy');
    else this.audio.setWind(speed, 'freefall');

    this.audio.setContinuous(this.jump.audible.continuous);
  }

  /**
   * The canopy over the jumper's head.
   *
   * The model sits at the risers, on the jumper's shoulders, and the wing
   * is up the lines from there. Through the opening it is inflated as far
   * as the opening has got, and once the canopy is flying it is full.
   */
  private updateCanopy(): void {
    const jump = this.jump;

    // The PLF is only for the last few feet of the jump.
    this.canopyControls.setPlfAvailable(jump.heightAboveGround() <= PLF_HEIGHT_FT * FT);

    const model = this.canopyModel;
    if (!model) return;

    const position = jump.position();
    const offset = this.host.originOffset();
    model.object.position.set(
      position.x - offset.x,
      position.y + RISER_HEIGHT_M,
      position.z - offset.z,
    );

    const opening = jump.opening;
    if (jump.phase === 'opening' && opening) {
      model.setInflation(opening.inflation, opening.slider);
    } else {
      model.setInflation(1, 0);
    }

    const canopy = jump.canopy;
    if (canopy) {
      model.setPose({
        headingRad: jump.canopyHeadingRad(),
        bank: canopy.bank,
        swingFore: canopy.swingFore,
        swingSide: canopy.swingSide,
      });
      model.setBrakes(canopy.brakeLeft, canopy.brakeRight);
    } else {
      model.setPose({
        headingRad: this.jumperHeadingRad(),
        bank: 0,
        swingFore: 0,
        swingSide: 0,
      });
      model.setBrakes(0, 0);
    }
  }

  /** Builds the canopy of the jumper, if it is not there yet. */
  private ensureCanopyModel(): void {
    if (this.canopyModel) return;
    this.replaceCanopyModel();
  }

  /** Builds the canopy of the jumper again, for the canopy it is flying now. */
  private replaceCanopyModel(): void {
    this.removeCanopyModel();
    const model = new CanopyModel(this.jump.canopySpec);
    this.host.scene.add(model.object);
    this.canopyModel = model;
  }

  /** Takes the canopy of the jumper off the scene. */
  private removeCanopyModel(): void {
    const model = this.canopyModel;
    if (!model) return;
    this.host.scene.remove(model.object);
    model.dispose();
    this.canopyModel = null;
  }

  /**
   * The jumper is on the ground: the controls go away and the debrief
   * comes up.
   */
  private updateLanding(): void {
    if (this.debriefShown || this.jump.phase !== 'landed') return;
    this.debriefShown = true;

    this.controls.show(false);
    this.canopyControls.show(false);

    const data = computeDebrief(this.jump);
    this.debrief = data;
    this.debriefScreen.show(data, {
      dzName: this.dz.name,
      canopyName: this.jump.canopySpec.name,
      lzRadiusM: this.dz.lzRadiusM,
      track: this.jump.track,
    });
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
