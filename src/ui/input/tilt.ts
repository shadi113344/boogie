/**
 * The tilt of the phone, as the axes the jumper flies with.
 *
 * The phone reports two angles: `beta`, the rotation about the axis along
 * its short side, and `gamma`, the rotation about the axis along its long
 * side. Which of the two is the pitch and which is the roll depends on the
 * way the phone is held, so the raw readings are mapped through the screen
 * orientation before they are used. The neutral attitude, the one the
 * jumper is holding when the jump starts, is the zero.
 */

/** A reading of the orientation sensor, in degrees. */
export interface TiltReading {
  /** The rotation about the phone's short axis: the top edge toward the user raises it. */
  beta: number;
  /** The rotation about the phone's long axis: the right edge down raises it. */
  gamma: number;
}

/** The tilt of the phone relative to the neutral attitude, in degrees. */
export interface TiltAxes {
  /** Positive when the top of the phone is tilted away from the jumper: forward drive. */
  pitch: number;
  /** Positive when the right edge of the phone is down: a turn to the right. */
  roll: number;
}

/** How far the phone may tilt before the axes are clipped. */
const MAX_AXIS_DEG = 90;

/** The tilt below which the jumper is not asking for anything. */
const DEFAULT_DEAD_ZONE_DEG = 3;

/** The tilt that asks for everything. */
const DEFAULT_FULL_DEG = 25;

function clamp(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  // Keep the zero positive, so the numbers read cleanly in the input log.
  return value === 0 ? 0 : value;
}

/** Wraps an angle into (-180, 180]. */
function wrapDeg(deg: number): number {
  const wrapped = ((((deg + 180) % 360) + 360) % 360) - 180;
  return wrapped === -180 ? 180 : wrapped;
}

/**
 * The tilt of the phone relative to the neutral attitude, in the frame of
 * the screen.
 *
 * The phone is held in portrait in most jumps and in landscape in some, so
 * the two sensor angles are swapped and, at 180 and 270 degrees, turned the
 * other way round. The same physical tilt therefore gives the same pitch
 * and roll whichever way the phone is held.
 *
 * @param r the reading of the sensor
 * @param neutral the attitude the jumper is holding as the zero
 * @param screenAngle the rotation of the screen, in degrees clockwise
 */
export function tiltAxes(r: TiltReading, neutral: TiltReading, screenAngle: number): TiltAxes {
  const dBeta = wrapDeg(r.beta - neutral.beta);
  const dGamma = r.gamma - neutral.gamma;

  let pitch: number;
  let roll: number;
  switch (((Math.round(screenAngle / 90) % 4) + 4) % 4) {
    case 1:
      // The screen at 90 degrees: the long side of the phone is horizontal.
      pitch = dGamma;
      roll = dBeta;
      break;
    case 2:
      // The screen at 180 degrees: the phone is upside down.
      pitch = dBeta;
      roll = -dGamma;
      break;
    case 3:
      // The screen at 270 degrees.
      pitch = -dGamma;
      roll = -dBeta;
      break;
    default:
      // The screen at 0 degrees: the phone is upright.
      pitch = -dBeta;
      roll = dGamma;
      break;
  }

  return {
    pitch: clamp(pitch, -MAX_AXIS_DEG, MAX_AXIS_DEG),
    roll: clamp(roll, -MAX_AXIS_DEG, MAX_AXIS_DEG),
  };
}

/**
 * How much of the full deflection a tilt asks for, from -1 to 1.
 *
 * The dead zone is where a hand that is holding still still moves; past it
 * the tilt grows linearly until it asks for everything.
 *
 * @param deg the tilt, in degrees
 * @param deadZoneDeg the tilt that is still nothing
 * @param fullDeg the tilt that asks for everything
 */
export function axisToInput(
  deg: number,
  deadZoneDeg: number = DEFAULT_DEAD_ZONE_DEG,
  fullDeg: number = DEFAULT_FULL_DEG,
): number {
  if (!Number.isFinite(deg)) return 0;
  const magnitude = Math.abs(deg);
  if (magnitude <= deadZoneDeg) return 0;
  const span = fullDeg - deadZoneDeg;
  if (span <= 0) return Math.sign(deg);
  return Math.sign(deg) * Math.min(1, (magnitude - deadZoneDeg) / span);
}

/** What the browser said about the orientation sensor. */
export type TiltPermission = 'granted' | 'denied' | 'unavailable';

/** The iOS way of asking, which the DOM types do not know about. */
interface PermissionAskingConstructor {
  requestPermission?: () => Promise<string>;
}

/**
 * Asks the browser for the orientation sensor.
 *
 * iOS only gives the sensor after the player has tapped something, and
 * only over HTTPS. Everywhere else the sensor needs no permission. A
 * browser without the sensor at all is unavailable rather than denied, so
 * the caller can tell the player to use the touch controls instead.
 */
