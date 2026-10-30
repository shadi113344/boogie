import './style.css';
import { App } from '@/app/App';
import type { QualityTier } from '@/app/Quality';
import { CANOPIES, DEFAULT_CANOPY, type CanopyId } from '@/data/canopies';
import { DEFAULT_DROP_ZONE_ID, findDropZone } from '@/data/dropzones';
import { clampBodyMass, DEFAULT_JUMPER } from '@/sim/jumper';
import { WIND_PRESETS, type WindProfile } from '@/sim/wind';

function parseHour(raw: string | null): number {
  if (raw === null) return 10;
  const hour = Number(raw);
  if (!Number.isFinite(hour)) return 10;
  return Math.min(24, Math.max(0, hour));
}

/**
 * The quality tier of the URL.
 *
 * A tier that is asked for is locked: the app does not step down from it.
 */
function parseQuality(raw: string | null): QualityTier | undefined {
  if (raw === 'low' || raw === 'medium' || raw === 'high') return raw;
  return undefined;
}

function parseDebug(raw: string | null): boolean {
  if (raw === null) return false;
  return raw !== '0' && raw !== 'false';
}

/** The wind of the URL: the typical one when the URL does not say. */
function parseWind(raw: string | null): WindProfile {
  if (raw === 'calm' || raw === 'typical' || raw === 'sporty') {
    return WIND_PRESETS[raw];
  }
  return WIND_PRESETS.typical;
}

/** The body mass of the URL, in kilograms, inside the range of the settings. */
function parseMass(raw: string | null): number {
  if (raw === null) return DEFAULT_JUMPER.bodyMassKg;
  const mass = Number(raw);
  if (!Number.isFinite(mass)) return DEFAULT_JUMPER.bodyMassKg;
  return clampBodyMass(mass);
}

/** The canopy of the URL, when it names one the app knows. */
function parseCanopy(raw: string | null): CanopyId {
  if (raw !== null && raw in CANOPIES) return raw as CanopyId;
  return DEFAULT_CANOPY;
}

/** The seed of the jump: a random one when the URL does not name it. */
function parseSeed(raw: string | null): number {
  if (raw !== null) {
    const seed = Number(raw);
    if (Number.isFinite(seed)) return Math.abs(Math.trunc(seed)) % 0x7fffffff;
  }
  return Math.floor(Math.random() * 0x7fffffff);
}

/** Plan 1's free camera, with no jump: `?free=1`. */
function parseFree(raw: string | null): boolean {
  if (raw === null) return false;
  return raw !== '0' && raw !== 'false';
}

const params = new URLSearchParams(window.location.search);

// The drop zone of the URL, or the default one when the URL names a drop
// zone that does not exist.
const dz = findDropZone(params.get('dz') ?? DEFAULT_DROP_ZONE_ID) ?? findDropZone(DEFAULT_DROP_ZONE_ID)!;
const hourLocal = parseHour(params.get('t'));
const quality = parseQuality(params.get('q'));
const debug = parseDebug(params.get('debug'));
const free = parseFree(params.get('free'));
const wind = parseWind(params.get('wind'));
const bodyMassKg = parseMass(params.get('mass'));
const canopyId = parseCanopy(params.get('canopy'));
const seed = parseSeed(params.get('seed'));

const canvas = document.querySelector<HTMLCanvasElement>('#view');
if (!canvas) {
  console.error('boogie: no canvas to draw on');
} else {
  try {
    const app = new App(canvas, {
      dz,
      hourLocal,
      debug,
      quality,
      free,
      wind,
      bodyMassKg,
      canopyId,
      seed,
    });
    app.start();
  } catch (error) {
    console.error('boogie: could not start', error);
  }
}
