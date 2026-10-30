import { describe, expect, it } from 'vitest';
import { JumpAudio, windCutoffHz, windGain } from '@/audio/JumpAudio';

/**
 * A fake Web Audio context.
 *
 * happy-dom has no Web Audio, so the tests build the smallest context that
 * the audio needs: a gain, an oscillator, a filter, a buffer and a buffer
 * source. Every node records what it was told, so the tests can ask what
 * the sound would have been.
 */

/** A recorded call on an audio parameter. */
interface ParamCall {
  kind: 'setValueAtTime' | 'linearRampToValueAtTime';
  value: number;
  time: number;
}

/** An audio parameter that remembers what was asked of it. */
class FakeParam {
  value: number;

  readonly calls: ParamCall[] = [];

  readonly connections: unknown[] = [];

  constructor(value = 0) {
    this.value = value;
  }

  setValueAtTime(value: number, time: number): this {
    this.value = value;
    this.calls.push({ kind: 'setValueAtTime', value, time });
    return this;
  }

  linearRampToValueAtTime(value: number, time: number): this {
    this.value = value;
    this.calls.push({ kind: 'linearRampToValueAtTime', value, time });
    return this;
  }

  connect(destination: unknown): unknown {
    this.connections.push(destination);
    return destination;
  }

  disconnect(): void {
    this.connections.length = 0;
  }
}

/** An audio node that remembers what it was connected to. */
class FakeNode {
  readonly connections: unknown[] = [];

  connect(destination: unknown): unknown {
    this.connections.push(destination);
    return destination;
  }

  disconnect(): void {
    this.connections.length = 0;
  }
}

/** A gain node. */
class FakeGain extends FakeNode {
  readonly gain = new FakeParam(1);
}

/** An oscillator node. */
class FakeOscillator extends FakeNode {
  readonly frequency = new FakeParam(440);

  type: string = 'sine';

  startedAt: number | null = null;

  stoppedAt: number | null = null;

  onended: (() => void) | null = null;

  start(when = 0): void {
    this.startedAt = when;
  }

  stop(when = 0): void {
    this.stoppedAt = when;
  }
}

/** A filter node. */
class FakeFilter extends FakeNode {
  readonly frequency = new FakeParam(350);

  type: string = 'lowpass';
}

/** A buffer source node. */
class FakeSource extends FakeNode {
  buffer: FakeBuffer | null = null;

  loop = false;

  startedAt: number | null = null;

  stoppedAt: number | null = null;

  onended: (() => void) | null = null;

  start(when = 0): void {
    this.startedAt = when;
  }

  stop(when = 0): void {
    this.stoppedAt = when;
  }
}

/** A buffer of noise. */
class FakeBuffer {
  readonly numberOfChannels: number;

  readonly length: number;

  readonly sampleRate: number;

  private readonly data: Float32Array;

  constructor(channels: number, length: number, sampleRate: number) {
    this.numberOfChannels = channels;
    this.length = length;
    this.sampleRate = sampleRate;
    this.data = new Float32Array(length);
  }

  getChannelData(channel: number): Float32Array {
    if (channel !== 0) throw new Error('the noise has one channel');
    return this.data;
  }
}

/** The context the audio is built on. */
class FakeAudioContext {
  currentTime = 0;

  state: 'suspended' | 'running' | 'closed' = 'suspended';

  readonly destination = new FakeNode();

  readonly gains: FakeGain[] = [];

  readonly oscillators: FakeOscillator[] = [];

  readonly filters: FakeFilter[] = [];

  readonly sources: FakeSource[] = [];

  readonly buffers: FakeBuffer[] = [];

  resumeCalls = 0;

  closeCalls = 0;

  createGain(): FakeGain {
    const gain = new FakeGain();
    this.gains.push(gain);
    return gain;
  }

  createOscillator(): FakeOscillator {
    const oscillator = new FakeOscillator();
    this.oscillators.push(oscillator);
    return oscillator;
  }

  createBiquadFilter(): FakeFilter {
    const filter = new FakeFilter();
    this.filters.push(filter);
    return filter;
  }

  createBufferSource(): FakeSource {
    const source = new FakeSource();
    this.sources.push(source);
    return source;
  }