export async function requestTiltPermission(): Promise<TiltPermission> {
  if (typeof DeviceOrientationEvent === 'undefined') return 'unavailable';
  const asking = DeviceOrientationEvent as unknown as PermissionAskingConstructor;
  if (typeof asking.requestPermission !== 'function') return 'granted';
  try {
    const answer = await asking.requestPermission();
    return answer === 'granted' ? 'granted' : 'denied';
  } catch {
    // The browser refused, usually because there was no user gesture.
    return 'denied';
  }
}

/** The screen of a window, with the orientation angle where it may be. */
interface ScreenWithAngle {
  orientation?: { angle?: number };
}

/** The old way of asking for the screen angle, before the screen API. */
interface WindowWithOrientation {
  orientation?: number;
}

/**
 * The orientation sensor of one window.
 *
 * The source keeps the latest reading, the attitude that counts as
 * neutral, and how fast the phone is being rolled, which is how the
 * parachute landing fall is spotted.
 */
export class TiltSource {
  private readonly target: Window;

  /** The attitude that counts as zero. */
  private neutral: TiltReading | null = null;

  /** Set when the jumper calibrates before the sensor has said anything. */
  private calibrateOnNextReading = false;

  /** The latest reading of the sensor. */
  private latest: TiltReading | null = null;

  /** The tilt of the latest reading, relative to the neutral attitude. */
  private latestAxes: TiltAxes | null = null;

  /** The roll of the reading before the latest one, in degrees. */
  private previousRollDeg: number | null = null;

  /** The time of the reading before the latest one, in milliseconds. */
  private previousTMs: number | null = null;

  /** How fast the phone is being rolled, in degrees a second. */
  private rateDegS = 0;

  private listening = false;

  constructor(target: Window) {
    this.target = target;
  }

  /** Starts listening for the orientation sensor. Calling it twice does nothing. */
  start(): void {
    if (this.listening) return;
    this.listening = true;
    this.target.addEventListener('deviceorientation', this.onOrientation);
  }

  /**
   * Makes the attitude the jumper is holding now the neutral one.
   *
   * If the sensor has not said anything yet, the next reading is used.
   */
  calibrate(): void {
    if (!this.latest) {
      this.calibrateOnNextReading = true;
      return;
    }
    this.neutral = { ...this.latest };
    this.latestAxes = this.axesOf(this.latest);
    // The roll changed by a constant, so the rate starts again from here.
    this.previousRollDeg = null;
    this.previousTMs = null;
    this.rateDegS = 0;
  }

  /** The tilt of the phone right now, or null if the sensor has not said anything. */
  axes(): TiltAxes | null {
    return this.latestAxes ? { ...this.latestAxes } : null;
  }

  /** How fast the phone is being rolled, in degrees a second; 0 until there are two readings. */
  rollRateDegS(): number {
    return this.rateDegS;
  }

  /** Stops listening for the orientation sensor. */
  dispose(): void {
    if (!this.listening) return;
    this.listening = false;
    this.target.removeEventListener('deviceorientation', this.onOrientation);
  }

  private readonly onOrientation = (event: DeviceOrientationEvent): void => {
    const beta = event.beta;
    const gamma = event.gamma;
    // A sensor that cannot see the world sends null or NaN.
    if (typeof beta !== 'number' || typeof gamma !== 'number') return;
    if (!Number.isFinite(beta) || !Number.isFinite(gamma)) return;

    const reading: TiltReading = { beta, gamma };
    if (this.calibrateOnNextReading) {
      this.calibrateOnNextReading = false;
      this.neutral = { ...reading };
    }

    const axes = this.axesOf(reading);
    const tMs = this.eventTimeMs(event);
    if (this.previousRollDeg !== null && this.previousTMs !== null) {
      const dtS = (tMs - this.previousTMs) / 1000;
      this.rateDegS = dtS > 0 ? (axes.roll - this.previousRollDeg) / dtS : 0;
    } else {
      this.rateDegS = 0;
    }
    this.previousRollDeg = axes.roll;
    this.previousTMs = tMs;

    this.latest = reading;
    this.latestAxes = axes;
  };

  /** The tilt of a reading, relative to the neutral attitude. */
  private axesOf(reading: TiltReading): TiltAxes {
    // Before the jumper calibrates, the first reading is the zero.
    const neutral = this.neutral ?? reading;
    return tiltAxes(reading, neutral, this.screenAngle());
  }

  /** The rotation of the screen, in degrees clockwise. */
  private screenAngle(): number {
    const screen = this.target.screen as ScreenWithAngle | undefined;
    const angle = screen?.orientation?.angle;
    if (typeof angle === 'number' && Number.isFinite(angle)) return angle;
    const legacy = (this.target as WindowWithOrientation).orientation;
    if (typeof legacy === 'number' && Number.isFinite(legacy)) return legacy;
    return 0;
  }

  /** The time of the reading, in milliseconds. */
  private eventTimeMs(event: DeviceOrientationEvent): number {
    const stamp = event.timeStamp;
    if (typeof stamp === 'number' && Number.isFinite(stamp)) return stamp;
    return typeof performance !== 'undefined' ? performance.now() : Date.now();
  }
}
