import { describe, it, expect, afterEach } from 'vitest';
import { axisToInput, requestTiltPermission, tiltAxes, TiltSource } from '@/ui/input/tilt';
import type { TiltReading } from '@/ui/input/tilt';

/** The attitude the jumper holds the phone in when the jump starts. */
const NEUTRAL: TiltReading = { beta: 45, gamma: 0 };

/**
 * The reading a physical tilt produces in portrait, from the mapping table:
 * 0 degrees gives pitch = −Δbeta, roll = +Δgamma.
 */
function portrait(pitch: number, roll: number): TiltReading {
  return { beta: NEUTRAL.beta - pitch, gamma: NEUTRAL.gamma + roll };
}

/** The same physical tilt with the screen at 90 degrees: pitch = +Δgamma, roll = +Δbeta. */
function landscape90(pitch: number, roll: number): TiltReading {
  return { beta: NEUTRAL.beta + roll, gamma: NEUTRAL.gamma + pitch };
}

/** The same physical tilt with the screen at 270 degrees: pitch = −Δgamma, roll = −Δbeta. */
function landscape270(pitch: number, roll: number): TiltReading {
  return { beta: NEUTRAL.beta - roll, gamma: NEUTRAL.gamma - pitch };
}

/** A device orientation event with a time stamp we control. */
function orientationEvent(reading: TiltReading, tMs: number): Event {
  const event = new Event('deviceorientation');
  Object.defineProperties(event, {
    beta: { value: reading.beta },
    gamma: { value: reading.gamma },
    timeStamp: { value: tMs },
  });
  return event;
}

const originalDeviceOrientation = globalThis.DeviceOrientationEvent;

afterEach(() => {
  globalThis.DeviceOrientationEvent = originalDeviceOrientation;
});

describe('axisToInput', () => {
  it('asks for nothing inside the dead zone', () => {
    expect(axisToInput(0)).toBe(0);
    expect(axisToInput(2.9)).toBe(0);
    expect(axisToInput(-2.9)).toBe(0);
  });

  it('asks for everything at and beyond the full deflection', () => {
    expect(axisToInput(25)).toBe(1);
    expect(axisToInput(26)).toBe(1);
    expect(axisToInput(90)).toBe(1);
    expect(axisToInput(-25)).toBe(-1);
    expect(axisToInput(-90)).toBe(-1);
  });

  it('is odd: the other way is the same amount the other way', () => {
    for (const deg of [3.5, 4, 7, 10, 14, 18, 22, 25]) {
      expect(axisToInput(-deg)).toBeCloseTo(-axisToInput(deg), 12);
    }
  });

  it('is monotonic in the tilt', () => {
    let previous = -1;
    for (let deg = 0; deg <= 40; deg += 0.25) {
      const value = axisToInput(deg);
      expect(value).toBeGreaterThanOrEqual(previous);
      expect(value).toBeLessThanOrEqual(1);
      previous = value;
    }
  });

  it('takes a dead zone and a full deflection of its own', () => {
    expect(axisToInput(10, 5, 20)).toBeCloseTo(0.3333333333, 9);
    expect(axisToInput(20, 5, 20)).toBe(1);
    expect(axisToInput(5, 5, 20)).toBe(0);
  });
});

describe('tiltAxes', () => {
  it('gives the same pitch and roll for the same physical tilt in any orientation', () => {
    const p = tiltAxes(portrait(20, 10), NEUTRAL, 0);
    const l90 = tiltAxes(landscape90(20, 10), NEUTRAL, 90);
    const l270 = tiltAxes(landscape270(20, 10), NEUTRAL, 270);

    expect(p.pitch).toBeCloseTo(20, 9);
    expect(p.roll).toBeCloseTo(10, 9);
    expect(l90.pitch).toBeCloseTo(20, 9);
    expect(l90.roll).toBeCloseTo(10, 9);
    expect(l270.pitch).toBeCloseTo(20, 9);
    expect(l270.roll).toBeCloseTo(10, 9);
  });

  it('is zero at the neutral attitude', () => {
    const axes = tiltAxes({ beta: 45, gamma: 0 }, NEUTRAL, 0);
    expect(axes.pitch).toBeCloseTo(0, 12);
    expect(axes.roll).toBeCloseTo(0, 12);
  });

  it('reads a tilt the other way as the other way', () => {
    const axes = tiltAxes(portrait(-15, -8), NEUTRAL, 0);
    expect(axes.pitch).toBeCloseTo(-15, 9);
    expect(axes.roll).toBeCloseTo(-8, 9);
  });

  it('wraps the beta difference over the pole', () => {
    const axes = tiltAxes({ beta: 179, gamma: 0 }, { beta: -179, gamma: 0 }, 0);
    expect(axes.pitch).toBeCloseTo(2, 9);
  });

  it('clips the axes at ninety degrees', () => {
    // The top edge toward the user is a backward tilt, so the pitch is negative.
    const axes = tiltAxes({ beta: 135, gamma: 0 }, NEUTRAL, 0);
    expect(axes.pitch).toBeCloseTo(-90, 9);
    expect(axes.roll).toBeCloseTo(0, 9);
  });
});