  createBuffer(channels: number, length: number, sampleRate: number): FakeBuffer {
    const buffer = new FakeBuffer(channels, length, sampleRate);
    this.buffers.push(buffer);
    return buffer;
  }

  async resume(): Promise<void> {
    this.resumeCalls += 1;
    this.state = 'running';
  }

  async close(): Promise<void> {
    this.closeCalls += 1;
    this.state = 'closed';
  }
}

/** The audio and the context it was built on. */
function makeAudio(): { audio: JumpAudio; ctx: FakeAudioContext } {
  const ctx = new FakeAudioContext();
  const audio = new JumpAudio(() => ctx as unknown as AudioContext);
  return { audio, ctx };
}

/** The item at an index, or a failure if there is none. */
function at<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) throw new Error(`nothing at ${index}`);
  return item;
}

describe('the wind curves', () => {
  it('puts the freefall wind at its full loudness at 55 m/s', () => {
    expect(windGain(0, 'freefall')).toBe(0);
    expect(windGain(55, 'freefall')).toBeCloseTo(0.8, 10);
    expect(windGain(30, 'freefall')).toBeCloseTo(((30 / 55) ** 2) * 0.8, 10);
  });

  it('gets louder as the airspeed rises', () => {
    let last = windGain(0, 'freefall');
    for (let v = 1; v <= 90; v += 1) {
      const gain = windGain(v, 'freefall');
      expect(gain).toBeGreaterThanOrEqual(last);
      last = gain;
    }
    let cutoff = windCutoffHz(0, 'freefall');
    for (let v = 1; v <= 90; v += 1) {
      const next = windCutoffHz(v, 'freefall');
      expect(next).toBeGreaterThanOrEqual(cutoff);
      cutoff = next;
    }
  });

  it('is far quieter under the canopy than in freefall', () => {
    for (let v = 30; v <= 55; v += 1) {
      expect(windGain(v, 'canopy')).toBeLessThan(windGain(v, 'freefall'));
    }
    expect(windGain(55, 'canopy')).toBeLessThan(windGain(55, 'freefall') / 4);
    expect(windGain(15, 'canopy')).toBeCloseTo(0.12, 10);
  });

  it('is silent when it is meant to be silent', () => {
    expect(windGain(55, 'silent')).toBe(0);
    expect(windGain(0, 'silent')).toBe(0);
  });

  it('opens the filter with the airspeed', () => {
    expect(windCutoffHz(0, 'freefall')).toBe(400);
    expect(windCutoffHz(55, 'freefall')).toBe(400 + 45 * 55);
    expect(windCutoffHz(100, 'freefall')).toBe(3500);
    expect(windCutoffHz(0, 'canopy')).toBe(300);
    expect(windCutoffHz(15, 'canopy')).toBe(300 + 40 * 15);
  });
});

