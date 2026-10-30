/**
 * The audible altimeter.
 *
 * An audible altimeter is three beeps at three set heights and a siren that
 * runs from the lowest beep down to a thousand feet: the beeps tell the
 * jumper when to look at the altimeter on their wrist, and the siren tells
 * them they are late. The third alarm is both a beep and the start of the
 * continuous siren; the flatline is the siren alone.
 *
 * Each alarm is fired once per jump, on the way down. A jumper who climbs
 * back up over an alarm does not hear it again, and nothing is ever fired
 * on the way up.
 *
 * This module imports nothing from three.js or the DOM.
 */

/** The four sounds the audible altimeter makes. */
export type AudibleAlarm = 'alarm1' | 'alarm2' | 'alarm3' | 'flatline';

/** The heights the audible altimeter is set to. */
export interface AudibleSettings {
  /** The three beep heights above the landing area, in feet. */
  alarmsFt: [number, number, number];
  /** The height the flatline siren starts at, in feet. */
  flatlineFt: number;
}

/** The audible altimeter as it is set by default. */
export const DEFAULT_AUDIBLE: AudibleSettings = {
  alarmsFt: [5500, 4000, 2000],
  flatlineFt: 1000,
};

/** The three beeps, from the highest to the lowest. */
const BEEPS: readonly AudibleAlarm[] = ['alarm1', 'alarm2', 'alarm3'];

export class Audible {
  private readonly settings: AudibleSettings;
  /** The alarms that have already been fired in this jump. */
  private readonly fired = new Set<AudibleAlarm>();
  /** The height of the last update, in feet above the landing area. */
  private lastAglFt = Number.NaN;
  /** The siren that is running at the moment. */
  private continuousAlarm: AudibleAlarm | null = null;

  /**
   * @param settings the heights the altimeter is set to
   */
  constructor(settings: AudibleSettings = DEFAULT_AUDIBLE) {
    this.settings = {
      alarmsFt: [settings.alarmsFt[0], settings.alarmsFt[1], settings.alarmsFt[2]],
      flatlineFt: settings.flatlineFt,
    };
  }

  /**
   * Moves the altimeter on to a height and fires the alarms that were
   * crossed on the way down.
   *
   * @param altitudeAglFt the height above the landing area, in feet
   * @param inFreefall true while the jumper is still falling without a canopy
   * @returns the alarms that were crossed downward in this call
   */
  update(altitudeAglFt: number, inFreefall: boolean): AudibleAlarm[] {
    const previous = this.lastAglFt;
    this.lastAglFt = altitudeAglFt;

    // The siren: it runs from the lowest beep down to the flatline, and
    // only while the jumper is still in freefall.
    this.continuousAlarm = null;
    if (inFreefall) {
      if (altitudeAglFt <= this.settings.flatlineFt) this.continuousAlarm = 'flatline';
      else if (altitudeAglFt <= this.settings.alarmsFt[2]) this.continuousAlarm = 'alarm3';
    }

    const crossed: AudibleAlarm[] = [];
    // The first call only sets the reference height: an alarm is crossed,
    // it is not simply passed.
    if (!Number.isFinite(previous)) return crossed;
    // Nothing is fired on the way up.
    if (altitudeAglFt >= previous) return crossed;

    for (let i = 0; i < BEEPS.length; i++) {
      const name = BEEPS[i] as AudibleAlarm;
      const threshold = this.settings.alarmsFt[i] as number;
      if (this.fired.has(name)) continue;
      if (previous >= threshold && altitudeAglFt <= threshold) {
        this.fired.add(name);
        crossed.push(name);
      }
    }
    return crossed;
  }

  /** The siren that is running: the alarm below the jumper, or null. */
  get continuous(): AudibleAlarm | null {
    return this.continuousAlarm;
  }
}
