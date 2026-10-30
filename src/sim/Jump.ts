/**
 * The jump.
 *
 * The jump is the clock the whole simulation hangs on: the phases, the
 * events, the track and the log of every input. It starts at the exit, with
 * the jumper leaving the aircraft at the exit speed along the jump run, and
 * it ends on the ground.
 *
 * The phases run freefall, opening, canopy, landing and landed. The throw
 * starts the opening, the opening ends when the canopy is flying, and the
 * ground ends the jump. The AAD, when the jumper wears one, watches the
 * freefall: if the jumper is still falling fast at 750 ft above the landing
 * area's level, it fires the reserve on its own.
 *
 * Every input is copied into a log as it arrives, so a jump replays exactly
 * from the log and the same seed.
 *
 * This module imports nothing from three.js or the DOM.
 */

import { CANOPIES, type CanopyId, type CanopySpec } from '@/data/canopies';
import { isaDensity } from './atmosphere';
import { Audible, type AudibleSettings } from './audible';
import {
  type CanopyEnv,
  type CanopyState,
  canopyHeadingRad as headingOfCanopy,
  createCanopyState,
  stepCanopy,
} from './canopy/canopy';
import { type Polar, polarFor } from './canopy/polar';
import { SIM_DT } from './FixedStep';
import { bellyCdA } from './freefall/aero';
import {
  type FreefallEnv,
  type FreefallState,
  createFreefallState,
  stepFreefall,
} from './freefall/freefall';
import { type JumpInput } from './inputs';
import { bodyAreaScale, exitMassKg, type JumperParams } from './jumper';
import { classifyLanding, PLF_WINDOW_S, type LandingOutcome } from './landing';
import { Opening, OPENING_CANOPY_DRAG_M2, planOpening } from './opening';
import { Rng } from './rng';
import { FT, G, MPH } from './units';
import { type Vec3, add, length, scale, sub, vec3 } from './vec3';
import { Wind, type WindProfile } from './wind';

/** The phases of a jump. */
export type JumpPhase = 'freefall' | 'opening' | 'canopy' | 'landing' | 'landed';

/** The automatic activation device that fires the reserve. */
const AAD = {
  /**
   * The height above the landing area at which it fires, in feet.
   *
   * The device never fires above the height the jumper throws at: a jumper
   * who pulls low keeps their own canopy, and the reserve is for the
   * jumper who never pulls at all.
   */
  altitudeFt: 750,
  /** The vertical speed above which it fires, in miles per hour. */
  speedMph: 78,
};

/** Everything the jump needs to know before it starts. */
export interface JumpConfig {
  /** The seed of the jump: the same seed and the same inputs fly it again. */
  seed: number;
  /** The jumper and their gear. */
  jumper: JumperParams;
  /** The wind over the drop zone. */
  wind: WindProfile;
  /** The difference between the day's temperature and the standard one. */
  temperatureOffsetC: number;
  /** The place the jumper leaves the aircraft, in metres above mean sea level. */
  exitPos: Vec3;
  /** The heading of the jump run, in radians clockwise from north. */
  exitHeadingRad: number;
  /** The speed of the aircraft at the exit, in metres per second. */
  aircraftTasMs: number;
  /** The height of the landing area above mean sea level: the altimeter's zero. */
  lzGroundY: number;
  /** The height of the ground where the jumper is, in metres above mean sea level. */
  ground: (x: number, z: number) => number;
  /** The canopy the jumper is going to fly. */
  canopyId: CanopyId;
  /** The height the jumper plans to pull at, in feet above the landing area. */
  pullAltitudeFt: number;
  /** Whether the jumper wears an AAD; true unless said otherwise. */
  aad?: boolean;
  /** The heights the audible altimeter is set to. */
  audible: AudibleSettings;
  /** The density of the air everywhere: for the tests only. */
  constantDensity?: number;
}

/** The things that happen in a jump. */
export type JumpEventType =
  | 'exit'
  | 'alarm'
  | 'pull'
  | 'stage'
  | 'open'
  | 'unstow'
  | 'aad'
  | 'touchdown'
  | 'impact'
  | 'outcome';

