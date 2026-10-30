import { describe, expect, it } from 'vitest';
import { isaDensity } from '@/sim/atmosphere';
import { BELLY } from '@/sim/freefall/aero';
import {
  ATTITUDE,
  type FreefallEnv,
  type FreefallState,
  airDirection,
  bodyFrame,
  createFreefallState,
  stepFreefall,
} from '@/sim/freefall/freefall';
import type { FreefallInput } from '@/sim/inputs';
import { DEFAULT_JUMPER, exitMassKg } from '@/sim/jumper';
import { Rng } from '@/sim/rng';
import { FT, G, KT, MPH } from '@/sim/units';
import { type Vec3, dot, normalize } from '@/sim/vec3';

/** Interlaken: the landing area is 568 m above mean sea level. */
const GROUND_M = 568;

/** The exit is 4,115 m above the landing area. */
const EXIT_MSL_M = GROUND_M + 4115;

/** The step of the simulation. */
const DT = 1 / 120;

/** The speed of the aircraft at the exit: 95 knots true. */
const EXIT_SPEED_MS = 95 * KT;

/** The input of a jumper who is not touching anything. */
const NEUTRAL: FreefallInput = { turn: 0, drive: 0, fallRate: 0, track: false };

/** The world up and the world down. */
const DOWN: Vec3 = { x: 0, y: -1, z: 0 };

/** North. */
const NORTH: Vec3 = { x: 0, y: 0, z: -1 };

/** The air of a drop zone, still unless it is told otherwise. */
function makeEnv(o: { constantDensity?: number } = {}): FreefallEnv {
  const density = o.constantDensity;
  return {
    rho: density === undefined ? (y: number) => isaDensity(y) : () => density,
    wind: () => ({ x: 0, y: 0, z: 0 }),
    jumper: DEFAULT_JUMPER,
  };
}

/** The speed a belly box falls at in air of a given density, in m/s. */
function bellyTerminal(rho: number): number {
  return Math.sqrt((2 * exitMassKg(DEFAULT_JUMPER) * G) / (rho * BELLY.cdaNeutral));
}

/** The heading of a direction, in degrees clockwise from north. */
function headingDeg(v: Vec3): number {
  const h = normalize({ x: v.x, y: 0, z: v.z });
  return (Math.atan2(h.x, -h.z) * 180) / Math.PI;
}

/** The angle between two directions, in degrees. */
function angleDeg(a: Vec3, b: Vec3): number {
  const c = Math.max(-1, Math.min(1, dot(normalize(a), normalize(b))));
  return (Math.acos(c) * 180) / Math.PI;
}

/** The state of a jumper falling straight down at terminal speed. */
function atTerminal(rho = 1.225): FreefallState {
  return createFreefallState({
    pos: { x: 0, y: 4000, z: 0 },
    vel: { x: 0, y: -bellyTerminal(rho), z: 0 },
    wind: { x: 0, y: 0, z: 0 },
  });
}

/** The exit of the jump: 95 knots true northward, head up. */
function atExit(): FreefallState {
  return createFreefallState({
    pos: { x: 0, y: EXIT_MSL_M, z: 0 },
    vel: { x: 0, y: 0, z: -EXIT_SPEED_MS },
    wind: { x: 0, y: 0, z: 0 },
    headUp: true,
  });
}

/** Flies the jumper on for a number of seconds. */
function fly(
  s: FreefallState,
  e: FreefallEnv,
  input: FreefallInput,
  seconds: number,
  rng: Rng,
): void {
  const steps = Math.round(seconds / DT);
  for (let i = 0; i < steps; i++) stepFreefall(s, input, e, DT, rng);
}

/**
 * How long the body takes to twist the heading of the head through a full
 * turn, and how far it gets in eight seconds.
 */
function turnTime(turn: number): { t360: number; total: number } {
  const e = makeEnv({ constantDensity: 1.225 });
  const s = atTerminal();
  const rng = new Rng(1);
  let t = 0;
  let accumulated = 0;
  let t360 = -1;
  let last = headingDeg(bodyFrame(s).forward);
  while (t < 8) {
    stepFreefall(s, { ...NEUTRAL, turn }, e, DT, rng);
    t += DT;
    const now = headingDeg(bodyFrame(s).forward);
    let delta = now - last;
    if (delta > 180) delta -= 360;
    if (delta < -180) delta += 360;
    accumulated += delta;
    last = now;
    if (t360 < 0 && Math.abs(accumulated) >= 360) t360 = t;
  }
  return { t360, total: accumulated };
}

