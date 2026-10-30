import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { JumpSession, type JumpHost } from '@/app/JumpSession';
import { findDropZone } from '@/data/dropzones';
import { DEFAULT_JUMPER } from '@/sim/jumper';
import { FT } from '@/sim/units';
import { WIND_PRESETS } from '@/sim/wind';

/** Interlaken: the landing area is 568 m above mean sea level. */
const GROUND_M = 568;

/** The exit is 13,500 ft above the landing area. */
const EXIT_FT = 13500;

/** The pull is thrown from this height above the landing area, in feet. */
const PULL_FROM_FT = 3600;

/** The most frames a test will fly before it gives up. */
const MAX_FRAMES = 60 * 120;

/**
 * The app the session flies in, without a renderer or a ground.
 *
 * The renderer and the terrain are not needed to fly a jump: the session
 * only asks the host where the ground is and where the world has been
 * rebased to.
 */
function makeHost(): JumpHost {
  const uiRoot = document.createElement('div');
  document.body.appendChild(uiRoot);

  return {
    camera: new THREE.PerspectiveCamera(60, 1, 1, 600000),
    overlay: {
      scene: new THREE.Scene(),
      camera: new THREE.PerspectiveCamera(60, 1, 0.01, 10),
    },
    originOffset: () => ({ x: 0, z: 0 }),
    groundY: () => GROUND_M,
    lzGroundY: GROUND_M,
    uiRoot,
    debug: false,
    window,
  };
}

/** A session over Interlaken, in the typical wind, with the touch controls. */
function makeSession(host: JumpHost): JumpSession {
  const dz = findDropZone('interlaken');
  if (!dz) throw new Error('the test needs Interlaken');
  return new JumpSession(host, {
    dz,
    jumper: DEFAULT_JUMPER,
    wind: WIND_PRESETS.typical,
    canopyId: 'sport-210',
    seed: 7,
    scheme: 'touch',
  });
}

describe('the jump session', () => {
  it('starts at the exit height above the landing area', () => {
    const session = makeSession(makeHost());

    expect(session.jump.altitudeAglM() / FT).toBeCloseTo(EXIT_FT, 0);
    expect(session.jump.phase).toBe('freefall');
  });

  it('reaches the pull between 3,450 and 3,600 ft above the landing area', () => {
    const host = makeHost();
    const session = makeSession(host);
    const jump = session.jump;

    let frames = 0;
    let thrown = false;
    while (jump.phase === 'freefall' && frames < MAX_FRAMES) {
      // The pull is thrown from the keyboard, when the jumper is at the
      // height the jumper would pull at.
      if (!thrown && jump.altitudeAglM() / FT <= PULL_FROM_FT) {
        thrown = true;
        window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyP' }));
      }
      session.frame(1 / 60);
      frames += 1;
    }

    const pull = jump.events.find((event) => event.type === 'pull');
    expect(pull).toBeDefined();
    const pullFt = (pull?.aglM ?? 0) / FT;
    expect(pullFt).toBeGreaterThan(3450);
    expect(pullFt).toBeLessThan(3600);

    session.dispose();
  });

  it('advances at most twelve steps in a frame that arrives late', () => {
    const session = makeSession(makeHost());

    const before = session.jump.inputLog.length;
    session.frame(1.0);
    const steps = session.jump.inputLog.length - before;

    expect(steps).toBeGreaterThan(0);
    expect(steps).toBeLessThanOrEqual(12);

    session.dispose();
  });

  it('freezes the simulation after the pull and shows the card', () => {
    const host = makeHost();
    const session = makeSession(host);
    const jump = session.jump;

    let frames = 0;
    let thrown = false;
    while (jump.phase === 'freefall' && frames < MAX_FRAMES) {
      if (!thrown && jump.altitudeAglM() / FT <= PULL_FROM_FT) {
        thrown = true;
        window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyP' }));
      }
      session.frame(1 / 60);
      frames += 1;
    }

    // The card is there, and it says where the pull was.
    const card = host.uiRoot.querySelector('[data-role="pull-card"]');
    expect(card).not.toBeNull();
    expect(card?.textContent ?? '').toContain('Pull at');

    // The simulation has stopped: a frame moves nothing.
    const before = jump.inputLog.length;
    session.frame(1 / 60);
    expect(jump.inputLog.length).toBe(before);

    session.dispose();
  });

  it('draws the watch on the overlay, in front of the eye', () => {
    const host = makeHost();
    const session = makeSession(host);

    session.frame(1 / 60);

    const watch = host.overlay.scene.getObjectByName('wrist-altimeter');
    expect(watch).toBeTruthy();
    // A third of a metre in front of the eye, inside the near plane.
    expect(watch?.position.z).toBeCloseTo(-0.3, 6);

    session.dispose();
  });
});
