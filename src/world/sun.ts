/**
 * Solar position for the Boogie world.
 *
 * NOAA's solar position algorithm, written out longhand: Julian day, geometric
 * mean longitude and anomaly, equation of centre, apparent longitude, obliquity,
 * declination, equation of time, hour angle, then elevation and azimuth.
 *
 * Accuracy is a few hundredths of a degree for the years around the present,
 * which is far inside what a sky needs. This module imports nothing from
 * three.js or the DOM; `Intl` is a language built-in.
 */

import type { LonLat } from './geo';

const DEG = Math.PI / 180;
const RAD = 180 / Math.PI;

export interface SunPosition {
  /** Azimuth measured clockwise from north: 0 is north, 90 is east. */
  azimuthDeg: number;
  /** Elevation above the horizon; negative when the sun is below it. */
  elevationDeg: number;
}

export interface SunDirection {
  /** Unit vector toward the sun in the local frame: x east, y up, z south. */
  x: number;
  y: number;
  z: number;
}

function mod360(deg: number): number {
  return ((deg % 360) + 360) % 360;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Julian day for an instant. */
function julianDay(date: Date): number {
  return date.getTime() / 86400000 + 2440587.5;
}

/**
 * Solar azimuth and elevation for an instant and a place.
 *
 * The azimuth is measured clockwise from north, the elevation from the
 * horizon. Both are in degrees.
 */
export function sunPosition(date: Date, p: LonLat): SunPosition {
  const jd = julianDay(date);
  const t = (jd - 2451545) / 36525; // Julian centuries since J2000.0

  // Geometric mean longitude and anomaly of the sun.
  const l0 = mod360(280.46646 + t * (36000.76983 + t * 0.0003032));
  const m = 357.52911 + t * (35999.05029 - 0.0001537 * t);
  const ecc = 0.016708634 - t * (0.000042037 + 0.0000001267 * t);

  // Equation of the centre, then the true and apparent longitude.
  const centre =
    Math.sin(m * DEG) * (1.914602 - t * (0.004817 + 0.000014 * t)) +
    Math.sin(2 * m * DEG) * (0.019993 - 0.000101 * t) +
    Math.sin(3 * m * DEG) * 0.000289;
  const trueLong = l0 + centre;
  const omega = 125.04 - 1934.136 * t;
  const lambda = trueLong - 0.00569 - 0.00478 * Math.sin(omega * DEG);

  // Obliquity of the ecliptic, corrected.
  const epsilon0 =
    23 + (26 + (21.448 - t * (46.815 + t * (0.00059 - t * 0.001813))) / 60) / 60;
  const epsilon = (epsilon0 + 0.00256 * Math.cos(omega * DEG)) * DEG;

  // Declination of the sun.
  const declination = Math.asin(Math.sin(epsilon) * Math.sin(lambda * DEG));

  // Equation of time, in minutes.
  const y = Math.tan(epsilon / 2) ** 2;
  const equationOfTime =
    4 *
    RAD *
    (y * Math.sin(2 * l0 * DEG) -
      2 * ecc * Math.sin(m * DEG) +
      4 * ecc * y * Math.sin(m * DEG) * Math.cos(2 * l0 * DEG) -
      0.5 * y * y * Math.sin(4 * l0 * DEG) -
      1.25 * ecc * ecc * Math.sin(2 * m * DEG));

  // True solar time, in minutes past local solar midnight.
  const utcMinutes =
    date.getUTCHours() * 60 +
    date.getUTCMinutes() +
    date.getUTCSeconds() / 60 +
    date.getUTCMilliseconds() / 60000;
  const trueSolarTime = (((utcMinutes + equationOfTime + 4 * p.lon) % 1440) + 1440) % 1440;
  const hourAngle = (trueSolarTime / 4 - 180) * DEG;

  // Local horizontal coordinates from the hour angle and the declination.
  const lat = p.lat * DEG;
  const sinLat = Math.sin(lat);
  const cosLat = Math.cos(lat);
  const sinDec = Math.sin(declination);
  const cosDec = Math.cos(declination);
  const sinHa = Math.sin(hourAngle);
  const cosHa = Math.cos(hourAngle);

  const up = sinLat * sinDec + cosLat * cosDec * cosHa;
  const east = -cosDec * sinHa;
  const north = sinDec * cosLat - cosDec * sinLat * cosHa;

  const elevation = Math.asin(clamp(up, -1, 1)) * RAD;
  const azimuth = mod360(Math.atan2(east, north) * RAD);

  return { azimuthDeg: azimuth, elevationDeg: elevation };
}

/**
 * The unit vector toward the sun in the local frame: x east, y up, z south.
 *
 * The azimuth runs clockwise from north, so north is -z.
 */
export function sunDirectionLocal(date: Date, p: LonLat): SunDirection {
  const { azimuthDeg, elevationDeg } = sunPosition(date, p);
  const az = azimuthDeg * DEG;
  const el = elevationDeg * DEG;
  const cosEl = Math.cos(el);
  return {
    x: Math.sin(az) * cosEl,
    y: Math.sin(el),
    z: -Math.cos(az) * cosEl,
  };
}

interface DayParts {
  year: number;
  month: number;
  day: number;
}

/** Parse "2026-06-21" into its parts. */
function parseIsoDay(isoDay: string): DayParts {
  const match = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(isoDay.trim());
  if (!match) throw new Error(`Not an ISO day: ${isoDay}`);
  return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
}

/**
 * The UTC offset of an IANA time zone at an instant, in milliseconds.
 *
 * The offset is positive east of Greenwich. An unknown zone falls back to the
 * mean offset of the longitude, which is the best guess a solar position can
 * make without a zone.
 */
function zoneOffsetMs(instant: Date, timeZone: string, p: LonLat): number {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).formatToParts(instant);
  } catch {
    return Math.round(p.lon / 15) * 3600000;
  }

  let year = 1970;
  let month = 1;
  let day = 1;
  let hour = 0;
  let minute = 0;
  let second = 0;
  for (const part of parts) {
    switch (part.type) {
      case 'year':
        year = Number(part.value);
        break;
      case 'month':
        month = Number(part.value);
        break;
      case 'day':
        day = Number(part.value);
        break;
      case 'hour':
        hour = Number(part.value) % 24;
        break;
      case 'minute':
        minute = Number(part.value);
        break;
      case 'second':
        second = Number(part.value);
        break;
      default:
        break;
    }
  }

  const wallClock = Date.UTC(year, month - 1, day, hour, minute, second);
  const truncated = Math.floor(instant.getTime() / 1000) * 1000;
  return wallClock - truncated;
}

