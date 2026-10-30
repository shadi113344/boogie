/**
 * The canopies the jumper can fly.
 *
 * The numbers here are the ones the spec's tables give: the area of the
 * canopy, what it does with the brakes, how fast it rolls in and out of a
 * bank, and how much it dives while it is turning. They are the starting
 * values of the physics; nothing in the simulation looks a number up, the
 * simulation flies the canopy out of them.
 *
 * The full flight and half brake figures are for the reference jumper of
 * 97 kg (85 kg of body and 12 kg of gear) at sea level, and they are the
 * total airspeed and the sink.
 */

export type CanopyId = 'student-280' | 'sport-210' | 'sport-170' | 'elliptical-150' | 'reserve-220';

export interface CanopySpec {
  id: CanopyId;
  name: string;
  /** The area of the canopy, in square feet. */
  areaFt2: number;
  /** The number of cells across the span. */
  cells: 7 | 9;
  /** The speed and the sink with the brakes released, for the reference jumper at sea level. */
  fullFlight: { mph: number; fpm: number };
  /** The speed and the sink with the brakes at half travel. */
  halfBrakes: { mph: number; fpm: number };
  /** The steepest bank the canopy will hold, in degrees. */
  bankMaxDeg: number;
  /** How fast the canopy rolls into a bank, in degrees per second. */
  rollRateDegS: number;
  /** How fast the canopy rolls out of a bank, in degrees per second. */
  rollOutDegS: number;
  /** How much of the lift a full dive takes away. */
  diveGain: number;
  /** How long the canopy takes to build a dive, in seconds. */
  diveBuildS: number;
  /** How long the canopy takes to come out of a dive, in seconds. */
  diveRecoverS: number;
}

export const CANOPIES: Record<CanopyId, CanopySpec> = {
  'student-280': {
    id: 'student-280',
    name: 'Student 280',
    areaFt2: 280,
    cells: 9,
    fullFlight: { mph: 20, fpm: 650 },
    halfBrakes: { mph: 14, fpm: 450 },
    bankMaxDeg: 30,
    rollRateDegS: 45,
    rollOutDegS: 60,
    diveGain: 0.9,
    diveBuildS: 4,
    diveRecoverS: 3,
  },
  'sport-210': {
    id: 'sport-210',
    name: 'Sport 210',
    areaFt2: 210,
    cells: 9,
    fullFlight: { mph: 25, fpm: 850 },
    halfBrakes: { mph: 17, fpm: 550 },
    bankMaxDeg: 30,
    rollRateDegS: 45,
    rollOutDegS: 60,
    diveGain: 0.9,
    diveBuildS: 4,
    diveRecoverS: 3,
  },
  'sport-170': {
    id: 'sport-170',
    name: 'Sport 170',
    areaFt2: 170,
    cells: 9,
    fullFlight: { mph: 29, fpm: 1050 },
    halfBrakes: { mph: 20, fpm: 650 },
    bankMaxDeg: 35,
    rollRateDegS: 45,
    rollOutDegS: 60,
    diveGain: 0.7,
    diveBuildS: 4,
    diveRecoverS: 3,
  },
  'elliptical-150': {
    id: 'elliptical-150',
    name: 'Elliptical 150',
    areaFt2: 150,
    cells: 9,
    fullFlight: { mph: 33, fpm: 1300 },
    halfBrakes: { mph: 23, fpm: 800 },
    bankMaxDeg: 45,
    rollRateDegS: 45,
    rollOutDegS: 60,
    diveGain: 0.9,
    diveBuildS: 4,
    diveRecoverS: 3,
  },
  'reserve-220': {
    id: 'reserve-220',
    name: 'Reserve 220',
    areaFt2: 220,
    cells: 7,
    fullFlight: { mph: 22, fpm: 800 },
    halfBrakes: { mph: 15, fpm: 560 },
    bankMaxDeg: 30,
    rollRateDegS: 40,
    rollOutDegS: 60,
    diveGain: 0.7,
    diveBuildS: 4,
    diveRecoverS: 2,
  },
};

/** The canopy a jumper gets unless they pick another one. */
export const DEFAULT_CANOPY: CanopyId = 'sport-210';