describe('the hill', () => {
  it('reaches 95 percent of the local terminal speed in about thirteen seconds', () => {
    const e = makeEnv();
    const s = atExit();
    const rng = new Rng(1);
    let t = 0;
    let t95 = -1;
    let t1000ft = -1;
    const exitY = s.pos.y;
    while (t < 20) {
      stepFreefall(s, NEUTRAL, e, DT, rng);
      t += DT;
      // The terminal speed of the air the jumper is in right now.
      const local = bellyTerminal(e.rho(s.pos.y));
      if (t95 < 0 && -s.vel.y >= 0.95 * local) t95 = t;
      if (t1000ft < 0 && exitY - s.pos.y >= 1000 * FT) t1000ft = t;
    }
    expect(t95).toBeGreaterThan(11);
    expect(t95).toBeLessThan(14.5);
    expect(t1000ft).toBeGreaterThan(8.5);
    expect(t1000ft).toBeLessThan(10.5);
  });

  it('presents the belly to the wind and the head to the jump run', () => {
    const e = makeEnv();
    const s = atExit();
    const rng = new Rng(1);
    const exitY = s.pos.y;
    fly(s, e, NEUTRAL, 12, rng);
    const body = bodyFrame(s);
    // The belly normal is the way the chest faces, and it points down.
    expect(angleDeg({ x: -body.up.x, y: -body.up.y, z: -body.up.z }, DOWN)).toBeLessThan(15);
    expect(angleDeg(body.forward, NORTH)).toBeLessThan(30);
    const horizontal = Math.hypot(s.pos.x, s.pos.z);
    expect(horizontal).toBeGreaterThan(300);
    expect(horizontal).toBeLessThan(500);
    expect(exitY - s.pos.y).toBeGreaterThan(300);
  });
});

describe('at terminal', () => {
  it('falls a thousand feet in about five and a half seconds', () => {
    const e = makeEnv({ constantDensity: 1.225 });
    const s = atTerminal();
    const rng = new Rng(1);
    const startY = s.pos.y;
    let t = 0;
    while (s.pos.y > startY - 1000 * FT) {
      stepFreefall(s, NEUTRAL, e, DT, rng);
      t += DT;
    }
    expect(t).toBeGreaterThan(5.4);
    expect(t).toBeLessThan(6.0);
  });
});

describe('turns', () => {
  it('turns the head through a full circle in about two seconds at full input', () => {
    const { t360 } = turnTime(1);
    expect(t360).toBeGreaterThan(1.5);
    expect(t360).toBeLessThan(2.0);
  });

  it('takes three to four seconds at half input', () => {
    const { t360 } = turnTime(0.5);
    expect(t360).toBeGreaterThan(3.0);
    expect(t360).toBeLessThan(4.0);
  });

  it('turns left when the input is left', () => {
    const { total } = turnTime(-1);
    expect(total).toBeLessThan(-360);
  });
});

describe('drive', () => {
  it('moves the jumper along the head at full forward drive', () => {
    const e = makeEnv({ constantDensity: 1.225 });
    const s = atTerminal();
    const rng = new Rng(1);
    fly(s, e, { ...NEUTRAL, drive: 1 }, 12, rng);
    const head = normalize({
      x: bodyFrame(s).forward.x,
      y: 0,
      z: bodyFrame(s).forward.z,
    });
    const alongHead = s.vel.x * head.x + s.vel.z * head.z;
    const acrossHead = s.vel.x * -head.z + s.vel.z * head.x;
    expect(alongHead).toBeGreaterThan(3);
    expect(Math.abs(acrossHead)).toBeLessThan(0.5);
    // The belly box with the head down glides at about a tenth of its speed.
    expect(alongHead / -s.vel.y).toBeGreaterThan(0.08);
    expect(alongHead / -s.vel.y).toBeLessThan(0.13);
  });
});

