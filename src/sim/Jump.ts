/**
 * The jump.
 *
 * The jump is the clock the whole simulation hangs on: the phases, the
 * events, the track and the log of every input. It starts at the exit, with
 * the jumper leaving the aircraft at the exit speed along the jump run, and
 * it ends on the ground.
 *
 * For now the jump runs the freefall to the pull and then keeps falling
 * while the canopy opens; the opening itself is the next task. Every input
 * is copied into a log as it arrives, so a jump replays exactly from the log
 * and the same seed.
 *
 * This module imports nothing from three.js or the DOM.
 */

import type { CanopyId } from '@/data/canopies';
import { isaDensity } from './atmosphere';
import { Audible, type AudibleSettings } from './audible';
import { SIM_DT } from './FixedStep';
import {
  type FreefallEnv,
  type FreefallState,
  createFreefallState,
  stepFreefall,
} from './freefall/freefall';
import { type JumpInput, NEUTRAL_INPUT } from './inputs';
import type { JumperParams } from './jumper';
import { Rng } from './rng';
import { FT } from './units';
import { type Vec3, sub, vec3 } from './vec3';
import { Wind, type WindProfile } from './wind';

/** The phases of a jump. */
export type JumpPhase = 'freefall' | 'opening' | 'canopy' | 'landing' | 'landed';

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
  /** The height the jumper pulls at, in feet above the landing area. */
  pullAltitudeFt: number;
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

/** The steps between two samples of the track: a tenth of a second. */
const TRACK_STEPS = 12;

/** The seed of the wind, so that the wind does not move when the jumper does. */
const WIND_SEED_MIX = 0x9e3779b9;

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

  /**
   * @param config everything the jump needs to know before it starts
   */
  constructor(config: JumpConfig) {
    this.config = { ...config };
    this.rng = new Rng(this.config.seed);
    this.wind = new Wind(this.config.wind, new Rng(this.config.seed ^ WIND_SEED_MIX));
    this.audible = new Audible(this.config.audible);

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

    if (this.phase === 'freefall' && input.pull && !this.pulled) {
      // The throw. From here the jumper is opening the canopy, and the
      // inputs of the freefall no longer apply.
      this.pulled = true;
      this.phase = 'opening';
      this.pushEvent('pull');
    }

    if (this.phase === 'freefall' || this.phase === 'opening') {
      const command = this.phase === 'freefall' ? input.freefall : NEUTRAL_INPUT.freefall;
      stepFreefall(this.freefall, command, this.env, SIM_DT, this.rng);
    }

    // The audible altimeter on the wrist.
    const alarms = this.audible.update(this.altitudeAglM() / FT, this.inFreefall());
    for (const alarm of alarms) this.pushEvent('alarm', alarm);

    // The ground.
    if (this.inFreefall() && this.heightAboveGround() <= 0) {
      this.pushEvent('touchdown');
      this.pushEvent('impact');
      this.phase = 'landed';
    }

    this.tS += SIM_DT;
    this.stepCount++;
    if (this.stepCount % TRACK_STEPS === 0) {
      this.track.push({
        tS: this.tS,
        pos: { ...this.freefall.pos },
        vel: { ...this.freefall.vel },
        phase: this.phase,
        aglM: this.altitudeAglM(),
      });
    }
  }

  /** The height of the jumper above the landing area, in metres. */
  altitudeAglM(): number {
    return this.freefall.pos.y - this.config.lzGroundY;
  }

  /** The height of the jumper above the ground under them, in metres. */
  heightAboveGround(): number {
    const pos = this.freefall.pos;
    return pos.y - this.config.ground(pos.x, pos.z);
  }

  /** Where the jumper is, in metres above mean sea level. */
  position(): Vec3 {
    return { ...this.freefall.pos };
  }

  /** How fast the jumper is going over the ground, in metres per second. */
  velocity(): Vec3 {
    return { ...this.freefall.vel };
  }

  /** How fast the jumper is going through the air, in metres per second. */
  airVelocity(): Vec3 {
    const wind = this.env.wind(this.freefall.pos, this.freefall.tS);
    return sub(this.freefall.vel, wind);
  }

  /** True while the jumper is falling without a canopy over them. */
  private inFreefall(): boolean {
    return this.phase === 'freefall' || this.phase === 'opening';
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
