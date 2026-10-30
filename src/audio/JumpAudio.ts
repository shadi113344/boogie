/**
 * The sound of the jump.
 *
 * Three things are heard: the wind, the audible altimeter and the opening.
 * The wind is a loop of white noise through a low-pass filter and a gain,
 * and both the gain and the filter follow the airspeed, so the noise is
 * loud and bright in freefall and soft and dull under the canopy. The
 * audible altimeter is beeps and a siren. The opening is the flutter of the
 * cloth, the snap of the canopy taking its shape, or the quiet of the
 * canopy flying.
 *
 * Everything is scheduled on the audio clock, never on a timer, so the
 * sound does not drift away from the simulation. Every call is safe before
 * the context has been resumed and safe in a browser with no Web Audio at
 * all, where they are simply nothing.
 */

import type { AudibleAlarm } from '@/sim/audible';

/** How the wind is being heard at the moment. */
export type WindMode = 'freefall' | 'canopy' | 'silent';

/** The sound the opening makes. */
export type OpeningSound = 'flutter' | 'snap' | 'quiet';

/** The airspeed at which the freefall wind is at its loudest, in m/s. */
const FREEFALL_FULL_MS = 55;

/** The airspeed at which the canopy wind is at its loudest, in m/s. */
const CANOPY_FULL_MS = 15;

/** The loudest the freefall wind gets. */
const FREEFALL_GAIN = 0.8;

/** The loudest the canopy wind gets. */
const CANOPY_GAIN = 0.12;

/** The cutoff of the freefall wind filter at rest, in hertz. */
const FREEFALL_CUTOFF_BASE_HZ = 400;

/** How far the freefall cutoff opens with the airspeed, in hertz per m/s. */
const FREEFALL_CUTOFF_SLOPE = 45;

/** The highest the freefall filter ever opens, in hertz. */
const FREEFALL_CUTOFF_MAX_HZ = 3500;

/** The cutoff of the canopy wind filter at rest, in hertz. */
const CANOPY_CUTOFF_BASE_HZ = 300;

/** How far the canopy cutoff opens with the airspeed, in hertz per m/s. */
const CANOPY_CUTOFF_SLOPE = 40;

/** The time the wind takes to follow the airspeed, in seconds. */
const WIND_SMOOTH_S = 0.15;

/** The frame the wind assumes when the audio clock has not moved. */
const NOMINAL_FRAME_S = 1 / 60;

/** How long the noise the wind is made of lasts, in seconds. */
const NOISE_SECONDS = 2;

/** The pitch of the beeps of the audible altimeter, in hertz. */
const BEEP_HZ = 2600;

/** How many beeps the first alarm is made of. */
const SHORT_BEEPS = 3;

/** How long a short beep lasts, in seconds. */
const BEEP_SHORT_S = 0.09;

/** The gap between the short beeps, in seconds. */
const BEEP_GAP_S = 0.11;

/** How many beeps the second alarm is made of. */
const LONG_BEEPS = 2;

/** How long a long beep lasts, in seconds. */
const BEEP_LONG_S = 0.5;

/** How loud a beep is. */
const BEEP_AMPLITUDE = 0.35;

/** The middle of the two tones of the third alarm, in hertz. */
const SIREN_MID_HZ = 2850;

/** How far the third alarm swings either side of the middle, in hertz. */
const SIREN_DEPTH_HZ = 250;

/** How fast the third alarm alternates, in hertz. */
const SIREN_RATE_HZ = 4;

/** The pitch of the flatline siren, in hertz. */
const FLATLINE_HZ = 2800;

/** How loud the siren is. */
const SIREN_AMPLITUDE = 0.22;

/** How fast the cloth flaps during the opening, in hertz. */
const FLUTTER_RATE_HZ = 14;

/** The loudest the flapping cloth gets. */
const FLUTTER_BASE = 0.5;

/** How far the flapping cloth swings either side of the loudest, in gain. */
const FLUTTER_DEPTH = 0.45;

/** How long the cloth takes to start flapping, in seconds. */
const FLUTTER_ATTACK_S = 0.15;

/** How long the cloth flapping is held, in seconds. */
const FLUTTER_HOLD_S = 1.6;

/** How long the flapping cloth lasts, in seconds. */
const FLUTTER_TOTAL_S = 2;

/** How long the snap of the canopy lasts, in seconds. */
const SNAP_S = 0.08;

