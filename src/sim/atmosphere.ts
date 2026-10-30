/**
 * The air the jumper falls through.
 *
 * The density follows the International Standard Atmosphere from the drop
 * zone's elevation and temperature, so the whole simulation reads one
 * number for "how thick is the air here". This module imports nothing from
 * three.js or the DOM.
 */

/** The density of the standard atmosphere at sea level, in kg/m³. */
export const SEA_LEVEL_DENSITY = 1.225;

/** The specific gas constant of dry air, in J/(kg·K). */
const R_AIR = 287.05;

/** The temperature at sea level in the standard atmosphere, in kelvin. */
const T0 = 288.15;

/** The lapse rate of the standard atmosphere, in kelvin per metre. */
const LAPSE = 0.0065;

/** The pressure at sea level in the standard atmosphere, in pascal. */
const P0 = 101325;

/**
 * The density of the air at an altitude above mean sea level, in kg/m³.
 *
 * `temperatureOffsetC` is the difference between the day's temperature and
 * the standard one: +15 makes the air warmer and thinner, -15 colder and
 * denser.
 */
export function isaDensity(altitudeMslM: number, temperatureOffsetC = 0): number {
  const tStandard = T0 - LAPSE * altitudeMslM;
  const pressure = P0 * Math.pow(tStandard / T0, 5.25588);
  const temperature = tStandard + temperatureOffsetC;
  return pressure / (R_AIR * temperature);
}
