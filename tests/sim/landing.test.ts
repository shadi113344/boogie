import { describe, expect, it } from 'vitest';
import { classifyLanding, PLF_WINDOW_S } from '@/sim/landing';

describe('the landing', () => {
  it('gives a jumper who is neither fast nor quick a stand-up', () => {
    expect(classifyLanding(1, 3, false)).toBe('stand-up');
    expect(classifyLanding(0, 0, false)).toBe('stand-up');
    expect(classifyLanding(2.49, 4.99, false)).toBe('stand-up');
  });

  it('makes a jumper who is going too fast run it out', () => {
    expect(classifyLanding(1, 5, false)).toBe('run-out');
    expect(classifyLanding(1, 7.99, false)).toBe('run-out');
  });

  it('makes a jumper who is going too fast slide', () => {
    expect(classifyLanding(1, 8.01, false)).toBe('slide');
    expect(classifyLanding(1, 14.99, false)).toBe('slide');
  });

  it('makes a jumper who lands hard enough a sprain', () => {
    expect(classifyLanding(2.5, 3, false)).toBe('sprain');
    expect(classifyLanding(5, 3, false)).toBe('sprain');
  });

  it('makes a jumper who lands hard enough with a PLF in time a PLF', () => {
    expect(classifyLanding(2.5, 3, true)).toBe('plf');
    expect(classifyLanding(5, 3, true)).toBe('plf');
  });

  it('makes a jumper who lands too hard an injury', () => {
    expect(classifyLanding(5.01, 3, false)).toBe('injury');
    expect(classifyLanding(5.01, 3, true)).toBe('injury');
    expect(classifyLanding(1, 15.01, false)).toBe('injury');
  });

  it('makes a jumper who lands very hard a fatality', () => {
    expect(classifyLanding(9.01, 3, false)).toBe('fatal');
    expect(classifyLanding(9.01, 3, true)).toBe('fatal');
    expect(classifyLanding(9.01, 20, false)).toBe('fatal');
  });

  it('keeps the PLF window at four tenths of a second', () => {
    expect(PLF_WINDOW_S).toBe(0.4);
  });
});
