/**
 * The debrief screen: the account of the jump at the end of it.
 */

import { describe, expect, it } from 'vitest';
import { DebriefScreen } from '@/ui/DebriefScreen';
import type { DebriefData } from '@/sim/debrief';
import { FT } from '@/sim/units';

/** A jump that landed on its feet, thirty-four metres from the target. */
function makeData(overrides: Partial<DebriefData> = {}): DebriefData {
  return {
    exitAltitudeAglM: 13500 * FT,
    freefallTimeS: 57.4,
    deploymentAltitudeAglM: 3500 * FT,
    maxVerticalMs: 55.2,
    avgVerticalMs: 52.8,
    maxOpeningG: 3.4,
    canopyTimeS: 121.5,
    patternTurns: [],
    landing: {
      outcome: 'stand-up',
      verticalMs: 1.2,
      groundSpeedMs: 6.4,
      distanceFromTargetM: 34,
      bearingFromTargetDeg: 90,
      windMs: 4.1,
      windFromDeg: 270,
    },
    flags: [],
    ...overrides,
  };
}

/** Shows a debrief on a fresh screen and hands back its text. */
function show(
  units: 'ft' | 'm',
  data: DebriefData = makeData(),
): { root: HTMLElement; text: string; screen: DebriefScreen } {
  const root = document.createElement('div');
  document.body.appendChild(root);
  const screen = new DebriefScreen(root, units);
  screen.show(data, { dzName: 'Interlaken', canopyName: 'Sport 210', lzRadiusM: 100 });
  return { root, text: root.textContent ?? '', screen };
}

describe('the debrief screen', () => {
  it('tells the outcome in plain words', () => {
    const { text } = show('m');

    expect(text).toContain('Stand-up landing, 34 m from the target.');
  });

  it('tells a bad landing in plain words', () => {
    const data = makeData({
      landing: {
        outcome: 'sprain',
        verticalMs: 3.1,
        groundSpeedMs: 4,
        distanceFromTargetM: 12,
        bearingFromTargetDeg: 0,
        windMs: 3,
        windFromDeg: 270,
      },
    });
    const { text } = show('m', data);

    expect(text).toContain('Sprained ankle');
    expect(text).toContain('PLF');
  });

  it('says the low turn in plain words', () => {
    const { text } = show('m', makeData({ flags: ['low-turn'] }));

    expect(text.toLowerCase()).toContain('low turn');
  });

  it('says every flag in a sentence of its own', () => {
    const flags: DebriefData['flags'] = [
      'low-turn',
      'late-pull',
      'no-pull',
      'downwind-landing',
      'hard-opening',
      'aad-fire',
      'impact',
    ];
    const { root, text } = show('m', makeData({ flags }));

    const list = root.querySelector('[data-role="flags"]');
    expect(list?.querySelectorAll('li').length).toBe(flags.length);

    const said = text.toLowerCase();
    expect(said).toContain('low turn');
    expect(said).toContain('late pull');
    expect(said).toContain('never pulled');
    expect(said).toContain('downwind');
    expect(said).toContain('hard opening');
    expect(said).toContain('aad');
    expect(said).toContain('without a canopy');
  });

  it('shows metres in a metre drop zone and feet in a feet one', () => {
    const metres = show('m');
    const feet = show('ft');

    // The exit height and the distance from the target.
    expect(metres.text).toContain('4,110 m');
    expect(metres.text).toContain('34 m');
    expect(feet.text).toContain('13,500 ft');
    expect(feet.text).toContain('112 ft');
  });

  it('shows the numbers of the jump', () => {
    const { text } = show('m');

    expect(text).toContain('Exit');
    expect(text).toContain('Freefall');
    expect(text).toContain('Deployment');
    expect(text).toContain('Max vertical speed');
    expect(text).toContain('Average vertical speed');
    expect(text).toContain('Opening');
    expect(text).toContain('Canopy time');
    expect(text).toContain('Touchdown');
    expect(text).toContain('Wind');
  });

  it('lists the turns of the pattern with their heights', () => {
    const data = makeData({
      patternTurns: [{ startAglM: 1000 * FT, endAglM: 850 * FT, headingChangeDeg: 92 }],
    });
    const { text } = show('m', data);

    expect(text).toContain('92');
    // A turn at 1,000 ft is 305 m, which the display rounds to 300 m.
    expect(text).toContain('300 m');
  });

  it('draws the altitude against the time and the track from above', () => {
    const { root } = show('m');

    const profile = root.querySelector('[data-role="profile"]');
    const track = root.querySelector('[data-role="track"]');
    expect(profile).not.toBeNull();
    expect(track).not.toBeNull();
    expect((profile as HTMLCanvasElement).tagName).toBe('CANVAS');
    expect((track as HTMLCanvasElement).tagName).toBe('CANVAS');
  });

  it('calls back when the jumper asks for another jump', () => {
    const { root, screen } = show('m');
    let asked = 0;
    screen.onAgain = () => {
      asked += 1;
    };

    const button = root.querySelector('[data-action="jump-again"]');
    expect(button).not.toBeNull();
    (button as HTMLButtonElement).click();

    expect(asked).toBe(1);
  });

  it('can be put away again', () => {
    const { root, screen } = show('m');
    expect(root.querySelector('[data-role="debrief"]')).not.toBeNull();

    screen.dispose();

    expect(root.querySelector('[data-role="debrief"]')).toBeNull();
  });
});
