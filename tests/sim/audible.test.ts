import { describe, expect, it } from 'vitest';
import { Audible, DEFAULT_AUDIBLE } from '@/sim/audible';

describe('the audible altimeter', () => {
  it('is set to the three beeps and the flatline of the plan', () => {
    expect(DEFAULT_AUDIBLE).toEqual({
      alarmsFt: [5500, 4000, 2000],
      flatlineFt: 1000,
    });
  });

  it('fires the three alarms once on the way down', () => {
    const audible = new Audible();
    const fired = [...audible.update(6000, true)];
    for (let ft = 5900; ft >= 1500; ft -= 100) fired.push(...audible.update(ft, true));

    expect(fired).toEqual(['alarm1', 'alarm2', 'alarm3']);
  });

  it('fires nothing on the way up', () => {
    const audible = new Audible();
    const fired = [...audible.update(1500, true)];
    for (let ft = 1600; ft <= 6500; ft += 100) fired.push(...audible.update(ft, true));

    expect(fired).toEqual([]);
  });

  it('fires each alarm only once in a jump', () => {
    const audible = new Audible();
    const fired = [...audible.update(6000, true)];
    for (let ft = 5900; ft >= 1500; ft -= 100) fired.push(...audible.update(ft, true));
    // The jumper climbs back up over the alarms and comes down again.
    for (let ft = 1600; ft <= 6000; ft += 100) fired.push(...audible.update(ft, true));
    for (let ft = 5900; ft >= 1500; ft -= 100) fired.push(...audible.update(ft, true));

    expect(fired).toEqual(['alarm1', 'alarm2', 'alarm3']);
  });

  it('sirens below the lowest beep and flatlines below a thousand feet', () => {
    const audible = new Audible();

    audible.update(3000, true);
    expect(audible.continuous).toBeNull();

    audible.update(1999, true);
    expect(audible.continuous).toBe('alarm3');

    audible.update(999, true);
    expect(audible.continuous).toBe('flatline');
  });

  it('is silent once the jumper is not in freefall', () => {
    const audible = new Audible();

    audible.update(999, true);
    expect(audible.continuous).toBe('flatline');

    audible.update(999, false);
    expect(audible.continuous).toBeNull();
  });

  it('takes the heights it is set to', () => {
    const audible = new Audible({ alarmsFt: [3000, 2000, 1000], flatlineFt: 500 });
    const fired = [...audible.update(3500, true)];
    for (let ft = 3400; ft >= 900; ft -= 100) fired.push(...audible.update(ft, true));

    expect(fired).toEqual(['alarm1', 'alarm2', 'alarm3']);
    expect(audible.continuous).toBe('alarm3');
  });
});