/** One thing that happened, and where it happened. */
export interface JumpEvent {
  /** The time it happened, in seconds since the exit. */
  tS: number;
  /** What happened. */
  type: JumpEventType;
  /** The name of the alarm, for an alarm event. */
  detail?: string;
  /** The height above the landing area when it happened, in metres. */
  aglM: number;
}

/** A sample of the jump, ten times a second. */
export interface TrackSample {
  /** The time of the sample, in seconds since the exit. */
  tS: number;
  /** Where the jumper was. */
  pos: Vec3;
  /** How fast the jumper was going over the ground. */
  vel: Vec3;
  /** What the jumper was doing. */
  phase: JumpPhase;
  /** The height above the landing area, in metres. */
  aglM: number;
}

/** The touchdown, and how the landing came out. */
export interface Touchdown {
  /** The time of the touchdown, in seconds since the exit. */
  tS: number;
  /** Where the jumper touched down, in metres above mean sea level. */
  pos: Vec3;
  /** How fast the jumper hit the ground, in metres per second. */
  verticalMs: number;
  /** How fast the jumper was going over the ground, in metres per second. */
  groundSpeedMs: number;
  /** How fast the jumper was going through the air, in metres per second. */
  airspeedMs: number;
  /** The wind where the jumper landed, in metres per second. */
  wind: Vec3;
  /** How the landing came out. */
  outcome: LandingOutcome;
}

/** The steps between two samples of the track: a tenth of a second. */
const TRACK_STEPS = 12;

/** The seed of the wind, so that the wind does not move when the jumper does. */
const WIND_SEED_MIX = 0x9e3779b9;

/** The body drag of the jumper once the lines have come tight, in m². */
const UPRIGHT_BODY_AREA_M2 = 0.5;

/** A copy of an input, so that the log keeps what was given. */
function copyInput(input: JumpInput): JumpInput {
  return {
    freefall: { ...input.freefall },
    pull: input.pull,
    canopy: { ...input.canopy },
    plf: input.plf,
  };
}

export class Jump {
  /** Everything the jump was told before it started. */
  readonly config: JumpConfig;
  /** The random numbers of the jump. */
  readonly rng: Rng;
  /** The wind over the drop zone. */
  readonly wind: Wind;
  /** The audible altimeter on the jumper's wrist. */
  readonly audible: Audible;
  /** What the jumper is doing. */
  phase: JumpPhase = 'freefall';
  /** The time since the exit, in seconds. */
  tS = 0;
  /** The body of the jumper in freefall. */
  freefall: FreefallState;
  /** The opening, while the canopy is coming out of the bag. */
  opening: Opening | null = null;
  /** The canopy, once it is flying. */
  canopy: CanopyState | null = null;
  /** The canopy being flown: the main, or the reserve after the AAD. */
  canopySpec: CanopySpec;
  /** The touchdown, once the jumper is on the ground. */
  touchdown: Touchdown | null = null;
  /** The largest load the jumper felt through the opening, in g. */
  maxOpeningG = 0;
  /** True once the AAD has fired the reserve. */
  aadFired = false;
  /** Everything that has happened, in order. */
  readonly events: JumpEvent[] = [];
  /** The jump, sampled ten times a second. */
  readonly track: TrackSample[] = [];
  /** Every input, as it was given, one per step. */
  readonly inputLog: JumpInput[] = [];

  /** The steps taken so far. */
  private stepCount = 0;
  /** True once the jumper has thrown the canopy. */
  private pulled = false;
  /** The air the jumper falls through. */
  private readonly env: FreefallEnv;
  /** The air the canopy flies through. */
  private readonly canopyEnv: CanopyEnv;
  /** The polar of the canopy being flown. */
  private polar: Polar;
  /** When the PLF was last asked for, in seconds since the exit. */
  private lastPlfS = Number.NEGATIVE_INFINITY;
  /** True when the PLF was rolled in time to help the landing. */
  private plfInTime = false;

