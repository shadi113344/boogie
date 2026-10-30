import { describe, it, expect } from 'vitest';
import { dragToFallRate, isPlfRoll, isPullSwipe, padToBody, toggleDepth } from '@/ui/input/gestures';
import type { PointerSample } from '@/ui/input/gestures';

const WIDTH = 390;
const HEIGHT = 844;

/** The finger on the pull handle, at the lower right. */
const START: PointerSample = { x: 300, y: 700, tMs: 1000 };

describe('isPullSwipe', () => {
  it('takes a rightward swipe of 8 percent of the width within 600 ms', () => {
    expect(isPullSwipe(START, { x: 360, y: 700, tMs: 1300 }, WIDTH)).toBe(true);
  });

  it('ignores a swipe that is too short', () => {
    expect(isPullSwipe(START, { x: 320, y: 700, tMs: 1300 }, WIDTH)).toBe(false);
  });

  it('ignores a swipe that is too slow', () => {
    expect(isPullSwipe(START, { x: 360, y: 700, tMs: 1900 }, WIDTH)).toBe(false);
  });

  it('ignores a swipe that goes the wrong way', () => {
    expect(isPullSwipe(START, { x: 240, y: 700, tMs: 1300 }, WIDTH)).toBe(false);
  });
});

describe('dragToFallRate', () => {
  it('is fully de-arched at 15 percent of the height upwards', () => {
    expect(dragToFallRate(-0.15 * HEIGHT, HEIGHT)).toBe(-1);
  });

  it('is fully arched at 15 percent of the height downwards', () => {
    expect(dragToFallRate(0.15 * HEIGHT, HEIGHT)).toBe(1);
  });

  it('is nothing at the middle', () => {
    expect(dragToFallRate(0, HEIGHT)).toBe(0);
  });

  it('grows with the drag', () => {
    expect(dragToFallRate(-0.075 * HEIGHT, HEIGHT)).toBeCloseTo(-0.5, 9);
    expect(dragToFallRate(-0.5 * HEIGHT, HEIGHT)).toBe(-1);
  });
});

describe('padToBody', () => {
  it('turns fully at 12 percent of the width', () => {
    expect(padToBody(0.12 * WIDTH, 0, WIDTH).turn).toBeCloseTo(1, 9);
    expect(padToBody(-0.12 * WIDTH, 0, WIDTH).turn).toBeCloseTo(-1, 9);
  });

  it('drives forward when the thumb goes up', () => {
    expect(padToBody(0, -0.12 * WIDTH, WIDTH).drive).toBeCloseTo(1, 9);
    expect(padToBody(0, 0.12 * WIDTH, WIDTH).drive).toBeCloseTo(-1, 9);
  });

  it('is nothing when the thumb is in the middle', () => {
    const body = padToBody(0, 0, WIDTH);
    expect(body.turn).toBe(0);
    expect(body.drive).toBe(0);
  });
});

describe('toggleDepth', () => {
  it('is fully pulled at 35 percent of the height', () => {
    expect(toggleDepth(0.35 * HEIGHT, HEIGHT)).toBeCloseTo(1, 9);
  });

  it('is half pulled at half of that', () => {
    expect(toggleDepth(0.175 * HEIGHT, HEIGHT)).toBeCloseTo(0.5, 9);
  });

  it('is nothing above the toggle', () => {
    expect(toggleDepth(0, HEIGHT)).toBe(0);
    expect(toggleDepth(-100, HEIGHT)).toBe(0);
  });
});

describe('isPlfRoll', () => {
  it('takes a roll of more than 120 degrees a second', () => {
    expect(isPlfRoll(121)).toBe(true);
    expect(isPlfRoll(-200)).toBe(true);
  });

  it('ignores a slow roll', () => {
    expect(isPlfRoll(120)).toBe(false);
    expect(isPlfRoll(0)).toBe(false);
  });
});
