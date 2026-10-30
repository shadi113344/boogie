/**
 * Seeded pseudo-random numbers.
 *
 * The simulation must be reproducible: the same jump with the same seed and
 * the same inputs flies the same path. This is mulberry32, a small, fast
 * generator with a period long enough for a jump. This module imports
 * nothing from three.js or the DOM.
 */

export class Rng {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  /** The next number, in [0, 1). */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** A number between `min` and `max`, the upper bound excluded. */
  range(min: number, max: number): number {
    return min + this.next() * (max - min);
  }

  /** A number from the standard normal distribution. */
  normal(): number {
    let u = 0;
    let v = 0;
    let s = 0;
    do {
      u = this.next() * 2 - 1;
      v = this.next() * 2 - 1;
      s = u * u + v * v;
    } while (s >= 1 || s === 0);
    return u * Math.sqrt((-2 * Math.log(s)) / s);
  }
}