  /**
   * @param config everything the jump needs to know before it starts
   */
  constructor(config: JumpConfig) {
    this.config = { ...config };
    this.rng = new Rng(this.config.seed);
    this.wind = new Wind(this.config.wind, new Rng(this.config.seed ^ WIND_SEED_MIX));
    this.audible = new Audible(this.config.audible);
    this.canopySpec = CANOPIES[this.config.canopyId];
    this.polar = polarFor(this.canopySpec);

    const density = this.config.constantDensity;
    this.env = {
      rho:
        density === undefined
          ? (yMslM: number) => isaDensity(yMslM, this.config.temperatureOffsetC)
          : () => density,
      wind: (pos: Vec3, tS: number) =>
        this.wind.at(Math.max(0, pos.y - this.config.lzGroundY), tS),
      jumper: this.config.jumper,
    };
    // The canopy flies on the jump's clock, so that the gust it feels is the
    // gust the jumper felt a moment before.
    this.canopyEnv = {
      rho: (yMslM: number) => this.env.rho(yMslM),
      wind: (pos: Vec3) => this.env.wind(pos, this.tS),
      jumper: this.config.jumper,
    };

    // The exit: the jumper leaves the aircraft at the aircraft's true
    // airspeed along the jump run, with the wind there on top of it.
    const exitWind = this.wind.at(
      Math.max(0, this.config.exitPos.y - this.config.lzGroundY),
      0,
    );
    const heading = this.config.exitHeadingRad;
    const velocity = vec3(
      this.config.aircraftTasMs * Math.sin(heading) + exitWind.x,
      exitWind.y,
      -this.config.aircraftTasMs * Math.cos(heading) + exitWind.z,
    );
    this.freefall = createFreefallState({
      pos: this.config.exitPos,
      vel: velocity,
      wind: exitWind,
      headUp: true,
    });
    this.events.push(this.makeEvent('exit'));
  }

  /**
   * Moves the jump on by one step of the simulation.
   *
   * @param input what the jumper is doing this step
   */
  step(input: JumpInput): void {
    this.inputLog.push(copyInput(input));
    // The jump is over: nothing moves and nothing is heard any more.
    if (this.phase === 'landed') return;

    // The throw comes first: a jumper who has pulled is opening their own
    // canopy, and the AAD only watches the freefall.
    if (this.phase === 'freefall' && input.pull && !this.pulled) {
      // The throw. From here the jumper is opening the canopy, and the
      // inputs of the freefall no longer apply.
      this.pulled = true;
      this.startOpening('main');
      this.pushEvent('pull');
    }

    // The AAD: low and still going fast, and the reserve comes out on its
    // own. It fires once, and only while the jumper is in freefall.
    if (
      this.phase === 'freefall' &&
      this.config.aad !== false &&
      !this.aadFired &&
      this.altitudeAglM() / FT <= AAD.altitudeFt &&
      this.verticalSpeedMs() > AAD.speedMph * MPH
    ) {
      this.aadFired = true;
      this.pushEvent('aad');
      this.canopySpec = CANOPIES['reserve-220'];
      this.polar = polarFor(this.canopySpec);
      this.startOpening('reserve');
    }

    // The PLF: it only counts when it is close to the touchdown.
    if (input.plf && this.phase === 'canopy') this.lastPlfS = this.tS;
    if (input.plf && this.phase === 'landing') this.plfInTime = true;

    if (this.phase === 'freefall') {
      stepFreefall(this.freefall, input.freefall, this.env, SIM_DT, this.rng);
    } else if (this.phase === 'opening') {
      this.stepOpening();
    } else if (this.phase === 'canopy') {
      this.stepCanopy(input);
    }

    // The audible altimeter on the wrist. The beeps are for the freefall:
    // under a canopy the jumper reads the altimeter, not the beeps.
    const alarms = this.audible.update(this.altitudeAglM() / FT, this.inFreefall());
    if (this.inFreefall()) {
      for (const alarm of alarms) this.pushEvent('alarm', alarm);
    }

    // The ground.
    if (this.heightAboveGround() <= 0) this.touchDown();

    // The landing: the outcome is decided when the PLF window closes, or
    // at once when no PLF could have changed it.
    if (this.phase === 'landing' && this.tS - (this.touchdown?.tS ?? 0) >= PLF_WINDOW_S) {
      this.finishLanding();
    }

    this.tS += SIM_DT;
    this.stepCount++;
    if (this.stepCount % TRACK_STEPS === 0) {
      this.track.push({
        tS: this.tS,
        pos: { ...this.jumperPos },
        vel: { ...this.jumperVel },
        phase: this.phase,
        aglM: this.altitudeAglM(),
      });
    }
  }

