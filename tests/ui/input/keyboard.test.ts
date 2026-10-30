import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { KeyboardSource } from '@/ui/input/keyboard';

/** A key going down, or coming back up. */
function key(code: string, type: 'keydown' | 'keyup' = 'keydown'): void {
  window.dispatchEvent(new KeyboardEvent(type, { code }));
}

describe('KeyboardSource', () => {
  let source: KeyboardSource;

  beforeEach(() => {
    source = new KeyboardSource(window);
  });

  afterEach(() => {
    source.dispose();
  });

  it('turns right with the right arrow', () => {
    key('ArrowRight');
    expect(source.sample(1 / 60).freefall.turn).toBe(1);
  });

  it('turns left with A', () => {
    key('KeyA');
    const sample = source.sample(1 / 60);
    expect(sample.freefall.turn).toBe(-1);
  });

  it('stops turning when the key comes back up', () => {
    key('ArrowRight');
    expect(source.sample(1 / 60).freefall.turn).toBe(1);
    key('ArrowRight', 'keyup');
    expect(source.sample(1 / 60).freefall.turn).toBe(0);
  });

  it('drives forward with W and back with S', () => {
    key('KeyW');
    expect(source.sample(1 / 60).freefall.drive).toBe(1);
    key('KeyW', 'keyup');
    key('KeyS');
    expect(source.sample(1 / 60).freefall.drive).toBe(-1);
  });

  it('arches with R and de-arches with F', () => {
    key('KeyR');
    expect(source.sample(1 / 60).freefall.fallRate).toBe(1);
    key('KeyR', 'keyup');
    key('KeyF');
    expect(source.sample(1 / 60).freefall.fallRate).toBe(-1);
  });

  it('reports the pull on one sample only', () => {
    key('KeyP');
    expect(source.sample(1 / 60).pull).toBe(true);
    expect(source.sample(1 / 60).pull).toBe(false);
  });

  it('ignores a repeated key', () => {
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyP', repeat: true }));
    expect(source.sample(1 / 60).pull).toBe(false);
  });

  it('toggles the track', () => {
    expect(source.sample(0).freefall.track).toBe(false);
    key('KeyT');
    expect(source.sample(0).freefall.track).toBe(true);
    key('KeyT');
    expect(source.sample(0).freefall.track).toBe(false);
  });

  it('ramps the left toggle to half in 0.3 s', () => {
    key('KeyA');
    expect(source.sample(0.3).canopy.left).toBeCloseTo(0.5, 2);
  });

  it('ramps the left toggle to full in 0.6 s and back in 0.3 s', () => {
    key('KeyA');
    expect(source.sample(0.6).canopy.left).toBeCloseTo(1, 6);
    key('KeyA', 'keyup');
    expect(source.sample(0.3).canopy.left).toBeCloseTo(0, 6);
  });

  it('pulls both toggles with S', () => {
    key('KeyS');
    const sample = source.sample(0.6);
    expect(sample.canopy.left).toBeCloseTo(1, 6);
    expect(sample.canopy.right).toBeCloseTo(1, 6);
  });

  it('pulls the front and rear risers', () => {
    key('KeyQ');
    key('KeyE');
    key('KeyW');
    const sample = source.sample(1 / 60);
    expect(sample.canopy.frontLeft).toBe(1);
    expect(sample.canopy.frontRight).toBe(1);
    expect(sample.canopy.rear).toBe(1);
  });

  it('reports the unstow on one sample only', () => {
    key('KeyU');
    expect(source.sample(1 / 60).canopy.unstow).toBe(true);
    expect(source.sample(1 / 60).canopy.unstow).toBe(false);
  });

  it('reports the PLF on one sample only', () => {
    key('Space');
    expect(source.sample(1 / 60).plf).toBe(true);
    expect(source.sample(1 / 60).plf).toBe(false);
  });

  it('looks up while L is held', () => {
    key('KeyL');
    expect(source.sample(1 / 60).lookUp).toBe(1);
    key('KeyL', 'keyup');
    expect(source.sample(1 / 60).lookUp).toBe(0);
  });

  it('hears nothing after it is disposed', () => {
    source.dispose();
    key('ArrowRight');
    expect(source.sample(1 / 60).freefall.turn).toBe(0);
  });
});
