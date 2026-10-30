import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Loop } from '@/app/Loop';

describe('Loop', () => {
  let pending: FrameRequestCallback | null = null;
  const originalRaf = globalThis.requestAnimationFrame;
  const originalCancel = globalThis.cancelAnimationFrame;

  beforeEach(() => {
    pending = null;
    globalThis.requestAnimationFrame = ((cb: FrameRequestCallback): number => {
      pending = cb;
      return 1;
    }) as typeof globalThis.requestAnimationFrame;
    globalThis.cancelAnimationFrame = ((): void => {
      pending = null;
    }) as typeof globalThis.cancelAnimationFrame;
  });

  afterEach(() => {
    globalThis.requestAnimationFrame = originalRaf;
    globalThis.cancelAnimationFrame = originalCancel;
  });

  it('clamps dt to 0.1 s and reports fps', () => {
    const frames: number[] = [];
    const loop = new Loop((dt) => {
      frames.push(dt);
    });
    loop.start();

    const t0 = performance.now();
    expect(pending).not.toBeNull();
    pending?.(t0);
    pending?.(t0 + 500);

    expect(frames.length).toBe(2);
    expect(frames[0]).toBeLessThanOrEqual(0.1);
    expect(frames[1]).toBe(0.1);

    const stats = loop.stats();
    expect(stats.frameMs).toBeGreaterThan(0);
    expect(stats.fps).toBeGreaterThan(0);

    loop.stop();
  });

  it('is running only between start and stop', () => {
    const loop = new Loop(() => {});
    expect(loop.running).toBe(false);
    loop.start();
    expect(loop.running).toBe(true);
    loop.stop();
    expect(loop.running).toBe(false);
  });

  it('does not call back after stop', () => {
    let calls = 0;
    const loop = new Loop(() => {
      calls += 1;
    });
    loop.start();
    const t0 = performance.now();
    pending?.(t0);
    loop.stop();
    pending = null;
    expect(calls).toBe(1);
  });
});
