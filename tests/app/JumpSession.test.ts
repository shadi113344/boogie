/**
 * The jump session: the whole jump, from the exit to the debrief.
 */

import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { JumpSession, type JumpHost } from '@/app/JumpSession';
import { findDropZone } from '@/data/dropzones';
import { computeDebrief } from '@/sim/debrief';
import { DEFAULT_JUMPER } from '@/sim/jumper';
import type { Jump } from '@/sim/Jump';
import { FT } from '@/sim/units';
import { WIND_PRESETS } from '@/sim/wind';

/** Interlaken: the landing area is 568 m above mean sea level. */
const GROUND_M = 568;

/** The exit is 13,500 ft above the landing area. */
const EXIT_FT = 13500;

/** The pull is thrown from this height above the landing area, in feet. */
const PULL_FROM_FT = 3500;

/** The most frames a test will fly before it gives up. */
const MAX_FRAMES = 60 * 120;

/** The most frames of the whole jump, which is a long one. */
const MAX_JUMP_FRAMES = 60 * 400;

/** The height the flare starts at, in feet above the ground. */
const FLARE_FT = 12;

/** The height the PLF is offered below, in feet above the ground. */
const PLF_FT = 30;

/**
 * How far off the heading of the wind the canopy may be before the jumper
 * turns it, in radians.
 */
const TURN_EPS_RAD = 0.09;

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
    scene: new THREE.Scene(),
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

/** Presses a key of the keyboard of the window. */
function press(code: string): void {
  window.dispatchEvent(new KeyboardEvent('keydown', { code }));
}

/** Lets a key of the keyboard of the window go. */
function release(code: string): void {
  window.dispatchEvent(new KeyboardEvent('keyup', { code }));
}

/**
 * Turns the canopy into the wind, with the keys.
 *
 * The canopy is told with the same two keys a jumper uses: the right one
 * turns it to the right, the left one to the left, and the jumper lets go
 * when the canopy is pointing at the wind.
 *
 * @param jump the jump being flown
 */
