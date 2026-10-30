import './style.css';
import { App } from '@/app/App';
import type { QualityTier } from '@/app/Quality';
import { DEFAULT_DROP_ZONE_ID, findDropZone } from '@/data/dropzones';

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

const params = new URLSearchParams(window.location.search);

// The drop zone of the URL, or the default one when the URL names a drop
// zone that does not exist.
const dz = findDropZone(params.get('dz') ?? DEFAULT_DROP_ZONE_ID) ?? findDropZone(DEFAULT_DROP_ZONE_ID)!;
const hourLocal = parseHour(params.get('t'));
const quality = parseQuality(params.get('q'));
const debug = parseDebug(params.get('debug'));

const canvas = document.querySelector<HTMLCanvasElement>('#view');
if (!canvas) {
  console.error('boogie: no canvas to draw on');
} else {
  try {
    const app = new App(canvas, { dz, hourLocal, debug, quality });
    app.start();
  } catch (error) {
    console.error('boogie: could not start', error);
  }
}