  /** The height of the jumper above the landing area, in metres. */
  altitudeAglM(): number {
    return this.jumperPos.y - this.config.lzGroundY;
  }

  /** The height of the jumper above the ground under them, in metres. */
  heightAboveGround(): number {
    const pos = this.jumperPos;
    return pos.y - this.config.ground(pos.x, pos.z);
  }

  /** Where the jumper is, in metres above mean sea level. */
  position(): Vec3 {
    return { ...this.jumperPos };
  }

  /** How fast the jumper is going over the ground, in metres per second. */
  velocity(): Vec3 {
    return { ...this.jumperVel };
  }

  /** How fast the jumper is going through the air, in metres per second. */
  airVelocity(): Vec3 {
    return sub(this.jumperVel, this.env.wind(this.jumperPos, this.tS));
  }

  /** How fast the jumper is falling, in metres per second. */
  verticalSpeedMs(): number {
    return -this.jumperVel.y;
  }

  /** The heading the canopy is flying, in radians clockwise from north. */
  canopyHeadingRad(): number {
    if (!this.canopy) return 0;
    return headingOfCanopy(this.canopy, this.canopyEnv);
  }

  /** Where the jumper is: under the canopy once it is flying. */
  private get jumperPos(): Vec3 {
    return this.canopy ? this.canopy.pos : this.freefall.pos;
  }

  /** How fast the jumper is going: with the canopy once it is flying. */
  private get jumperVel(): Vec3 {
    return this.canopy ? this.canopy.vel : this.freefall.vel;
  }

  /** True while the jumper is falling without a canopy over them. */
  private inFreefall(): boolean {
    return this.phase === 'freefall' || this.phase === 'opening';
  }

  /**
   * Starts an opening: the main the jumper pulled, or the reserve the AAD
   * fired.
   */
  private startOpening(kind: 'main' | 'reserve'): void {
    this.opening = new Opening(planOpening(this.rng, this.verticalSpeedMs(), kind));
    this.phase = 'opening';
  }

  /**
   * Runs the opening on by one step.
   *
   * Through the opening the jumper is one mass under gravity, with the drag
   * of the body, of the opening and of the canopy itself along the airflow.
   * The canopy's own flight force comes in with the inflation, and the load
   * it makes is the peak of the opening.
   */
  private stepOpening(): void {
    const opening = this.opening;
    if (!opening) return;

    const pos = this.freefall.pos;
    const airVel = sub(this.freefall.vel, this.env.wind(pos, this.freefall.tS));
    const speed = length(airVel);
    const q = 0.5 * this.env.rho(pos.y) * speed * speed;
    const area = this.openingAreaM2();
    const force = speed > 1e-6 ? scale(airVel, (-q * area) / speed) : vec3(0, 0, 0);

    const mass = exitMassKg(this.config.jumper);
    const loadG = length(force) / (mass * G);
    if (loadG > this.maxOpeningG) this.maxOpeningG = loadG;

    const accel = add(scale(force, 1 / mass), vec3(0, -G, 0));
    this.freefall.vel = add(this.freefall.vel, scale(accel, SIM_DT));
    this.freefall.pos = add(this.freefall.pos, scale(this.freefall.vel, SIM_DT));
    this.freefall.tS += SIM_DT;

    const stage = opening.advance(SIM_DT);
    if (stage === 'open') this.openCanopy();
    else if (stage !== null) this.pushEvent('stage', stage);
  }