/** How loud the snap of the canopy is. */
const SNAP_AMPLITUDE = 0.9;

/** The cutoff of the snap of the canopy, in hertz. */
const SNAP_CUTOFF_HZ = 400;

/** The cutoff of the quiet of the canopy, in hertz. */
const QUIET_CUTOFF_HZ = 500;

/** How loud the quiet of the canopy is. */
const QUIET_AMPLITUDE = 0.12;

/** How long the quiet of the canopy takes to come up, in seconds. */
const QUIET_ATTACK_S = 0.25;

/** How long the quiet of the canopy is held, in seconds. */
const QUIET_HOLD_S = 0.9;

/** How long the quiet of the canopy lasts, in seconds. */
const QUIET_TOTAL_S = 1.3;

/** The siren that is running, and the nodes that make it. */
interface Siren {
  /** The tone itself. */
  osc: OscillatorNode;
  /** The square wave that swings the tone, when it has one. */
  lfo: OscillatorNode | null;
  /** The gain the tone goes through. */
  gain: GainNode;
}

/**
 * How loud the wind is at an airspeed.
 *
 * In freefall the wind builds with the square of the airspeed, the way the
 * noise of the air over the ears does, and it is loud: the freefall wind
 * reaches its full loudness at 55 m/s, which is about terminal velocity for
 * a belly flyer. Under the canopy the canopy takes the buffet out of the
 * air and the wind is a tenth of the loudness, reached at 15 m/s, which is
 * about the speed of a canopy in full flight.
 *
 * @param airspeedMs the speed through the air, in m/s
 * @param mode how the wind is being heard
 * @returns the gain the wind plays at, from 0 to 1
 */
export function windGain(airspeedMs: number, mode: WindMode): number {
  if (mode === 'silent') return 0;
  const speed = Number.isFinite(airspeedMs) ? Math.max(0, airspeedMs) : 0;
  if (mode === 'freefall') {
    return Math.min(1, (speed / FREEFALL_FULL_MS) ** 2) * FREEFALL_GAIN;
  }
  return Math.min(1, (speed / CANOPY_FULL_MS) ** 2) * CANOPY_GAIN;
}

/**
 * The cutoff of the wind filter at an airspeed.
 *
 * The faster the wind, the further up the spectrum the noise is heard: in
 * freefall the filter opens with the airspeed until it runs out of travel
 * at 3,500 Hz. Under the canopy the wind is dull, and the silent mode uses
 * the canopy's cutoff: the gain is zero there, so the cutoff only matters
 * when the wind comes back.
 *
 * @param airspeedMs the speed through the air, in m/s
 * @param mode how the wind is being heard
 * @returns the cutoff of the low-pass filter, in hertz
 */
export function windCutoffHz(airspeedMs: number, mode: WindMode): number {
  const speed = Number.isFinite(airspeedMs) ? Math.max(0, airspeedMs) : 0;
  if (mode === 'freefall') {
    return Math.min(
      FREEFALL_CUTOFF_MAX_HZ,
      FREEFALL_CUTOFF_BASE_HZ + FREEFALL_CUTOFF_SLOPE * speed,
    );
  }
  return CANOPY_CUTOFF_BASE_HZ + CANOPY_CUTOFF_SLOPE * speed;
}

/**
 * The default way of getting an audio context.
 *
 * The context is made without a user gesture, which every browser allows:
 * it starts suspended, and `resume` starts it from the tap on the jump
 * button, which is the gesture the iOS rule asks for.
 */
function defaultContextFactory(): AudioContext {
  const scope = globalThis as unknown as {
    AudioContext?: typeof AudioContext;
    webkitAudioContext?: typeof AudioContext;
  };
  const Ctor = scope.AudioContext ?? scope.webkitAudioContext;
  if (!Ctor) throw new Error('this browser has no Web Audio');
  return new Ctor();
}

/**
 * Makes an audio context, or nothing at all.
 *
 * A browser without Web Audio, or a factory that throws, leaves the audio
 * silent rather than breaking the jump.
 */
function tryContext(factory: () => AudioContext): AudioContext | null {
  try {
    return factory();
  } catch {
    return null;
  }
}

/**
 * The sound of the jump.
 *
 * The audio is made once, when the jump is set up, and driven from there:
 * the wind is set every frame from the airspeed, the audible altimeter
 * beeps and sirens, and the opening makes its noise when the canopy comes
 * out. Nothing here throws, whatever the browser does.
 */