function steerIntoWind(jump: Jump): void {
  const wanted = (jump.wind.fromDegAt(0) * Math.PI) / 180;
  let error = wanted - jump.canopyHeadingRad();
  while (error > Math.PI) error -= 2 * Math.PI;
  while (error < -Math.PI) error += 2 * Math.PI;

  if (error > TURN_EPS_RAD) {
    press('KeyD');
    release('KeyA');
  } else if (error < -TURN_EPS_RAD) {
    press('KeyA');
    release('KeyD');
  } else {
    release('KeyA');
    release('KeyD');
  }
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
        press('KeyP');
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

  it('keeps flying after the pull, and puts the canopy over the jumper', () => {
    const host = makeHost();
    const session = makeSession(host);
    const jump = session.jump;

    let frames = 0;
    let thrown = false;
    while (jump.phase !== 'canopy' && frames < MAX_FRAMES) {
      if (!thrown && jump.altitudeAglM() / FT <= PULL_FROM_FT) {
        thrown = true;
        press('KeyP');
      }
      session.frame(1 / 60);
      frames += 1;
    }

    // The jump did not stop at the throw: the canopy is flying.
    expect(jump.phase).toBe('canopy');
    expect(jump.events.some((event) => event.type === 'open')).toBe(true);

    // The canopy is in the scene, over the jumper's head.
    const canopy = host.scene.getObjectByName('canopy');
    expect(canopy).toBeTruthy();
    expect(canopy?.parent).toBe(host.scene);

    session.dispose();
  });

  it('hides the freefall controls at the throw and shows the canopy ones', () => {
    const host = makeHost();
    const session = makeSession(host);
    const jump = session.jump;

    expect(host.uiRoot.querySelector('.ff-controls')?.hasAttribute('hidden')).toBe(false);

    let frames = 0;
    let thrown = false;
    while (jump.phase !== 'canopy' && frames < MAX_FRAMES) {
      if (!thrown && jump.altitudeAglM() / FT <= PULL_FROM_FT) {
        thrown = true;
        press('KeyP');
      }
      session.frame(1 / 60);
      frames += 1;
    }

    expect(host.uiRoot.querySelector('.ff-controls')?.hasAttribute('hidden')).toBe(true);
    expect(host.uiRoot.querySelector('.cn-controls')?.hasAttribute('hidden')).toBe(false);

    session.dispose();
  });

  it('offers the parachute landing fall in the last thirty feet', () => {
    const host = makeHost();
    const session = makeSession(host);
    const jump = session.jump;

    let frames = 0;
    let thrown = false;
    while (jump.phase !== 'canopy' && frames < MAX_FRAMES) {
      if (!thrown && jump.altitudeAglM() / FT <= PULL_FROM_FT) {
        thrown = true;
        press('KeyP');
      }
      session.frame(0.1);
      frames += 1;
    }

    // High up, the roll cannot help and the pill is away.
    let plf = host.uiRoot.querySelector('[data-action="plf"]');
    expect(plf?.hasAttribute('hidden')).toBe(true);

    // The jumper comes down to the last thirty feet.
    while (jump.phase === 'canopy' && jump.heightAboveGround() > PLF_FT * FT) {
      session.frame(0.1);
      frames += 1;
    }
    session.frame(0.1);

    plf = host.uiRoot.querySelector('[data-action="plf"]');
    expect(plf?.hasAttribute('hidden')).toBe(false);

    session.dispose();
  });

  it('flies the whole jump and shows the debrief at the end', () => {
    const host = makeHost();
    const session = makeSession(host);
    const jump = session.jump;

    let frames = 0;
    let thrown = false;
    let unstowed = false;
    let flaring = false;
    while (jump.phase !== 'landed' && frames < MAX_JUMP_FRAMES) {
      // The throw, at the height of the plan.
      if (!thrown && jump.altitudeAglM() / FT <= PULL_FROM_FT) {
        thrown = true;
        press('KeyP');
      }
      // The brakes come unstowed when the canopy is flying.
      if (jump.phase === 'canopy' && !unstowed) {
        unstowed = true;
        press('KeyU');
      }
      // The pattern: the canopy is turned into the wind.
      if (jump.phase === 'canopy' && !flaring) steerIntoWind(jump);
      // The flare: the brakes go on at the bottom, and come up when the
      // canopy stops sinking.
      if (
        jump.phase === 'canopy' &&
        !flaring &&
        jump.heightAboveGround() <= FLARE_FT * FT
      ) {
        flaring = true;
        press('KeyS');
        release('KeyA');
        release('KeyD');
      }
      if (flaring && jump.velocity().y >= 0) {
        release('KeyS');
        flaring = false;
      }
      session.frame(0.1);
      frames += 1;
    }

    // The jumper is on the ground, and the landing was not a hurt one.
    expect(jump.phase).toBe('landed');
    expect(jump.touchdown).not.toBeNull();
    expect(jump.touchdown?.outcome).not.toBe('injury');
    expect(jump.touchdown?.outcome).not.toBe('fatal');
    // The canopy was turned into the wind, so the jumper is near the
    // landing area and not a kilometre downwind of it.
    expect(Math.hypot(jump.touchdown?.pos.x ?? 99, jump.touchdown?.pos.z ?? 99)).toBeLessThan(
      1500,
    );

    // The debrief is on the screen, and it is the debrief of this jump.
    const debrief = host.uiRoot.querySelector('[data-role="debrief"]');
    expect(debrief).not.toBeNull();
    expect(debrief?.hasAttribute('hidden')).toBe(false);
    expect(session.debrief).toEqual(computeDebrief(jump));
    expect(host.uiRoot.querySelector('[data-role="debrief-title"]')?.textContent).toBe(
      'Interlaken',
    );
    expect(host.uiRoot.querySelector('[data-role="debrief-subtitle"]')?.textContent).toBe(
      'Sport 210',
    );

    const text = debrief?.textContent ?? '';
    expect(text).toContain('Exit');
    expect(text).toContain('Deployment');
    expect(text).toContain('Canopy time');
    expect(text).toContain('Touchdown');
    // The exit height of the jump, in the units of the drop zone.
    expect(text).toContain('4,110 m');
    expect((host.uiRoot.querySelector('[data-role="outcome"]')?.textContent ?? '').length).toBeGreaterThan(
      0,
    );

    // The controls are away, and the jump again button is there.
    expect(host.uiRoot.querySelector('.cn-controls')?.hasAttribute('hidden')).toBe(true);
    expect(host.uiRoot.querySelector('[data-action="jump-again"]')).not.toBeNull();

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
