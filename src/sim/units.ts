/**
 * Units and the display of them.
 *
 * The simulation works in metres and metres per second. Only the wrist
 * altimeter, the debrief and the drop zone screens speak feet, miles per
 * hour or kilometres per hour, so the conversion happens here and nowhere
 * else. This module imports nothing from three.js or the DOM.
 */

/** Metres in a foot. */
export const FT = 0.3048;

/** Metres per second in a mile per hour. */
export const MPH = 0.44704;

/** Metres per second in a knot. */
export const KT = 0.514444;

/** Metres per second in a foot per minute. */
export const FPM = 0.00508;

/** Metres per second in a kilometre per hour. */
export const KMH = 1 / 3.6;

/** Standard gravity, in metres per second squared. */
export const G = 9.80665;

/** The two systems of units the drop zones use. */
export type UnitSystem = 'ft' | 'm';

/**
 * Groups the thousands of an integer with commas.
 *
 * The separator is written out here rather than left to `toLocaleString`,
 * because the locale of the machine that runs the build is not the locale
 * the jumper reads.
 */
function withCommas(value: number): string {
  const rounded = Math.round(value);
  const sign = rounded < 0 ? '-' : '';
  const digits = Math.abs(rounded).toString();
  let out = '';
  for (let i = 0; i < digits.length; i++) {
    if (i > 0 && (digits.length - i) % 3 === 0) out += ',';
    out += digits.charAt(i);
  }
  return sign + out;
}

/**
 * Formats an altitude, to the nearest ten, in the unit system of the drop
 * zone: "13,500 ft" or "4,110 m".
 */
export function formatAltitude(m: number, units: UnitSystem): string {
  const value = units === 'ft' ? m / FT : m;
  const rounded = Math.round(value / 10) * 10;
  return units === 'ft' ? `${withCommas(rounded)} ft` : `${withCommas(rounded)} m`;
}

/**
 * Formats a speed to the nearest whole unit of the drop zone: "120 mph" or
 * "193 km/h".
 */
export function formatSpeed(ms: number, units: UnitSystem): string {
  const value = units === 'ft' ? ms / MPH : ms / KMH;
  return units === 'ft' ? `${withCommas(value)} mph` : `${withCommas(value)} km/h`;
}

/**
 * Formats a distance to the nearest whole unit of the drop zone: "350 ft" or
 * "107 m".
 */
export function formatDistance(m: number, units: UnitSystem): string {
  const value = units === 'ft' ? m / FT : m;
  return units === 'ft' ? `${withCommas(value)} ft` : `${withCommas(value)} m`;
}