  /**
   * The area the air pushes on through the opening, in square metres.
   *
   * The body is flat until the lines come tight and upright after that, and
   * the canopy's own flight force comes in with the inflation.
   */
  private openingAreaM2(): number {
    const opening = this.opening;
    if (!opening) return 0;
    const flat = opening.stage === 'pilot-chute' || opening.stage === 'bag';
    const body = flat ? bellyCdA(0, bodyAreaScale(this.config.jumper)) : UPRIGHT_BODY_AREA_M2;
    return body + opening.dragArea() + OPENING_CANOPY_DRAG_M2 * opening.flightBlend();
  }

  /** The canopy is flying: the jump hands over to the canopy model. */
  private openCanopy(): void {
    this.canopy = createCanopyState(this.freefall.pos, this.freefall.vel, true);
    this.phase = 'canopy';
    this.pushEvent('open');
  }

  /** Flies the canopy on by one step. */
  private stepCanopy(input: JumpInput): void {
    const canopy = this.canopy;
    if (!canopy) return;
    const stowed = canopy.stowed;
    stepCanopy(canopy, this.canopySpec, this.polar, input.canopy, this.canopyEnv, SIM_DT);
    if (stowed && !canopy.stowed) this.pushEvent('unstow');
  }

  /** The jumper is on the ground. */
  private touchDown(): void {
    // The jumper is already down: nothing more to do.
    if (this.phase === 'landing' || this.phase === 'landed') return;
    const pos = this.jumperPos;
    const vel = this.jumperVel;
    const groundY = this.config.ground(pos.x, pos.z);
    const wind = this.env.wind(pos, this.tS);
    const verticalMs = -vel.y;
    const groundSpeedMs = Math.hypot(vel.x, vel.z);
    const plfInTime = this.tS - this.lastPlfS <= PLF_WINDOW_S;

    this.touchdown = {
      tS: this.tS,
      pos: { x: pos.x, y: groundY, z: pos.z },
      verticalMs,
      groundSpeedMs,
      airspeedMs: length(sub(vel, wind)),
      wind,
      outcome: classifyLanding(verticalMs, groundSpeedMs, plfInTime),
    };
    this.pushEvent('touchdown');
    // A jumper who reaches the ground without a canopy over them does not
    // land: they hit the ground.
    if (this.inFreefall()) this.pushEvent('impact');

    // The jumper stops where they hit the ground.
    const stopped = { x: pos.x, y: groundY, z: pos.z };
    if (this.canopy) {
      this.canopy.pos = stopped;
      this.canopy.vel = vec3(0, 0, 0);
    } else {
      this.freefall.pos = stopped;
      this.freefall.vel = vec3(0, 0, 0);
    }
    this.phase = 'landing';

    // When no PLF could have changed the outcome, the landing is over.
    if (
      classifyLanding(verticalMs, groundSpeedMs, true) ===
      classifyLanding(verticalMs, groundSpeedMs, false)
    ) {
      this.finishLanding();
    }
  }

  /** The jumper is on the ground and the PLF window has closed. */
  private finishLanding(): void {
    const touchdown = this.touchdown;
    if (!touchdown) return;
    touchdown.outcome = classifyLanding(
      touchdown.verticalMs,
      touchdown.groundSpeedMs,
      this.plfInTime,
    );
    this.pushEvent('outcome', touchdown.outcome);
    this.phase = 'landed';
  }

  /** Writes an event down, with the time and the height it happened at. */
  private pushEvent(type: JumpEventType, detail?: string): void {
    this.events.push(this.makeEvent(type, detail));
  }

  /** An event at the time and the height of the moment. */
  private makeEvent(type: JumpEventType, detail?: string): JumpEvent {
    const event: JumpEvent = { tS: this.tS, type, aglM: this.altitudeAglM() };
    if (detail !== undefined) event.detail = detail;
    return event;
  }
}