export class JumpAudio {
  /** The context, or null when the browser has no Web Audio. */
  private ctx: AudioContext | null;

  /** The noise the wind and the opening are made of. */
  private noise: AudioBuffer | null = null;

  /** The looping noise that feeds the wind filter. */
  private windSource: AudioBufferSourceNode | null = null;

  /** The low-pass filter the wind goes through. */
  private windFilter: BiquadFilterNode | null = null;

  /** The gain the wind goes through. */
  private windGainNode: GainNode | null = null;

  /** The loudness of the wind, smoothed. */
  private windLevel = 0;

  /** The cutoff of the wind filter, smoothed, in hertz. */
  private windCutoff = CANOPY_CUTOFF_BASE_HZ;

  /** The context time of the last call to `setWind`, or null before the first. */
  private lastWindTimeS: number | null = null;

  /** The siren that is running at the moment. */
  private siren: Siren | null = null;

  /** The one-shot sounds that are playing. */
  private readonly voices = new Set<AudioScheduledSourceNode>();

  /**
   * @param ctxFactory how to get an audio context; the default is the one
   *   the browser gives, if it has one at all
   */
  constructor(ctxFactory: () => AudioContext = defaultContextFactory) {
    this.ctx = tryContext(ctxFactory);
    if (this.ctx) this.buildWind(this.ctx);
  }

  /**
   * Starts the sound.
   *
   * This is called from the tap on the jump button, which is the gesture
   * the browser wants before a context may make any noise.
   */
  async resume(): Promise<void> {
    const ctx = this.ctx;
    if (!ctx) return;
    try {
      if (ctx.state === 'suspended') await ctx.resume();
    } catch {
      // A context that will not start leaves the jump without sound.
    }
  }

  /**
   * Sets the wind from the airspeed.
   *
   * The loudness and the cutoff both follow the airspeed over about a
   * sixth of a second, so the wind comes up with the jumper instead of
   * jumping from nothing to the full roar of the exit.
   *
   * @param airspeedMs the speed through the air, in m/s
   * @param mode how the wind is being heard
   */
  setWind(airspeedMs: number, mode: WindMode): void {
    const ctx = this.ctx;
    const gainNode = this.windGainNode;
    const filter = this.windFilter;
    if (!ctx || !gainNode || !filter) return;

    const now = ctx.currentTime;
    const elapsed = this.lastWindTimeS === null ? NOMINAL_FRAME_S : now - this.lastWindTimeS;
    this.lastWindTimeS = now;
    // A clock that has jumped forwards, a tab that has been in the
    // background, does not bring the wind up in one step.
    const step = Number.isFinite(elapsed) && elapsed > 0 ? Math.min(elapsed, WIND_SMOOTH_S * 4) : NOMINAL_FRAME_S;
    const alpha = 1 - Math.exp(-step / WIND_SMOOTH_S);

    this.windLevel += (windGain(airspeedMs, mode) - this.windLevel) * alpha;
    this.windCutoff += (windCutoffHz(airspeedMs, mode) - this.windCutoff) * alpha;
    gainNode.gain.setValueAtTime(this.windLevel, now);
    filter.frequency.setValueAtTime(this.windCutoff, now);
  }