describe('the track', () => {
  it('turns the fall into a glide', () => {
    const e = makeEnv();
    const s = atExit();
    const rng = new Rng(1);
    fly(s, e, { ...NEUTRAL, track: true }, 6, rng);
    expect(Math.hypot(s.vel.x, s.vel.z)).toBeGreaterThan(25);
    expect(-s.vel.y).toBeLessThan(51);
  });

  it('flies like the jumpsuit track of the table once it has settled', () => {
    const e = makeEnv({ constantDensity: 1.225 });
    const s = atTerminal();
    const rng = new Rng(1);
    fly(s, e, { ...NEUTRAL, track: true }, 25, rng);
    const horizontal = Math.hypot(s.vel.x, s.vel.z);
    const vertical = -s.vel.y;
    expect(vertical / MPH).toBeGreaterThan(90);
    expect(vertical / MPH).toBeLessThan(115.5);
    expect(horizontal / MPH).toBeGreaterThan(52);
    expect(horizontal / MPH).toBeLessThan(73.5);
    expect(horizontal / vertical).toBeGreaterThan(0.57);
    expect(horizontal / vertical).toBeLessThan(0.74);
  });

  it('turns in the track by banking, without twisting the body', () => {
    const e = makeEnv({ constantDensity: 1.225 });
    const s = atTerminal();
    const rng = new Rng(1);
    fly(s, e, { ...NEUTRAL, track: true }, 6, rng);
    const headingBefore = headingDeg(s.vel);
    fly(s, e, { ...NEUTRAL, track: true, turn: 1 }, 4, rng);
    const headingAfter = headingDeg(s.vel);
    let turned = headingAfter - headingBefore;
    if (turned < -180) turned += 360;
    if (turned > 180) turned -= 360;
    expect(turned).toBeGreaterThan(10);
    expect(turned).toBeLessThan(90);
    // The body is not twisted: the track turns by the bank.
    expect(Math.abs(s.yawRate)).toBeLessThan(0.01);
    expect(s.bank).toBeGreaterThan(ATTITUDE.bellyTurnBankDeg * (Math.PI / 180));
  });
});

describe('the tumble', () => {
  it('starts when the exit is too steep and stops when the jumper arches', () => {
    const e = makeEnv({ constantDensity: 1.225 });
    const s = createFreefallState({
      pos: { x: 0, y: 4000, z: 0 },
      vel: { x: 0, y: -bellyTerminal(1.225), z: 0 },
      wind: { x: 0, y: 0, z: 0 },
      bank: (80 * Math.PI) / 180,
    });
    expect(s.tumbling).toBe(true);
    const rng = new Rng(1);
    let t = 0;
    let recovered = -1;
    while (t < 5) {
      stepFreefall(s, { ...NEUTRAL, fallRate: 1 }, e, DT, rng);
      t += DT;
      if (recovered < 0 && !s.tumbling) recovered = t;
    }
    expect(recovered).toBeGreaterThan(0);
    expect(recovered).toBeLessThan(2.5);
  });

  it('goes on without an arch and falls faster than the belly box', () => {
    const e = makeEnv({ constantDensity: 1.225 });
    const s = createFreefallState({
      pos: { x: 0, y: 4000, z: 0 },
      vel: { x: 0, y: -bellyTerminal(1.225), z: 0 },
      wind: { x: 0, y: 0, z: 0 },
      bank: (80 * Math.PI) / 180,
    });
    const rng = new Rng(1);
    fly(s, e, NEUTRAL, 5, rng);
    expect(s.tumbling).toBe(true);
    expect(-s.vel.y).toBeGreaterThan(1.05 * bellyTerminal(1.225));
  });
});

describe('the air', () => {
  it('reports the direction the body moves through the air', () => {
    const e = makeEnv({ constantDensity: 1.225 });
    const s = atTerminal();
    const d = airDirection(s, e);
    expect(d.y).toBeCloseTo(-1, 9);
  });
});

describe('determinism', () => {
  it('flies the same jump twice with the same seed and the same inputs', () => {
    const e = makeEnv();
    const make = (): FreefallState =>
      createFreefallState({
        pos: { x: 0, y: EXIT_MSL_M, z: 0 },
        vel: { x: 0, y: 0, z: -EXIT_SPEED_MS },
        wind: { x: 0, y: 0, z: 0 },
        headUp: true,
        bank: (80 * Math.PI) / 180,
      });
    const a = make();
    const b = make();
    const rngA = new Rng(1);
    const rngB = new Rng(1);
    for (let i = 0; i < 60 * 120; i++) {
      const input: FreefallInput = {
        turn: Math.sin(i / 500),
        drive: Math.cos(i / 700),
        fallRate: 0,
        track: i > 1000 && i < 3000,
      };
      stepFreefall(a, input, e, DT, rngA);
      stepFreefall(b, input, e, DT, rngB);
    }
    expect(a.pos.x).toBeCloseTo(b.pos.x, 12);
    expect(a.pos.y).toBeCloseTo(b.pos.y, 12);
    expect(a.pos.z).toBeCloseTo(b.pos.z, 12);
    expect(a.vel.x).toBeCloseTo(b.vel.x, 12);
    expect(a.vel.y).toBeCloseTo(b.vel.y, 12);
    expect(a.vel.z).toBeCloseTo(b.vel.z, 12);
  });
});
