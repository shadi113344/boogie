/**
 * The drop zones that come with the app.
 *
 * A drop zone is data: where it is, the landing area in it, the height the
 * aircraft leaves the jump at, the units its country uses and the time zone
 * the jump is flown in. The coordinates are the centres of the landing areas
 * and are good to a few hundred metres; the landing area is a circle of
 * `lzRadiusM` around them until an adjuster puts the real one on the grass.
 *
 * This module imports nothing from three.js or the DOM.
 */

import type { LonLat } from '@/world/geo';

export interface DropZone {
  id: 'sharm' | 'dubai' | 'empuriabrava' | 'gryttjom' | 'hinton' | 'interlaken' | string;
  /** The name of the drop zone. */
  name: string;
  /** The country it is in. */
  country: string;
  /** The two-letter code of the country. */
  countryCode: string;
  /** The centre of the landing area. */
  lz: LonLat;
  /** The radius of the landing area, in metres. */
  lzRadiusM: number;
  /** The height the jump is made from, in feet above mean sea level. */
  exitAltitudeFt: number;
  /** The units the drop zone's country measures in. */
  units: 'ft' | 'm';
  /** The IANA time zone of the drop zone. */
  timeZone: string;
  /** The aircraft the jump is made from. */
  aircraft: 'C208';
  /** The heading of the jump run, in degrees, for the drop zones that have one. */
  jumpRunHeadingDeg?: number;
  /** A word or two about the place. */
  notes?: string;
}

/**
 * The six drop zones of the spec, with the units and the exit heights their
 * clubs use.
 */
export const DROP_ZONES: readonly DropZone[] = [
  {
    id: 'sharm',
    name: 'Sharm El Sheikh',
    country: 'Egypt',
    countryCode: 'EG',
    lz: { lon: 34.39, lat: 27.98 },
    lzRadiusM: 100,
    exitAltitudeFt: 13000,
    units: 'ft',
    timeZone: 'Africa/Cairo',
    aircraft: 'C208',
    notes: 'desert and sea, Caravan',
  },
  {
    id: 'dubai',
    name: 'Dubai Palm',
    country: 'United Arab Emirates',
    countryCode: 'AE',
    lz: { lon: 55.14, lat: 25.09 },
    lzRadiusM: 100,
    exitAltitudeFt: 13000,
    units: 'ft',
    timeZone: 'Asia/Dubai',
    aircraft: 'C208',
    notes: 'water on three sides, landing beside the Palm; water is a hazard',
  },
  {
    id: 'empuriabrava',
    name: 'Empuriabrava',
    country: 'Spain',
    countryCode: 'ES',
    lz: { lon: 3.11, lat: 42.26 },
    lzRadiusM: 100,
    exitAltitudeFt: 13500,
    units: 'm',
    timeZone: 'Europe/Madrid',
    aircraft: 'C208',
    notes: 'the famous one, sea, canals, Pyrenees behind',
  },
  {
    id: 'gryttjom',
    name: 'Gryttjom',
    country: 'Sweden',
    countryCode: 'SE',
    lz: { lon: 17.43, lat: 60.3 },
    lzRadiusM: 100,
    exitAltitudeFt: 13500,
    units: 'm',
    timeZone: 'Europe/Stockholm',
    aircraft: 'C208',
    notes: 'forest everywhere, grass strip; off-landing means trees',
  },
  {
    id: 'hinton',
    name: 'Hinton-in-the-Hedges',
    country: 'United Kingdom',
    countryCode: 'GB',
    lz: { lon: -1.21, lat: 52.03 },
    lzRadiusM: 100,
    exitAltitudeFt: 13500,
    units: 'ft',
    timeZone: 'Europe/London',
    aircraft: 'C208',
    notes: 'hedgerows, a disused airfield, often windy',
  },
  {
    id: 'interlaken',
    name: 'Interlaken',
    country: 'Switzerland',
    countryCode: 'CH',
    lz: { lon: 7.88, lat: 46.68 },
    lzRadiusM: 100,
    exitAltitudeFt: 13500,
    units: 'm',
    timeZone: 'Europe/Zurich',
    aircraft: 'C208',
    notes: 'two lakes, the Eiger wall, the one that sells the idea on sight',
  },
];

/**
 * The drop zone with an id, or undefined when there is none.
 *
 * The id is matched without regard to case or to the spaces around it, so
 * the one in the URL is easy to type.
 */
export function findDropZone(id: string): DropZone | undefined {
  const wanted = id.trim().toLowerCase();
  return DROP_ZONES.find((dz) => dz.id === wanted);
}

/** The drop zone the app flies when the URL does not name one. */
export const DEFAULT_DROP_ZONE_ID = 'interlaken';