  /**
   * Beeps the audible altimeter.
   *
   * The first alarm is three short beeps and the second is two long ones.
   * The third alarm and the flatline are the siren, which `setContinuous`
   * runs, so they are nothing here.
   *
   * @param a the alarm that was crossed
   */
  alarm(a: AudibleAlarm): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const now = ctx.currentTime;
    if (a === 'alarm1') {
      for (let i = 0; i < SHORT_BEEPS; i += 1) {
        this.beep(ctx, now + i * (BEEP_SHORT_S + BEEP_GAP_S), BEEP_SHORT_S);
      }
    } else if (a === 'alarm2') {
      for (let i = 0; i < LONG_BEEPS; i += 1) {
        this.beep(ctx, now + i * (BEEP_LONG_S + BEEP_GAP_S), BEEP_LONG_S);
      }
    }
  }

  /**
   * Runs the siren, or stops it.
   *
   * The third alarm alternates between two tones four times a second, the
   * way the altimeter on the wrist does, and the flatline is a steady tone.
   * The first two alarms are beeps and are left to `alarm`.
   *
   * @param a the alarm that is running, or null to stop the siren
   */
  setContinuous(a: AudibleAlarm | null): void {
    const ctx = this.ctx;
    if (!ctx) return;
    this.stopSiren();
    if (a === 'alarm3') this.startAlternating(ctx);
    else if (a === 'flatline') this.startSteady(ctx);
  }

  /**
   * Makes the noise of the opening.
   *
   * The flutter is the cloth beating, the snap is the canopy taking its
   * shape, and the quiet is the sound of the canopy flying.
   *
   * @param s which part of the opening is being heard
   */
  opening(s: OpeningSound): void {
    const ctx = this.ctx;
    if (!ctx || !this.noise) return;
    if (s === 'flutter') this.flutter(ctx);
    else if (s === 'snap') this.snap(ctx);
    else this.quiet(ctx);
  }

  /** Stops everything and lets the context go. */
  dispose(): void {
    this.stopSiren();
    for (const voice of this.voices) {
      try {
        voice.stop();
        voice.disconnect();
      } catch {
        // A voice that will not stop has already stopped.
      }
    }
    this.voices.clear();
    try {
      this.windSource?.stop();
      this.windSource?.disconnect();
      this.windFilter?.disconnect();
      this.windGainNode?.disconnect();
    } catch {
      // A wind that will not stop has already stopped.
    }
    this.windSource = null;
    this.windFilter = null;
    this.windGainNode = null;
    this.noise = null;
    const ctx = this.ctx;
    this.ctx = null;
    if (!ctx) return;
    try {
      void ctx.close().catch(() => {
        // A context that will not close is already gone.
      });
    } catch {
      // A context that will not close is already gone.
    }
  }

  /**
   * Builds the wind: two seconds of noise, a low-pass filter and a gain.
   */
  private buildWind(ctx: AudioContext): void {
    try {
      const length = Math.max(1, Math.floor(ctx.sampleRate * NOISE_SECONDS));
      const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
      const data = buffer.getChannelData(0);
      for (let i = 0; i < data.length; i += 1) {
        data[i] = Math.random() * 2 - 1;
      }
      this.noise = buffer;

      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.loop = true;
      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = CANOPY_CUTOFF_BASE_HZ;
      const gain = ctx.createGain();
      gain.gain.value = 0;
      source.connect(filter);
      filter.connect(gain);
      gain.connect(ctx.destination);
      source.start(ctx.currentTime);

      this.windSource = source;
      this.windFilter = filter;
      this.windGainNode = gain;
    } catch {
      // A browser that cannot make the noise simply has no wind.
      this.windSource = null;
      this.windFilter = null;
      this.windGainNode = null;
    }
  }

  /**
   * One beep of the audible altimeter.
   *
   * @param ctx the context to make the beep in
   * @param atS the moment the beep starts, on the context clock
   * @param durationS how long the beep lasts
   */
  private beep(ctx: AudioContext, atS: number, durationS: number): void {
    try {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(BEEP_HZ, atS);
      const gain = ctx.createGain();
      const attack = Math.min(0.008, durationS / 4);
      gain.gain.setValueAtTime(0, atS);
      gain.gain.linearRampToValueAtTime(BEEP_AMPLITUDE, atS + attack);
      gain.gain.setValueAtTime(BEEP_AMPLITUDE, atS + durationS - attack);
      gain.gain.linearRampToValueAtTime(0, atS + durationS);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(atS);
      osc.stop(atS + durationS);
      this.track(osc);
    } catch {
      // A beep that cannot be made is a beep that is not heard.
    }
  }

  /**
   * Starts the siren of the third alarm: two tones, four times a second.
   *
   * The tone sits in the middle of the two and a square wave at four
   * hertz swings it 250 Hz either side, so it alternates between 2,600 and
   * 3,100 Hz for as long as it runs.
   */
  private startAlternating(ctx: AudioContext): void {
    try {
      const at = ctx.currentTime;
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(SIREN_MID_HZ, at);
      const lfo = ctx.createOscillator();
      lfo.type = 'square';
      lfo.frequency.setValueAtTime(SIREN_RATE_HZ, at);
      const depth = ctx.createGain();
      depth.gain.setValueAtTime(SIREN_DEPTH_HZ, at);
      lfo.connect(depth);
      depth.connect(osc.frequency);
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(SIREN_AMPLITUDE, at);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(at);
      lfo.start(at);
      this.siren = { osc, lfo, gain };
    } catch {
      this.siren = null;
    }
  }

  /** Starts the flatline siren: one steady tone. */
  private startSteady(ctx: AudioContext): void {
    try {
      const at = ctx.currentTime;
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(FLATLINE_HZ, at);
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(SIREN_AMPLITUDE, at);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(at);
      this.siren = { osc, lfo: null, gain };
    } catch {
      this.siren = null;
    }
  }

  /** Stops the siren that is running, if there is one. */
  private stopSiren(): void {
    const siren = this.siren;
    if (!siren) return;
    this.siren = null;
    try {
      siren.osc.stop();
      siren.lfo?.stop();
      siren.osc.disconnect();
      siren.lfo?.disconnect();
      siren.gain.disconnect();
    } catch {
      // A siren that will not stop has already stopped.
    }
  }

  /** The flutter of the cloth during the opening. */
  private flutter(ctx: AudioContext): void {
    try {
      const at = ctx.currentTime;
      const source = ctx.createBufferSource();
      source.buffer = this.noise;
      source.loop = true;
      const gain = ctx.createGain();
      // The cloth beats at fourteen hertz: the noise is turned up and down
      // that fast. The depth comes up with the noise, so the gain never
      // goes below nothing.
      const lfo = ctx.createOscillator();
      lfo.type = 'sine';
      lfo.frequency.setValueAtTime(FLUTTER_RATE_HZ, at);
      const depth = ctx.createGain();
      depth.gain.setValueAtTime(0, at);
      depth.gain.linearRampToValueAtTime(FLUTTER_DEPTH, at + FLUTTER_ATTACK_S);
      depth.gain.setValueAtTime(FLUTTER_DEPTH, at + FLUTTER_HOLD_S);
      depth.gain.linearRampToValueAtTime(0, at + FLUTTER_TOTAL_S);
      lfo.connect(depth);
      depth.connect(gain.gain);
      gain.gain.setValueAtTime(0, at);
      gain.gain.linearRampToValueAtTime(FLUTTER_BASE, at + FLUTTER_ATTACK_S);
      gain.gain.setValueAtTime(FLUTTER_BASE, at + FLUTTER_HOLD_S);
      gain.gain.linearRampToValueAtTime(0, at + FLUTTER_TOTAL_S);
      source.connect(gain);
      gain.connect(ctx.destination);
      source.start(at);
      lfo.start(at);
      source.stop(at + FLUTTER_TOTAL_S);
      lfo.stop(at + FLUTTER_TOTAL_S);
      this.track(source);
      this.track(lfo);
    } catch {
      // A flutter that cannot be made is a flutter that is not heard.
    }
  }

  /** The snap of the canopy taking its shape. */
  private snap(ctx: AudioContext): void {
    try {
      const at = ctx.currentTime;
      const source = ctx.createBufferSource();
      source.buffer = this.noise;
      source.loop = false;
      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.setValueAtTime(SNAP_CUTOFF_HZ, at);
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0, at);
      gain.gain.linearRampToValueAtTime(SNAP_AMPLITUDE, at + 0.005);
      gain.gain.linearRampToValueAtTime(0, at + SNAP_S);
      source.connect(filter);
      filter.connect(gain);
      gain.connect(ctx.destination);
      source.start(at);
      source.stop(at + SNAP_S);
      this.track(source);
    } catch {
      // A snap that cannot be made is a snap that is not heard.
    }
  }

  /** The quiet of the canopy flying. */
  private quiet(ctx: AudioContext): void {
    try {
      const at = ctx.currentTime;
      const source = ctx.createBufferSource();
      source.buffer = this.noise;
      source.loop = true;
      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.setValueAtTime(QUIET_CUTOFF_HZ, at);
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0, at);
      gain.gain.linearRampToValueAtTime(QUIET_AMPLITUDE, at + QUIET_ATTACK_S);
      gain.gain.setValueAtTime(QUIET_AMPLITUDE, at + QUIET_HOLD_S);
      gain.gain.linearRampToValueAtTime(0, at + QUIET_TOTAL_S);
      source.connect(filter);
      filter.connect(gain);
      gain.connect(ctx.destination);
      source.start(at);
      source.stop(at + QUIET_TOTAL_S);
      this.track(source);
    } catch {
      // A quiet that cannot be made is a quiet that is not heard.
    }
  }

  /** Keeps a one-shot sound so that it can be stopped when the audio goes. */
  private track(source: AudioScheduledSourceNode): void {
    this.voices.add(source);
    source.onended = () => {
      this.voices.delete(source);
    };
  }
}