describe('the jump audio', () => {
  it('follows the airspeed, smoothed over a sixth of a second', () => {
    const { audio, ctx } = makeAudio();
    for (let i = 0; i < 60; i += 1) {
      ctx.currentTime += 1 / 60;
      audio.setWind(55, 'freefall');
    }
    const wind = at(ctx.gains, 0);
    expect(wind.gain.value).toBeGreaterThan(0.79);
    expect(wind.gain.value).toBeLessThanOrEqual(0.8);
    const filter = at(ctx.filters, 0);
    expect(filter.frequency.value).toBeGreaterThan(2800);
    expect(filter.frequency.value).toBeLessThanOrEqual(400 + 45 * 55);
  });

  it('falls quiet when the wind is switched off', () => {
    const { audio, ctx } = makeAudio();
    for (let i = 0; i < 30; i += 1) {
      ctx.currentTime += 1 / 60;
      audio.setWind(55, 'freefall');
    }
    const wind = at(ctx.gains, 0);
    expect(wind.gain.value).toBeGreaterThan(0.5);
    for (let i = 0; i < 120; i += 1) {
      ctx.currentTime += 1 / 60;
      audio.setWind(55, 'silent');
    }
    expect(wind.gain.value).toBeLessThan(0.01);
  });

  it('beeps the first two alarms and leaves the siren to setContinuous', () => {
    const { audio, ctx } = makeAudio();
    const start = ctx.currentTime;

    audio.alarm('alarm1');
    expect(ctx.oscillators).toHaveLength(3);
    for (const oscillator of ctx.oscillators) {
      expect(oscillator.frequency.value).toBe(2600);
      expect(oscillator.startedAt).not.toBeNull();
      expect(oscillator.stoppedAt).not.toBeNull();
    }
    expect(at(ctx.oscillators, 0).startedAt).toBe(start);
    expect(at(ctx.oscillators, 2).startedAt).toBeGreaterThan(start);

    audio.alarm('alarm2');
    expect(ctx.oscillators).toHaveLength(5);

    audio.alarm('alarm3');
    audio.alarm('flatline');
    expect(ctx.oscillators).toHaveLength(5);
  });

  it('sirens the third alarm and the flatline', () => {
    const { audio, ctx } = makeAudio();

    audio.setContinuous('alarm3');
    expect(ctx.oscillators).toHaveLength(2);
    const tone = at(ctx.oscillators, 0);
    const lfo = at(ctx.oscillators, 1);
    expect(lfo.type).toBe('square');
    expect(lfo.frequency.value).toBe(4);
    // The tone swings 250 Hz either side of the middle, so it alternates
    // between 2,600 and 3,100 Hz.
    expect(tone.frequency.value).toBe(2850);
    const depth = at(ctx.gains, 1);
    expect(depth.gain.value).toBe(250);
    expect(depth.connections).toContain(tone.frequency);

    audio.setContinuous('flatline');
    expect(tone.stoppedAt).not.toBeNull();
    const flat = at(ctx.oscillators, ctx.oscillators.length - 1);
    expect(flat.frequency.value).toBe(2800);

    audio.setContinuous(null);
    expect(flat.stoppedAt).not.toBeNull();
  });

  it('makes the three opening sounds', () => {
    const { audio, ctx } = makeAudio();

    audio.opening('flutter');
    expect(ctx.oscillators).toHaveLength(1);
    expect(at(ctx.oscillators, 0).frequency.value).toBe(14);
    const flutter = at(ctx.sources, ctx.sources.length - 1);
    expect(flutter.startedAt).not.toBeNull();
    expect(flutter.loop).toBe(true);

    const before = ctx.sources.length;
    audio.opening('snap');
    const snap = at(ctx.sources, before);
    expect(snap.startedAt).not.toBeNull();
    expect(snap.stoppedAt).not.toBeNull();
    expect((snap.stoppedAt ?? 0) - (snap.startedAt ?? 0)).toBeCloseTo(0.08, 3);
    const filter = at(ctx.filters, ctx.filters.length - 1);
    expect(filter.type).toBe('lowpass');
    expect(filter.frequency.value).toBeLessThanOrEqual(500);

    const beforeQuiet = ctx.sources.length;
    audio.opening('quiet');
    const quiet = at(ctx.sources, beforeQuiet);
    expect(quiet.startedAt).not.toBeNull();
  });

  it('resumes the context and closes it again', async () => {
    const { audio, ctx } = makeAudio();
    await audio.resume();
    expect(ctx.resumeCalls).toBe(1);
    expect(ctx.state).toBe('running');

    audio.setContinuous('alarm3');
    audio.dispose();
    expect(ctx.closeCalls).toBe(1);
    expect(at(ctx.oscillators, 0).stoppedAt).not.toBeNull();
  });

  it('does nothing at all when there is no Web Audio', async () => {
    const audio = new JumpAudio(() => {
      throw new Error('no Web Audio here');
    });
    expect(() => audio.setWind(55, 'freefall')).not.toThrow();
    expect(() => audio.alarm('alarm1')).not.toThrow();
    expect(() => audio.setContinuous('alarm3')).not.toThrow();
    expect(() => audio.opening('flutter')).not.toThrow();
    await expect(audio.resume()).resolves.toBeUndefined();
    expect(() => audio.dispose()).not.toThrow();
  });

  it('can be built without throwing when the browser has no Web Audio', () => {
    expect(() => new JumpAudio()).not.toThrow();
  });
});