describe('requestTiltPermission', () => {
  it('is unavailable without a device orientation event', async () => {
    globalThis.DeviceOrientationEvent = undefined as unknown as typeof DeviceOrientationEvent;
    await expect(requestTiltPermission()).resolves.toBe('unavailable');
  });

  it('is granted when the browser does not ask', async () => {
    globalThis.DeviceOrientationEvent = class {} as unknown as typeof DeviceOrientationEvent;
    await expect(requestTiltPermission()).resolves.toBe('granted');
  });

  it('follows what the browser answers', async () => {
    globalThis.DeviceOrientationEvent = {
      requestPermission: (): Promise<string> => Promise.resolve('granted'),
    } as unknown as typeof DeviceOrientationEvent;
    await expect(requestTiltPermission()).resolves.toBe('granted');

    globalThis.DeviceOrientationEvent = {
      requestPermission: (): Promise<string> => Promise.resolve('denied'),
    } as unknown as typeof DeviceOrientationEvent;
    await expect(requestTiltPermission()).resolves.toBe('denied');
  });

  it('is denied when the browser throws', async () => {
    globalThis.DeviceOrientationEvent = {
      requestPermission: (): Promise<string> => Promise.reject(new Error('no gesture')),
    } as unknown as typeof DeviceOrientationEvent;
    await expect(requestTiltPermission()).resolves.toBe('denied');
  });
});

describe('TiltSource', () => {
  it('has no axes and no roll rate before the first reading', () => {
    const source = new TiltSource(window);
    expect(source.axes()).toBeNull();
    expect(source.rollRateDegS()).toBe(0);
    source.dispose();
  });

  it('takes the next reading as the neutral attitude when there is none yet', () => {
    const source = new TiltSource(window);
    source.start();
    source.calibrate();

    window.dispatchEvent(orientationEvent({ beta: 30, gamma: 0 }, 1000));
    const neutral = source.axes();
    expect(neutral?.pitch).toBeCloseTo(0, 9);
    expect(neutral?.roll).toBeCloseTo(0, 9);

    window.dispatchEvent(orientationEvent({ beta: 20, gamma: 5 }, 1100));
    const tilted = source.axes();
    expect(tilted?.pitch).toBeCloseTo(10, 9);
    expect(tilted?.roll).toBeCloseTo(5, 9);

    source.dispose();
  });

  it('measures the roll rate between the last two readings', () => {
    const source = new TiltSource(window);
    source.start();
    source.calibrate();

    window.dispatchEvent(orientationEvent({ beta: 45, gamma: 0 }, 1000));
    expect(source.rollRateDegS()).toBe(0);

    window.dispatchEvent(orientationEvent({ beta: 45, gamma: 18 }, 1100));
    expect(source.rollRateDegS()).toBeCloseTo(180, 6);

    source.dispose();
  });

  it('hears nothing after it is disposed', () => {
    const source = new TiltSource(window);
    source.start();
    source.calibrate();
    window.dispatchEvent(orientationEvent({ beta: 45, gamma: 0 }, 1000));
    source.dispose();

    window.dispatchEvent(orientationEvent({ beta: 0, gamma: 0 }, 1100));
    expect(source.axes()?.pitch).toBeCloseTo(0, 9);
    expect(source.rollRateDegS()).toBe(0);
  });
});
