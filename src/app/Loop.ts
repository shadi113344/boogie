/**
 * The frame loop.
 *
 * One `requestAnimationFrame` chain with a clamped delta time, a pause when the
 * page is hidden and a one-second moving average of frame times.
 */

interface FrameSample {
  /** Timestamp of the frame, in milliseconds. */
  t: number;
  /** Duration of the frame, in milliseconds. */
  ms: number;
}

/** Longest delta time the simulation ever sees, in seconds. */
const MAX_DT = 0.1;

/** Length of the moving average window, in milliseconds. */
const WINDOW_MS = 1000;

function nowMs(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

export class Loop {
  private readonly cb: (dt: number, now: number) => void;

  private readonly samples: FrameSample[] = [];

  private rafId: number | null = null;

  private active = false;

  private paused = false;

  private lastTime = 0;

  constructor(cb: (dt: number, now: number) => void) {
    this.cb = cb;
    this.onVisibilityChange = this.onVisibilityChange.bind(this);
  }

  /** True between `start` and `stop`. */
  get running(): boolean {
    return this.active;
  }

  /** Begin the frame loop. Calling it twice does nothing. */
  start(): void {
    if (this.active) return;
    this.active = true;
    this.paused = false;
    this.lastTime = nowMs();
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', this.onVisibilityChange);
    }
    this.schedule();
  }

  /** Stop the frame loop. Calling it twice does nothing. */
  stop(): void {
    if (!this.active) return;
    this.active = false;
    this.paused = false;
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this.onVisibilityChange);
    }
  }

  /**
   * Frame rate and frame time over the last second.
   *
   * `frameMs` is the mean duration of the frames in the window and `fps` is
   * its reciprocal.
   */
  stats(): { fps: number; frameMs: number } {
    const latest = this.samples.length ? this.samples[this.samples.length - 1]?.t ?? 0 : 0;
    const cutoff = latest - WINDOW_MS;
    while (this.samples.length > 0 && (this.samples[0]?.t ?? 0) < cutoff) {
      this.samples.shift();
    }
    let total = 0;
    for (const sample of this.samples) total += sample.ms;
    const frameMs = this.samples.length > 0 ? total / this.samples.length : 0;
    return { fps: frameMs > 0 ? 1000 / frameMs : 0, frameMs };
  }

  private schedule(): void {
    this.rafId = requestAnimationFrame(this.frame);
  }

  private readonly frame = (timestamp: number): void => {
    this.rafId = null;
    if (!this.active) return;

    const hidden = typeof document !== 'undefined' && document.hidden;
    if (this.paused || hidden) {
      // The page is in the background: keep the chain alive, skip the work.
      this.schedule();
      return;
    }

    const now = typeof timestamp === 'number' && Number.isFinite(timestamp) ? timestamp : nowMs();
    let dt = (now - this.lastTime) / 1000;
    if (!Number.isFinite(dt) || dt < 0) dt = 0;
    if (dt > MAX_DT) dt = MAX_DT;
    this.lastTime = now;

    this.samples.push({ t: now, ms: dt * 1000 });
    if (this.samples.length > 240) this.samples.shift();

    this.schedule();
    this.cb(dt, now);
  };

  private onVisibilityChange(): void {
    this.paused = typeof document !== 'undefined' && document.hidden;
    if (!this.paused) {
      // Do not hand the simulation the time spent in the background.
      this.lastTime = nowMs();
    }
  }
}