/**
 * The instant of a local wall-clock time in an IANA time zone.
 *
 * "2026-06-21" at 10:00 in Europe/Zurich is 08:00 UTC. The zone's offset is
 * read with `Intl` and applied once more when the first guess lands on the
 * other side of a daylight-saving change.
 */
export function localTimeToDate(
  p: LonLat,
  timeZone: string,
  isoDay: string,
  hour: number,
): Date {
  const day = parseIsoDay(isoDay);
  const minutesOfDay = clamp(hour, 0, 24) * 60;
  const hours = Math.floor(minutesOfDay / 60);
  const minutes = Math.round(minutesOfDay - hours * 60);
  const wallClock = Date.UTC(day.year, day.month - 1, day.day, hours, minutes, 0, 0);

  let offset = zoneOffsetMs(new Date(wallClock), timeZone, p);
  let instant = wallClock - offset;
  const corrected = zoneOffsetMs(new Date(instant), timeZone, p);
  if (corrected !== offset) {
    offset = corrected;
    instant = wallClock - offset;
  }
  return new Date(instant);
}

/**
 * The calendar day in a time zone, as "2026-06-21".
 *
 * Used to place the sun on today's date in the drop zone's own day.
 */
export function localDayInZone(timeZone: string, now: Date = new Date()): string {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(now);
  } catch {
    const iso = now.toISOString();
    return iso.slice(0, 10);
  }

  let year = '0000';
  let month = '01';
  let day = '01';
  for (const part of parts) {
    if (part.type === 'year') year = part.value;
    else if (part.type === 'month') month = part.value;
    else if (part.type === 'day') day = part.value;
  }
  return `${year}-${month}-${day}`;
}
