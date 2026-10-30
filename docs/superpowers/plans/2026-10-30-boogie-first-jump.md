# Boogie Plan 2: The First Jump (milestones 3 and 4)

> **For agentic workers:** This plan is executed task by task with MiniMax as the implementer and Claude as briefer, reviewer and lander (spec section 4). Each task is one MiniMax run; Claude reviews the diff, runs the tests and lands it on `main`. Steps use checkbox (`- [ ]`) syntax for tracking. Steps marked **Orchestrator** are done by Claude, not the implementer.

**Goal:** A full belly jump at Interlaken on a phone, from the exit to the debrief: the hill, freefall with tilt or touch control, the wrist altimeter and the audible, the pull, a real opening, canopy flight with toggles and risers, a flare that decides the landing, and an honest debrief.

**Architecture:** A pure, deterministic simulation in `src/sim/` (no DOM, no three.js, seeded, fixed 120 Hz step, every input logged) owns the jumper: freefall as a body with an attitude relative to the relative wind, the opening as a timeline of drag areas, the canopy as a point mass with a quasi-steady polar, a dive state and a brake response, and the landing as a classification of the touchdown. `src/ui/` turns tilt, touch and keys into the sim's input; `src/render/` puts a first-person camera, a wrist altimeter and a procedural canopy on the world Plan 1 built; `src/audio/` makes the wind, the audible and the opening; `src/app/JumpSession.ts` runs one jump from the start screen to the debrief.

**Tech Stack:** As Plan 1: Vite, TypeScript strict, three.js, Vitest with happy-dom. Web Audio, DeviceOrientation and Pointer Events behind thin adapters. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-30-boogie-design.md`, sections 2, 3, 5 (steps 4 to 7), 7, 8, 9 (first-person, canopy, sound) and 11 (the debrief numbers).

## Global Constraints

- The simulation is a pure module, fixed timestep at 120 Hz, semi-implicit Euler, seeded pseudo-random numbers, no dependency on the renderer. Input is sampled into a log so a jump can be replayed exactly. `src/sim/` imports nothing from `three`, the DOM or `src/render/`, `src/ui/`, `src/app/`.
- Air density follows the International Standard Atmosphere from the drop zone's elevation and temperature. All aerodynamic forces are ½ ρ V² C A.
- Default jumper: 85 kg plus 12 kg of gear, body mass adjustable from 55 to 110 kg. Heavier jumpers fall faster and load their canopies more, and this falls out of the model, never a lookup.
- Freefall targets assert within ±5 percent; canopy full-flight and half-brake speed and sink within ±8 percent; canopy turn altitude losses within ±20 percent (spec section 7 tables).
- Altitudes in feet above the landing area: exit per drop zone (`exitAltitudeFt`, above ground); pull 3,500 by default (2,500 to 5,500); audible 5,500 / 4,000 / 2,000 (the last a continuous siren) and a flatline siren at 1,000 if still in freefall; the AAD fires the reserve at 750 ft when the vertical speed exceeds 78 mph; the pattern is downwind at 1,000, base at 600, final at 300; any turn of more than 90 degrees still in progress below 500 ft is a low turn.
- The altimeter reads height above the landing area (zero on the landing area, as jumpers set it), on the wrist, never as a floating number. Display units follow the drop zone: metres and km/h at Gryttjom, Interlaken and Empuriabrava, feet and mph elsewhere.
- No arcade layer of any kind: no rings, scores, boosts, auto-steer, timed button flares or pulls, no physics sped up or slowed to shorten a phase. The sim never runs faster than real time; when a frame is late it catches up at most 12 steps (100 ms) and lets the rest go.
- First person shows only real things: the wrist altimeter, the canopy, a goggle vignette, the control hints the player has not dismissed and the handles that apply. The debug overlay stays behind `?debug=1`.
- Tilt is the default control scheme in both phases, touch the alternative, chosen on the start screen; keyboard covers desktop. Audio starts on the Jump button tap (iOS rule). Phone-first, portrait.
- World frame as Plan 1: metres, x east, y up (metres above mean sea level), z south, north is −z. Headings are degrees or radians clockwise from north.

## Review Focus

1. **A frame that arrives late, or a tab that comes back from the background mid-jump.** The jump must continue where it was: at most 12 sim steps per frame, never a jump ahead, never a NaN. Owner: Task 1 (`FixedStep`) and Task 11 (the session resumes after `visibilitychange`).
2. **Tilt unavailable or refused** (desktop, iOS permission denied, a phone without a gyroscope). The start screen falls back to touch with a one-line note and the jump starts. Owner: Task 7.
3. **Body mass at the ends of the range, 55 kg and 110 kg.** Freefall and canopy stay finite and ordered: heavier falls faster, flies faster under the same canopy and lands harder. Owner: Tasks 3 and 13.
4. **A pull that comes too late or never.** No pull: the AAD fires the reserve at about 750 ft. A pull at 500 ft: the opening is not finished at the ground and the outcome says so. The debrief explains both. Owner: Tasks 12, 14 and 15.
5. **Inputs that do not apply:** pulling twice, toggles before the brakes are unstowed, a PLF gesture in freefall, keys held across the opening. All are ignored without errors and logged as they were. Owner: Tasks 5, 13 and 14.

## Where this plan departs from the spec, and why

Prototyping the physics before writing this plan (scratch scripts, not product code) showed five places where the spec's own numbers pull against each other or need a mechanism the spec does not name:

1. **Belly turns.** The table's fast 360 in 1.5 to 2 s needs about 220°/s at full input with a 0.3 s lag; the spec's controller line says 150°/s. The plan follows the table, because the tests assert the table.
2. **The hill at altitude.** At Interlaken's exit density, 95 percent of the local terminal speed takes 13 s (the spec's 10 to 12 s is a sea-level figure); the first 1,000 ft takes 9.2 s, as the spec says.
3. **Canopy turns.** A banked point mass with a fixed polar loses too little in a 180° turn. The canopy gets a dive state: the nose pitches down while banked, building over 4 s and recovering over 3 s. With the starting values below every turn loss lands inside ±20 percent of the table (prototype: 90°/180° = 65/118, 109/195, 145/251, 225/375 ft against 60/140, 95/225, 125/275, 200/450).
4. **The flare.** Lift follows the brakes in 0.15 s and drag follows them over 3 s (the canopy takes time to rotate into its deep-brake attitude). That gives the 2 to 2.5 s level glide the spec describes. The cost: steady deep brakes sink 20 to 25 percent less than half brakes instead of "rising again"; the rising sink comes from the stall past 95 percent of the stroke. The soft-landing window with a fixed scripted stroke is narrow on the faster canopies (sport 170 about 14 to 16 ft, elliptical about 23 to 25 ft); a person modulates the stroke and gets a wider one. This gets tuned with the friends in milestone 9.
5. **Deferred to the milestone 5 plan:** malfunctions, line twists, cutaway and the two-handle procedure (spec 7.5, which come with the manifest's realism setting), water and hazard landings (7.6, which need the landing-area polygons), the logbook (it lives on the manifest screen), mouse control on desktop, and first-person arms (the asset track has not started; the wrist altimeter is drawn on its own at the wrist). The AAD and the reserve are in this plan.

---

## File Structure

| Path | Responsibility |
|---|---|
| `src/sim/units.ts` | unit constants and display formatting |
| `src/sim/vec3.ts` | vectors and quaternions as plain objects |
| `src/sim/rng.ts` | seeded random numbers |
| `src/sim/atmosphere.ts` | ISA density |
| `src/sim/FixedStep.ts` | the 120 Hz accumulator with a catch-up cap |
| `src/sim/inputs.ts` | the input types every phase and every control scheme share |
| `src/sim/wind.ts` | the wind profile, presets and gusts |
| `src/sim/jumper.ts` | jumper mass and body size |
| `src/sim/freefall/aero.ts` | belly and track forces |
| `src/sim/freefall/freefall.ts` | attitude controller, tumble and the freefall integrator |
| `src/sim/audible.ts` | audible altimeter alarms |
| `src/sim/spot.ts` | the default exit point and jump run |
| `src/sim/opening.ts` | the opening timeline, hard openings, the reserve |
| `src/sim/canopy/polar.ts` | the canopy polar from the target table |
| `src/sim/canopy/canopy.ts` | canopy flight: brakes, bank, dive, stall, risers, swing |
| `src/sim/landing.ts` | touchdown classification |
| `src/sim/Jump.ts` | the jump: phases, the step, events, the track, the input log, the AAD |
| `src/sim/debrief.ts` | the debrief numbers and flags |
| `src/data/canopies.ts` | the five canopies |
| `src/ui/input/tilt.ts`, `gestures.ts`, `keyboard.ts` | sensors, gestures and keys into inputs |
| `src/ui/StartScreen.ts` | scheme choice, loading, the Jump button |
| `src/ui/FreefallControls.ts`, `src/ui/CanopyControls.ts` | the touch layers of each phase |
| `src/ui/DebriefScreen.ts` | the debrief |
| `src/render/JumpCamera.ts` | first-person camera poses |
| `src/render/WristAltimeter.ts` | the analogue altimeter on the wrist |
| `src/render/CanopyModel.ts` | the procedural ram-air canopy |
| `src/audio/JumpAudio.ts` | wind, audible, opening |
| `src/app/JumpSession.ts` | one jump, start screen to debrief |
| `src/app/App.ts`, `src/app/Quality.ts`, `src/main.ts`, `index.html`, `src/style.css` | modified |

---

# Milestone 3: freefall, from the hill to the pull

### Task 1: Simulation foundations

**Files:**
- Create: `src/sim/units.ts`, `src/sim/vec3.ts`, `src/sim/rng.ts`, `src/sim/atmosphere.ts`, `src/sim/FixedStep.ts`, `src/sim/inputs.ts`
- Test: `tests/sim/units.test.ts`, `tests/sim/vec3.test.ts`, `tests/sim/rng.test.ts`, `tests/sim/atmosphere.test.ts`, `tests/sim/FixedStep.test.ts`

**Interfaces:**
- Produces:

```ts
// units.ts
export const FT = 0.3048, MPH = 0.44704, KT = 0.514444, FPM = 0.00508, KMH = 1 / 3.6, G = 9.80665;
export type UnitSystem = 'ft' | 'm';
export function formatAltitude(m: number, units: UnitSystem): string; // nearest 10: "13,500 ft", "4,110 m"
export function formatSpeed(ms: number, units: UnitSystem): string;    // "120 mph", "193 km/h"
export function formatDistance(m: number, units: UnitSystem): string;  // "350 ft", "107 m"
// vec3.ts (immutable; every function returns a new object)
export interface Vec3 { x: number; y: number; z: number }
export interface Quat { x: number; y: number; z: number; w: number }
export function vec3(x: number, y: number, z: number): Vec3;
export function add(a: Vec3, b: Vec3): Vec3; export function sub(a: Vec3, b: Vec3): Vec3;
export function scale(a: Vec3, s: number): Vec3; export function dot(a: Vec3, b: Vec3): number;
export function cross(a: Vec3, b: Vec3): Vec3; export function length(a: Vec3): number;
export function normalize(a: Vec3): Vec3; // zero vector stays zero
export function quatIdentity(): Quat; export function quatFromAxisAngle(axis: Vec3, rad: number): Quat;
export function quatMultiply(a: Quat, b: Quat): Quat; export function quatRotate(q: Quat, v: Vec3): Vec3;
export function quatFromUnitVectors(from: Vec3, to: Vec3): Quat; // shortest arc, handles opposite vectors
export function quatNormalize(q: Quat): Quat;
// rng.ts
export class Rng { constructor(seed: number); next(): number; range(min: number, max: number): number; normal(): number; }
// atmosphere.ts
export const SEA_LEVEL_DENSITY = 1.225;
export function isaDensity(altitudeMslM: number, temperatureOffsetC?: number): number;
// FixedStep.ts
export const SIM_HZ = 120; export const SIM_DT = 1 / 120;
export class FixedStep { constructor(step: (dt: number, first: boolean) => void, maxStepsPerAdvance?: number /* 12 */); advance(realDtS: number): number /* steps run */; reset(): void; }
// inputs.ts
export interface FreefallInput { turn: number; drive: number; fallRate: number; track: boolean } // turn −1..1 (right +), drive −1 back .. +1 forward, fallRate −1 slow (de-arch) .. +1 fast (arch)
export interface CanopyInput { left: number; right: number; frontLeft: number; frontRight: number; rear: number; unstow: boolean } // 0..1 each
export interface JumpInput { freefall: FreefallInput; pull: boolean; canopy: CanopyInput; plf: boolean }
export const NEUTRAL_INPUT: JumpInput;
```

`Rng` is mulberry32. `isaDensity`: standard temperature T_std = 288.15 − 0.0065 h, pressure p = 101325 (T_std / 288.15)^5.25588, actual temperature T = T_std + offset, ρ = p / (287.05 T). `FixedStep.advance` passes `first = true` on the first step of each call so edge inputs (pull, unstow, PLF) are delivered once; leftover time below one step is kept; time beyond `maxStepsPerAdvance` steps is dropped.

- [ ] **Step 1: Write the failing tests:** formatting (`formatAltitude(4114.8, 'ft') === '13,500 ft'`, `formatSpeed(53.6448, 'ft') === '120 mph'`, `formatSpeed(53.6448, 'm') === '193 km/h'`); `quatRotate(quatFromUnitVectors(a, b), a)` equals `b` within 1e-9 for random unit pairs including opposite vectors; `new Rng(7)` gives the same 1,000 numbers twice and a different sequence from `new Rng(8)`, all in [0, 1); `isaDensity(0)` 1.225 ±0.001, `isaDensity(1000)` 1.1117 ±0.002, `isaDensity(4000)` 0.8194 ±0.002, `isaDensity(0, 15)` 1.164 ±0.003; `FixedStep`: `advance(0.05)` runs 6 steps, three `advance(0.004)` calls run 1 step in total, `advance(1)` runs exactly 12 steps, the `first` flag is true once per call.
- [ ] **Step 2: Run them and see them fail.** `npx vitest run tests/sim`
- [ ] **Step 3: Implement the six modules.**
- [ ] **Step 4: Run the tests and see them pass;** `npm run typecheck`.
- [ ] **Step 5: Commit** `feat(sim): units, vectors, seeded random, ISA, fixed step, input types`

---

### Task 2: Wind

**Files:**
- Create: `src/sim/wind.ts`
- Test: `tests/sim/wind.test.ts`

**Interfaces:**
- Consumes: `Vec3`, `Rng` (Task 1).
- Produces:

```ts
export interface WindProfile {
  surfaceSpeedMs: number;  // mean speed at 10 m above ground
  surfaceFromDeg: number;  // direction it blows FROM, degrees true
  aloftFactor: number;     // speed multiplier reached at 3,000 m above ground (2 to 3)
  veerDeg: number;         // clockwise change of direction from 10 m to 3,000 m
  gustFraction: number;    // gust standard deviation over mean speed near the ground
}
export type WindPreset = 'calm' | 'typical' | 'sporty';
export const WIND_PRESETS: Record<WindPreset, WindProfile>;
// calm  { 1, 270, 2.0, 20, 0.05 }   typical { 4, 270, 2.5, 30, 0.15 }   sporty { 8, 250, 2.5, 35, 0.25 }
export class Wind {
  constructor(profile: WindProfile, rng: Rng);
  mean(aglM: number): Vec3;              // where the air moves TO, m/s; y = 0
  at(aglM: number, tS: number): Vec3;    // mean plus gust
  fromDegAt(aglM: number): number;
}
```

Shape: f(h) = clamp(ln(1 + max(h, 0)/10) / ln(301), 0, 1); speed = surface × (1 + (aloftFactor − 1) f); from-direction = surfaceFromDeg + veerDeg × f; constant above 3,000 m. A wind from bearing θ moves toward θ + 180, so its vector is speed × (sin(θ+180°), 0, −cos(θ+180°)). Gusts: per horizontal axis, a sum of four sines with seeded phases at 0.05, 0.11, 0.23 and 0.47 Hz, scaled so the standard deviation is `gustFraction × mean speed` below 50 m above ground, fading linearly to zero at 300 m. Deterministic in `t` for a seed.

- [ ] **Step 1: Failing tests:** `mean(10)` is the surface speed ±2 percent and blows toward 90° for a 270° wind (positive x); `mean(3000)` is `aloftFactor ×` surface ±2 percent with the direction veered by `veerDeg` ±1°; `mean(5000)` equals `mean(3000)`; over 600 s sampled at 10 Hz at 20 m the gust has a mean within 10 percent of the mean wind and a standard deviation within 30 percent of `gustFraction × speed`; `at(400, t)` equals `mean(400)`; two `Wind`s with the same seed agree to 1e-12.
- [ ] **Step 2: Run, fail. Step 3: Implement. Step 4: Run, pass.**
- [ ] **Step 5: Commit** `feat(sim): wind profile with veer, presets and gusts`

---

### Task 3: Freefall aerodynamics

**Files:**
- Create: `src/sim/jumper.ts`, `src/sim/freefall/aero.ts`
- Test: `tests/sim/freefall/aero.test.ts`

**Interfaces:**
- Consumes: Task 1.
- Produces:

```ts
// jumper.ts
export interface JumperParams { bodyMassKg: number; gearMassKg: number }
export const DEFAULT_JUMPER: JumperParams; // { 85, 12 }
export function clampBodyMass(kg: number): number;   // 55..110
export function exitMassKg(j: JumperParams): number;
export function bodyAreaScale(j: JumperParams): number; // (bodyMassKg / 85) ** (2/3)
// freefall/aero.ts
export const BELLY = { cdaNeutral: 0.55, cdaArch: 0.45, cdaDeArch: 0.68, driveLift: 0.24, maxPitchRad: 25 * Math.PI / 180 };
export const JUMPSUIT_TRACK = { area: 0.7, cd0: 0.45, k: 1.0, clAlpha: 2.3, clMax: 0.9, trimAlphaRad: 10 * Math.PI / 180 };
export function bellyCdA(fallRate: number, areaScale: number): number; // piecewise-linear −1 → 0.68, 0 → 0.55, +1 → 0.45, times areaScale
export interface BodyFrame { forward: Vec3; up: Vec3 } // forward = head, up = back; the belly faces −up
export function freefallForce(a: { airVel: Vec3; rho: number; body: BodyFrame; fallRate: number; trackBlend: number; areaScale: number }): Vec3;
```

The force, with q = ½ ρ |airVel|², d = airVel / |airVel| and n = −up (the belly normal):
- **Belly:** F_b = q · CdA · (−d − driveLift · n⊥), where n⊥ = n − (n·d) d. Belly flat to the wind gives pure drag; a head-low pitch tilts n toward the feet, so −n⊥ points along the head and drives forward; legs-out drives backward. At the maximum pitch the lift-to-drag ratio is driveLift · sin 25° ≈ 0.1.
- **Track:** α = atan2(−(d·up), d·forward) (90° when the belly faces the wind); CL = clamp(clAlpha · α, −clMax, clMax); CD = cd0 + k CL²; lift direction l = normalize(up − (up·d) d); F_t = q · area · areaScale · (CL · l − CD · d).
- **Blend:** F = (1 − trackBlend) F_b + trackBlend F_t.

- [ ] **Step 1: Failing tests.** A test helper integrates a point mass of `exitMassKg` under gravity and `freefallForce` for 90 s at constant density 1.225, re-aiming the body every step so it holds a fixed attitude relative to the relative wind (belly: up = −d rotated by the pitch about the body's right axis; track: forward = d rotated up by `trimAlphaRad` about the right axis, `trackBlend = 1`), and returns the final vertical and horizontal speed. Assertions (mph; each is the table value ±5 percent):
  - belly neutral: vertical 114 to 126, horizontal under 1;
  - hard arch (`fallRate +1`): vertical 123.5 to 141.8;
  - de-arched (`fallRate −1`): vertical 99.8 to 115.5;
  - full forward drive (pitch 25° head-low): vertical 114 to 126, horizontal 9.5 to 15.8 along the head direction, glide 0.08 to 0.13;
  - jumpsuit track: vertical 90 to 115.5, horizontal 52 to 73.5, glide 0.57 to 0.74;
  - body mass 55 kg < 85 kg < 110 kg in belly-neutral vertical speed, all finite.
- [ ] **Step 2: Run, fail. Step 3: Implement. Step 4: Run, pass.** Tune only `BELLY` and `JUMPSUIT_TRACK` constants if a range is missed, and report any change.
- [ ] **Step 5: Commit** `feat(sim): belly and track aerodynamics with mass scaling`

---

### Task 4: Attitude controller and the freefall integrator

**Files:**
- Create: `src/sim/freefall/freefall.ts`
- Test: `tests/sim/freefall/freefall.test.ts`

**Interfaces:**
- Consumes: Tasks 1 to 3.
- Produces:

```ts
export interface FreefallEnv { rho: (yMslM: number) => number; wind: (pos: Vec3, tS: number) => Vec3; jumper: JumperParams }
export interface FreefallState {
  pos: Vec3; vel: Vec3; tS: number;
  base: Quat;          // body orientation presented to the relative wind (belly along d), with heading; before pitch and bank
  pitch: number; bank: number;  // radians, relative to base; head-low pitch positive
  yawRate: number;     // rad/s about d, positive turns right
  trackBlend: number;  // 0 belly .. 1 track
  tumbling: boolean; tumbleSpin: Vec3; archFor: number;
}
export function createFreefallState(o: { pos: Vec3; vel: Vec3; wind: Vec3; headUp?: boolean; pitch?: number; bank?: number }): FreefallState;
export function bodyFrame(s: FreefallState): BodyFrame;
export function airDirection(s: FreefallState, env: FreefallEnv): Vec3;
export function stepFreefall(s: FreefallState, input: FreefallInput, env: FreefallEnv, dt: number, rng: Rng): void;
export const ATTITUDE = { lagS: 0.3, maxYawRateDeg: 220, maxPitchBankRateDeg: 90, tumbleLimitDeg: 70, recoverArchS: 2, tumbleCdA: 0.40, trackBlendS: 1.0, trackTurnBankDeg: 40, bellyTurnBankDeg: 10 };
```

The step, in order (reference; the implementer writes it):

```
d_old = previous air direction; d = normalize(vel − wind(pos, t))
base = quatFromUnitVectors(d_old, d) ∘ base                 // the body follows the relative wind without yawing
trackBlend → (input.track ? 1 : 0) with first-order lag trackBlendS
if not tumbling:
  yawTarget = (1 − trackBlend) · input.turn · maxYawRate         // belly turns are body twist
  yawRate   → yawTarget with lag lagS;  base = quatFromAxisAngle(d, yawRate·dt) ∘ base
  pitchTarget = (1 − trackBlend) · input.drive · 25° + trackBlend · (90° − trimAlpha + input.drive · 4°)
                // the track is a head-low rotation from the belly (the head points along the flight path): the angle of attack is 90° − pitch, 10° at trim, 6° head-low (faster, steeper), 14° legs-out
  bankTarget  = input.turn · lerp(bellyTurnBankDeg, trackTurnBankDeg, trackBlend)
  pitch, bank → targets with lag lagS and rate limit maxPitchBankRateDeg
  if trackBlend < 0.5 and (|pitch| or |bank| > tumbleLimitDeg): tumbling = true, tumbleSpin = random axis · U(90, 180) °/s
else:
  base = quatFromAxisAngle(tumbleSpin, |tumbleSpin|·dt) ∘ base; tumbleSpin drifts by a small random walk
  archFor += dt while input.fallRate ≥ 0.8, else archFor = 0
  if archFor ≥ recoverArchS: tumbling = false; pitch = bank = 0; base re-presented belly-to-wind keeping the heading of the body's forward axis
force = tumbling ? q · tumbleCdA · areaScale · (−d) : freefallForce(...)
vel += (force / m + (0, −G, 0)) · dt;  pos += vel · dt;  tS += dt      // semi-implicit Euler
```

`createFreefallState` with `headUp` (the exit) points the head along world up and the belly into the relative wind; otherwise the belly faces straight down with the head along the horizontal velocity. Initial `pitch`/`bank` beyond 70° start a tumble (a poor exit).

- [ ] **Step 1: Failing tests** (Interlaken: ground 568 m, exit at 568 + 4,115 m MSL, ISA density, calm unless stated, `new Rng(1)`):
  - **the hill:** exit at 95 kt true northward, `headUp`: the vertical speed reaches 95 percent of the local belly terminal speed between 11 and 14.5 s; the first 1,000 ft is fallen in 8.5 to 10.5 s; after 12 s the belly normal is within 15° of straight down and the head points within 30° of north; the horizontal distance travelled by 12 s is 300 to 500 m;
  - **at terminal** with constant density 1.225: 1,000 ft takes 5.4 to 6.0 s;
  - **turns** at terminal: full right turn input turns the heading of the body's forward axis through 360° in 1.5 to 2.0 s; half input in 3.0 to 4.0 s; left input turns left;
  - **drive:** full forward drive moves the jumper horizontally along the head direction;
  - **track:** after `track: true` for 6 s the horizontal speed exceeds 25 m/s and the vertical speed falls below 51 m/s; turning in track changes the ground track heading (by bank, with no body twist);
  - **tumble:** a state created with `bank: 80°` is tumbling; with `fallRate: 1` held it recovers within 2.5 s; with neutral input it is still tumbling after 5 s, and its vertical speed exceeds the belly terminal by at least 5 percent;
  - **determinism:** two runs with the same seed and inputs agree to 1e-12 after 60 s.
- [ ] **Step 2: Run, fail. Step 3: Implement. Step 4: Run, pass.**
- [ ] **Step 5: Commit** `feat(sim): attitude controller, tumble and freefall integrator`

---

### Task 5: The jump, part one: freefall to the pull, audible, spot

**Files:**
- Create: `src/sim/Jump.ts`, `src/sim/audible.ts`, `src/sim/spot.ts`
- Test: `tests/sim/Jump.test.ts`, `tests/sim/audible.test.ts`, `tests/sim/spot.test.ts`

**Interfaces:**
- Consumes: Tasks 1 to 4.
- Produces:

```ts
// audible.ts
export type AudibleAlarm = 'alarm1' | 'alarm2' | 'alarm3' | 'flatline';
export interface AudibleSettings { alarmsFt: [number, number, number]; flatlineFt: number } // [5500, 4000, 2000], 1000
export const DEFAULT_AUDIBLE: AudibleSettings;
export class Audible {
  constructor(settings?: AudibleSettings);
  update(altitudeAglFt: number, inFreefall: boolean): AudibleAlarm[]; // alarms crossed downward this call, each once per jump
  readonly continuous: AudibleAlarm | null; // 'alarm3' from 2,000 ft, 'flatline' from 1,000 ft; null once not in freefall
}
// spot.ts
export function defaultExit(o: { lzGroundY: number; exitAltitudeAglM: number; wind: Wind; aircraftTasMs: number; jumpRunHeadingDeg?: number }): { pos: Vec3; headingRad: number };
// Jump.ts
export type JumpPhase = 'freefall' | 'opening' | 'canopy' | 'landing' | 'landed';
export interface JumpConfig {
  seed: number; jumper: JumperParams; wind: WindProfile; temperatureOffsetC: number;
  exitPos: Vec3; exitHeadingRad: number; aircraftTasMs: number; // 95 kt by default
  lzGroundY: number;                         // MSL height of the landing area: the altimeter's zero
  ground: (x: number, z: number) => number;  // MSL ground height where the jumper is
  canopyId: string;                          // typed as CanopyId from Task 13 on
  pullAltitudeFt: number;                    // 3,500 by default; only the late-pull flag uses it
  audible: AudibleSettings;
  constantDensity?: number;                  // tests only
}
export type JumpEventType = 'exit' | 'alarm' | 'pull' | 'stage' | 'open' | 'unstow' | 'aad' | 'touchdown' | 'impact' | 'outcome';
export interface JumpEvent { tS: number; type: JumpEventType; detail?: string; aglM: number }
export interface TrackSample { tS: number; pos: Vec3; vel: Vec3; phase: JumpPhase; aglM: number }
export class Jump {
  constructor(config: JumpConfig);
  readonly config: JumpConfig; readonly rng: Rng; readonly wind: Wind; readonly audible: Audible;
  phase: JumpPhase; tS: number;
  freefall: FreefallState;
  readonly events: JumpEvent[];
  readonly track: TrackSample[];   // one sample every 0.1 s
  readonly inputLog: JumpInput[];  // one entry per step
  step(input: JumpInput): void;    // one SIM_DT step
  altitudeAglM(): number;          // jumper y − lzGroundY
  heightAboveGround(): number;     // jumper y − ground(x, z)
  position(): Vec3; velocity(): Vec3; airVelocity(): Vec3;
}
```

In this task the phases are `freefall` and, after the throw, `opening`, which keeps integrating freefall until Task 14 replaces it; a freefall that reaches the ground ends in `landed` with an `impact` event. `pull` acts only on the first step it is true in `freefall`. The exit puts the jumper at `exitPos` with the aircraft's true airspeed along `exitHeadingRad` plus the wind there, `headUp`, and logs `exit`. Each `Jump` step calls `Audible.update` and logs an `alarm` event per alarm crossed. `defaultExit` aims the jump run into the wind at 3,000 m (or `jumpRunHeadingDeg`), puts the expected opening point 500 m upwind of the landing area along the surface wind (on the landing area itself when the surface wind is under 1 m/s), and steps the exit back from the opening point by the mean wind from exit to 3,500 ft times 60 s plus 400 m of forward throw along the run.

- [ ] **Step 1: Failing tests:** the audible fires `alarm1`, `alarm2`, `alarm3` exactly once on a descent through 6,000 to 1,500 ft and nothing on a climb; `continuous` is `alarm3` below 2,000 ft and `flatline` below 1,000 ft, and null when `inFreefall` is false. A jump at flat ground 568 m with neutral input from 13,500 ft and a pull at 3,500 ft: events in the order exit, alarm, alarm, pull; the freefall time is 55 to 65 s; `altitudeAglM()` at the pull is 3,500 ft ±50; a second pull input changes nothing; with no pull the jumper impacts and the phase is `landed`; replaying `inputLog` into a new `Jump` with the same config ends at the same position to 1e-9. `defaultExit` in calm air with a 0° jump run puts the exit 400 m south of the landing area ±100 m and in the typical preset puts it upwind.
- [ ] **Step 2: Run, fail. Step 3: Implement. Step 4: Run, pass.**
- [ ] **Step 5: Commit** `feat(sim): the jump from exit to the pull, audible altimeter and spot`

---

### Task 6: Input layer

**Files:**
- Create: `src/ui/input/tilt.ts`, `src/ui/input/gestures.ts`, `src/ui/input/keyboard.ts`
- Test: `tests/ui/input/tilt.test.ts`, `tests/ui/input/gestures.test.ts`, `tests/ui/input/keyboard.test.ts`

**Interfaces:**
- Consumes: `JumpInput`, `FreefallInput`, `CanopyInput` (Task 1).
- Produces:

```ts
// tilt.ts
export interface TiltReading { beta: number; gamma: number }           // degrees, from DeviceOrientationEvent
export interface TiltAxes { pitch: number; roll: number }               // degrees from neutral; pitch + = top of the phone tilted away (forward), roll + = right side down
export function tiltAxes(r: TiltReading, neutral: TiltReading, screenAngle: number): TiltAxes; // remapped for 0, 90, 180, 270
export function axisToInput(deg: number, deadZoneDeg?: number /* 3 */, fullDeg?: number /* 25 */): number; // −1..1
export type TiltPermission = 'granted' | 'denied' | 'unavailable';
export function requestTiltPermission(): Promise<TiltPermission>;      // iOS requestPermission on a user gesture; 'unavailable' without DeviceOrientationEvent
export class TiltSource { constructor(target: Window); start(): void; calibrate(): void; axes(): TiltAxes | null; rollRateDegS(): number; dispose(): void }
// gestures.ts
export interface PointerSample { x: number; y: number; tMs: number }
export function isPullSwipe(start: PointerSample, end: PointerSample, viewportW: number): boolean; // outward (rightward) at least 8 % of the width within 600 ms
export function dragToFallRate(dyPx: number, viewportH: number): number;  // up (negative dy) = de-arch = negative; full at 15 % of the height
export function padToBody(dxPx: number, dyPx: number, viewportW: number): { turn: number; drive: number }; // full at 12 % of the width; up = forward
export function toggleDepth(dyPx: number, viewportH: number): number;     // 0..1, full at 35 % of the height
export function isPlfRoll(rollRateDegS: number): boolean;                // above 120 °/s
// keyboard.ts
export class KeyboardSource { constructor(target: Window); sample(dtS: number): JumpInput & { lookUp: number }; dispose(): void }
```

Keys: freefall arrows or WASD turn and drive, `R` arch, `F` de-arch, `T` toggles the track, `P` pulls. Canopy: `A`/`←` left toggle and `D`/`→` right toggle (ramp to 1 in 0.6 s while held, back in 0.3 s), `S`/`↓` both, `Q`/`E` front risers, `W` rear risers, `U` unstows, `Space` is the PLF, `L` looks up while held. `P`, `U` and `Space` are edges: true on one sample.

- [ ] **Step 1: Failing tests:** `axisToInput` is 0 inside the dead zone, ±1 at and beyond `fullDeg`, odd and monotonic; `tiltAxes` gives the same pitch and roll for the same physical tilt in portrait and in landscape (90 and 270); `isPullSwipe` true for a 60 px rightward swipe in 300 ms on a 390 px screen, false for 20 px or 900 ms or a leftward one; `dragToFallRate(−0.15 H)` = −1; `KeyboardSource` with `ArrowRight` held reports `turn = 1`, `P` reports `pull` on one sample only, `A` held 0.3 s gives a left toggle of 0.5 ±0.05.
- [ ] **Step 2: Run, fail. Step 3: Implement. Step 4: Run, pass.**
- [ ] **Step 5: Commit** `feat(ui): tilt, gestures and keyboard into jump inputs`

---

### Task 7: Start screen and freefall touch controls

**Files:**
- Create: `src/ui/StartScreen.ts`, `src/ui/FreefallControls.ts`
- Modify: `src/style.css` (their styles), `index.html` (`<div id="vignette">` after the canvas)
- Test: `tests/ui/StartScreen.test.ts`, `tests/ui/FreefallControls.test.ts`

**Interfaces:**
- Consumes: Task 6.
- Produces:

```ts
export type ControlScheme = 'tilt' | 'touch';
export class StartScreen {
  constructor(root: HTMLElement, o: { dzName: string; units: UnitSystem });
  setLoading(text: string | null): void;  // "Loading the drop zone… 42 tiles"; null when ready
  setReady(ready: boolean): void;         // enables the Jump button
  onJump: ((scheme: ControlScheme) => void) | null;  // called after the permission dance, with the scheme that will be used
  show(on: boolean): void;
}
export class FreefallControls {
  constructor(root: HTMLElement, scheme: ControlScheme, tilt: TiltSource | null);
  sample(): Pick<JumpInput, 'freefall' | 'pull'>;
  show(on: boolean): void; dispose(): void;
}
```

The start screen shows the drop zone, the loading line, two scheme buttons (Tilt, the default, and Touch; remembered in `localStorage` inside try/catch), one line explaining each scheme, and the Jump button. On Jump with Tilt chosen it calls `requestTiltPermission()`; on `denied` or `unavailable` it switches to Touch, shows "Tilt is not available on this device, using touch." for the session, and still starts. Freefall controls: Tilt scheme, the left half of the screen is the fall-rate drag (up slows, down speeds up) and tilt gives turn and drive; Touch scheme, a left thumb pad gives turn and drive and a right thumb drag gives fall rate. Both have a Track toggle button and the pull handle drawn at the lower right where the hackey sits: a swipe outward from it pulls. All touch targets are at least 44 px, `touch-action: none`, safe-area aware. The vignette is a fixed radial gradient (transparent centre, 35 percent black at the corners), hidden until a jump starts.

- [ ] **Step 1: Failing tests (happy-dom):** Jump is disabled until `setReady(true)`; choosing Tilt with `requestTiltPermission` stubbed to `denied` calls `onJump('touch')` and shows the note; Touch calls `onJump('touch')` without asking; synthetic pointer events: a swipe outward from the handle gives `pull: true` on one `sample()` only, a left-half upward drag of 15 % of the height gives `fallRate −1` in the Tilt scheme, tapping Track flips `track`.
- [ ] **Step 2: Run, fail. Step 3: Implement. Step 4: Run, pass.**
- [ ] **Step 5: Commit** `feat(ui): start screen and freefall touch controls`

---

### Task 8: First-person view: camera and wrist altimeter

**Files:**
- Create: `src/render/JumpCamera.ts`, `src/render/WristAltimeter.ts`
- Test: `tests/render/JumpCamera.test.ts`, `tests/render/WristAltimeter.test.ts`

**Interfaces:**
- Consumes: `BodyFrame` (Task 3), `Vec3` (Task 1).
- Produces:

```ts
export interface CameraPose { position: Vec3; forward: Vec3; up: Vec3 }
export function freefallEye(body: BodyFrame, airDir: Vec3, pos: Vec3): CameraPose; // looks 40° from the airflow direction toward the head: 50° below the horizon at terminal, 40° above it at the exit
export class JumpCamera {
  constructor(camera: THREE.PerspectiveCamera);
  apply(pose: CameraPose, originOffset: { x: number; z: number }, shakeG: number): void; // world position minus the floating-origin offset; shake ±0.4° per g of deceleration
}
export function needleAngleRad(altitudeAglM: number, units: UnitSystem): number; // clockwise from the top: one turn per 12,000 ft, or per 4,000 m
export class WristAltimeter {
  constructor(units: UnitSystem);
  readonly object: THREE.Object3D;   // add to the camera: lower left, 0.3 m ahead
  setAltitude(aglM: number): void;
}
```

The altimeter is a dark wristband segment, a bezel ring and a face with a canvas texture: numerals 0 to 12 (thousands of feet) or 0 to 4 (km), minor ticks, a red arc from 0 to 2,000 ft (0 to 600 m) and a yellow arc to 3,000 ft (to 1,000 m), and a white needle. About 6 cm across at 0.3 m, readable on a phone, under 200 triangles. Drawing guards against a canvas without a 2D context (happy-dom).

- [ ] **Step 1: Failing tests:** `needleAngleRad(0)` = 0, `(6000 ft)` = π, `(13,500 ft)` = π/4 (mod 2π), `(2,000 m, 'm')` = π; `freefallEye` for belly-down at terminal heading north looks north and 50° ±1° below the horizon with screen-up toward north-up; at the exit (head up, airflow north) it looks north 40° ±1° above the horizon; `setAltitude` rotates the needle object to `−needleAngleRad`.
- [ ] **Step 2: Run, fail. Step 3: Implement. Step 4: Run, pass.**
- [ ] **Step 5: Commit** `feat(render): first-person camera and wrist altimeter`

---

### Task 9: Jump audio

**Files:**
- Create: `src/audio/JumpAudio.ts`
- Test: `tests/audio/JumpAudio.test.ts`

**Interfaces:**
- Consumes: `AudibleAlarm` (Task 5).
- Produces:

```ts
export type WindMode = 'freefall' | 'canopy' | 'silent';
export function windGain(airspeedMs: number, mode: WindMode): number;   // freefall min(1, (V/55)²) · 0.8; canopy min(1, (V/15)²) · 0.12
export function windCutoffHz(airspeedMs: number, mode: WindMode): number; // freefall 400 + 45 · V, capped 3,500; canopy 300 + 40 · V
export type OpeningSound = 'flutter' | 'snap' | 'quiet';
export class JumpAudio {
  constructor(ctxFactory?: () => AudioContext);
  resume(): Promise<void>;             // from the Jump tap
  setWind(airspeedMs: number, mode: WindMode): void; // smoothed over 0.15 s
  alarm(a: AudibleAlarm): void;        // alarm1 three short 2.6 kHz beeps, alarm2 two long, alarm3 and flatline handled by setContinuous
  setContinuous(a: AudibleAlarm | null): void; // alarm3 alternating 2.6/3.1 kHz at 4 Hz, flatline steady 2.8 kHz
  opening(s: OpeningSound): void;      // flutter: the wind noise amplitude-modulated at 14 Hz; snap: an 80 ms low noise burst; quiet: canopy wind
  dispose(): void;
}
```

The wind is a looping two-second white-noise buffer through a low-pass filter and a gain. Every call is safe before `resume()` and when Web Audio is missing (no-ops).

- [ ] **Step 1: Failing tests:** the pure curves (`windGain(55, 'freefall')` = 0.8, monotonic, canopy far quieter than freefall at its speeds); with a minimal fake `AudioContext` passed to the constructor, `setWind`, `alarm`, `setContinuous` and `opening` run without throwing, and without any context they are no-ops.
- [ ] **Step 2: Run, fail. Step 3: Implement. Step 4: Run, pass.**
- [ ] **Step 5: Commit** `feat(audio): freefall wind, audible altimeter and opening sounds`

---

### Task 10: Adaptive quality against the display's own refresh (Plan 1 carry-over)

**Files:**
- Modify: `src/app/Quality.ts`, `src/app/App.ts`
- Test: `tests/app/Quality.test.ts`

**Interfaces:**
- Produces: `AdaptiveQuality` gains `setRefreshIntervalMs(ms: number)` (the threshold becomes 1.25 × that interval) and `hold(on: boolean)` (no step-down while held). `App` measures the median frame interval of frames 30 to 90 after start and passes it in, and holds adaptation while the terrain has more than 20 pending tiles.

Why: iPhones in Low Power Mode and some browsers deliver frames at 30 Hz, where the fixed 20 ms threshold steps the tier down for no reason, and the loading burst should never count.

- [ ] **Step 1: Failing tests:** with a 33.3 ms refresh, 33 ms frames for 10 s never step down, 45 ms frames step down after 2 s; with `hold(true)` nothing steps down.
- [ ] **Step 2: Run, fail. Step 3: Implement. Step 4: Run, pass.**
- [ ] **Step 5: Commit** `fix(app): adaptive quality follows the display's refresh and waits for loading`

---

### Task 11: Milestone 3 integration: jump from the exit to the pull

**Files:**
- Create: `src/app/JumpSession.ts`
- Modify: `src/app/App.ts`, `src/main.ts`, `src/data/dropzones.ts` (the `exitAltitudeFt` comment says above ground), `index.html`
- Test: `tests/app/JumpSession.test.ts`

**Interfaces:**
- Consumes: everything above.
- Produces:

```ts
export interface JumpSessionOptions { dz: DropZone; jumper: JumperParams; wind: WindProfile; canopyId: string; seed: number; scheme: ControlScheme }
export class JumpSession {
  constructor(app: App, opts: JumpSessionOptions);
  readonly jump: Jump;
  frame(dtS: number): void;   // samples the controls, advances FixedStep, drives camera, altimeter, audio
  onEnd: ((jump: Jump) => void) | null;
  dispose(): void;
}
```

URL parameters: `?wind=calm|typical|sporty` (typical), `?mass=55..110`, `?canopy=` (`sport-210` until Task 13 names the list), `?seed=` (random by default), `?free=1` keeps Plan 1's free camera and debug buttons. `App` gains a mode: the start screen shows over the parked camera (the existing park-at-exit logic keeps the terrain streaming) and stays "loading" until the ground under the landing area is known at zoom 10 or finer and fewer than 15 tiles are pending, or 20 s have passed. On Jump: `JumpAudio.resume()`, the session starts at `defaultExit`, the vignette and the freefall controls show, the camera is the jumper's eye (`freefallEye`) through `JumpCamera`, the altimeter is on the camera, `TiltSource.calibrate()` takes the phone's current attitude as neutral. Each frame the controls are sampled once and every sim step of that frame uses that input (edges on the first step). After the pull, until milestone 4 lands, the session freezes the sim and shows "Pull at 3,500 ft. The canopy arrives in the next update." with a Jump again button. The debug overlay adds sim lines: phase, AGL, vertical speed, fall rate, heading. The debug exit button uses the drop zone's `exitAltitudeFt` (Plan 1 carry-over 4). The session pauses on `visibilitychange` hidden and resumes without a jump ahead.

- [ ] **Step 1: Failing test:** a `JumpSession` driven with a fake `App` (renderer and terrain stubbed, `ground = () => 568`) and keyboard input `P` held from 3,600 ft reaches the pull with the `pull` event between 3,450 and 3,600 ft AGL, and `frame(1.0)` advances at most 12 steps.
- [ ] **Step 2: Run, fail. Step 3: Implement. Step 4: Run, pass;** `npm run build`.
- [ ] **Step 5: Commit** `feat(app): first jump, from the exit to the pull`
- [ ] **Step 6 (Orchestrator): browser check and device pass.** Exit at Interlaken in the browser pane (pane visible), check the hill, turns, the track, the altimeter and the alarms; push; Shadi plays it on both phones with tilt and with touch. Findings go into the briefs of Tasks 12 to 18.

---

# Milestone 4: opening, canopy, landing, debrief

### Task 12: The opening, hard openings, the AAD and the reserve

**Files:**
- Create: `src/sim/opening.ts`
- Test: `tests/sim/opening.test.ts`

**Interfaces:**
- Consumes: Tasks 1, 3, 4.
- Produces:

```ts
export type OpeningStage = 'pilot-chute' | 'bag' | 'line-stretch' | 'snivel' | 'inflation' | 'open';
export interface OpeningPlan { kind: 'main' | 'reserve'; hesitationS: number; snivelS: number; hard: boolean }
export function planOpening(rng: Rng, verticalSpeedMs: number, kind: 'main' | 'reserve'): OpeningPlan;
export class Opening {
  constructor(plan: OpeningPlan);
  readonly plan: OpeningPlan; tS: number; stage: OpeningStage;
  inflation: number;  // 0 packed .. 1 fully inflated, for the canopy model and the sound
  slider: number;     // 1 up at the canopy .. 0 down at the risers
  dragArea(): number; // m², added to the jumper's body drag along the airflow
  flightBlend(): number; // 0 .. 1: share of the canopy's own flight force (Task 13) that acts
  advance(dtS: number): OpeningStage | null; // the new stage when one began
}
export const OPENING = { bagLiftS: 0.5, linesS: 0.3, inflationS: 0.8, reserveHesitation: [0.1, 0.3], reserveSnivel: [0.8, 1.2], hardAboveMs: 62.6, hardFullMs: 71.5 };
```

The timeline from the throw (main): pilot chute hesitation `hesitationS` = U(0.3, 1.0) with drag area 0.05 (the hand and the bridle), the bag lifting for 0.5 s at 0.6 m², lines paying out for 0.3 s, **line stretch** at hesitation + 0.8 s with a 0.15 s snatch at 1.4 m², the **snivel** for `snivelS` = U(1.8, 2.4) with the slider up and the drag area rising from 1.0 to 3.2 m², **inflation** over 0.8 s with the drag area handing over to the canopy (`flightBlend` 0 to 1, `slider` 1 to 0), then **open**. The reserve: hesitation U(0.1, 0.3), snivel U(0.8, 1.2), inflation 0.6 s. Hard opening: when the vertical speed at the throw exceeds 140 mph the plan is hard with probability clamp((v − 62.6) / 8.9, 0, 1); a hard plan snivels 0.3 s and inflates in 0.4 s. These drag areas are starting values: tune them to the targets below and report the final numbers.

- [ ] **Step 1: Failing tests.** A test helper falls belly-neutral at terminal from 3,500 ft above Interlaken (ISA), throws, and integrates `exitMass` under gravity, body drag (belly CdA, tilting to an upright 0.5 m² through the snivel) and `dragArea()` until `open`, with `flightBlend` treated as a 9.5 m² full-flight drag area for the test. Over seeds 1 to 60:
  - main: time from throw to `open` 3.7 to 5.2 s, mean 4.0 to 5.0 s;
  - peak deceleration 2.8 to 5.5 g for every non-hard opening;
  - altitude from the throw to `open` 570 to 945 ft;
  - reserve: `open` within 3.2 s;
  - at 150 mph vertical between 30 and 70 percent of the plans are hard, at 160 mph all of them, and every hard one peaks above 8 g; at 120 mph none is hard.
- [ ] **Step 2: Run, fail. Step 3: Implement. Step 4: Run, pass.**
- [ ] **Step 5: Commit** `feat(sim): opening sequence, hard openings and the reserve opening`

---

### Task 13: Canopies, the polar and canopy flight

**Files:**
- Create: `src/data/canopies.ts`, `src/sim/canopy/polar.ts`, `src/sim/canopy/canopy.ts`
- Test: `tests/sim/canopy/canopy.test.ts`

**Interfaces:**
- Consumes: Tasks 1 to 3.
- Produces:

```ts
// data/canopies.ts
export type CanopyId = 'student-280' | 'sport-210' | 'sport-170' | 'elliptical-150' | 'reserve-220';
export interface CanopySpec {
  id: CanopyId; name: string; areaFt2: number; cells: 7 | 9;
  fullFlight: { mph: number; fpm: number }; halfBrakes: { mph: number; fpm: number }; // for the 97 kg reference jumper at sea level
  bankMaxDeg: number; rollRateDegS: number; rollOutDegS: number;
  diveGain: number; diveBuildS: number; diveRecoverS: number;
}
export const CANOPIES: Record<CanopyId, CanopySpec>;
export const DEFAULT_CANOPY: CanopyId; // 'sport-210'
// sim/canopy/polar.ts
export const POLAR = { referenceMassKg: 97, fullBrakeLift: 2.2, fullBrakeDrag: 2.6, liftLagS: 0.15, dragLagS: 3.0, stallBrake: 0.95, stallSpeedShare: 0.55, stallHoldS: 1.0, stallCL: 0.25, stallCD: 1.1, turnDrag: 0.05, frontRiserLift: 0.6, frontRiserDrag: 0.2, rearRiserLift: 0.12, rearRiserDrag: 0.04, stowedBrake: 0.25, linesM: 6, swingDamping: 0.8 };
export interface Polar { cl(brake: number): number; cd(brake: number): number; fullFlightAirspeedMs: number }
export function polarFor(spec: CanopySpec): Polar;
// sim/canopy/canopy.ts
export interface CanopyEnv { rho: (yMslM: number) => number; wind: (pos: Vec3, tS: number) => Vec3; jumper: JumperParams }
export interface CanopyState {
  pos: Vec3; vel: Vec3; tS: number;
  bank: number; liftBrake: number; dragBrake: number; dive: number;
  stalled: boolean; deepFor: number; stowed: boolean;
  swingFore: number; swingForeRate: number; swingSide: number; swingSideRate: number; // jumper under the canopy, rad; fore + = jumper ahead
  brakeLeft: number; brakeRight: number; // the applied toggles, for the model and the debrief
}
export function createCanopyState(pos: Vec3, vel: Vec3, stowed: boolean): CanopyState;
export function stepCanopy(s: CanopyState, spec: CanopySpec, polar: Polar, input: CanopyInput, env: CanopyEnv, dt: number): void;
export function canopyHeadingRad(s: CanopyState, env: CanopyEnv): number; // heading of the air velocity
```

The five canopies (starting values from the prototype):

| id | name | ft² | cells | full flight | half brakes | bankMax | roll / out °/s | diveGain | build / recover s |
|---|---|---|---|---|---|---|---|---|---|
| student-280 | Student 280 | 280 | 9 | 20 mph, 650 fpm | 14 mph, 450 fpm | 30 | 45 / 60 | 0.9 | 4 / 3 |
| sport-210 | Sport 210 | 210 | 9 | 25, 850 | 17, 550 | 30 | 45 / 60 | 0.9 | 4 / 3 |
| sport-170 | Sport 170 | 170 | 9 | 29, 1,050 | 20, 650 | 35 | 45 / 60 | 0.7 | 4 / 3 |
| elliptical-150 | Elliptical 150 | 150 | 9 | 33, 1,300 | 23, 800 | 45 | 45 / 60 | 0.9 | 4 / 3 |
| reserve-220 | Reserve 220 | 220 | 7 | 22, 800 | 15, 560 | 30 | 40 / 60 | 0.7 | 4 / 2 |

**The polar.** From a target (speed V, sink w) at the reference mass and sea level: sin γ = w / V, CL = 2 m g cos γ / (ρ₀ S V²), CD = CL tan γ. Brake 0 is full flight, 0.5 is half brakes, 1 is (`fullBrakeLift` × CL_half, `fullBrakeDrag` × CD_half); linear in between. A heavier jumper flies the same coefficients faster: nothing else scales with mass.

**The step** (reference; this is the part the tests alone do not determine):

```
toggles: if stowed → brake L = R = stowedBrake and toggles ignored; unstow input → stowed = false (event)
sym  = min(L, R);  diff = R − L;  frontSym = min(FL, FR);  frontDiff = FR − FL
liftBrake → sym with lag liftLagS;  dragBrake → sym with lag dragLagS
bankTarget = clamp(diff + 0.8·frontDiff, −1, 1) · bankMax
bank moves toward bankTarget at rollRate when |bank| grows, at rollOut when it shrinks
dive → sin²(bank) with lag diveBuildS while growing, diveRecoverS while shrinking
va = vel − wind(pos, t);  V = |va|;  d = va / V;  q = ½ ρ V² S
stall: deepFor += dt while liftBrake ≥ stallBrake and V < stallSpeedShare · fullFlightAirspeed(at this mass and ρ), else 0;
       stalled once deepFor ≥ stallHoldS; unstalled when liftBrake < 0.5
CL = cl(liftBrake) · (1 − diveGain·dive) · (1 − frontRiserLift·frontSym) · (1 + rearRiserLift·rear)
CD = (cd(dragBrake) + turnDrag·|diff|) · (1 − frontRiserDrag·frontSym) · (1 + rearRiserDrag·rear)
if stalled: CL = stallCL, CD = stallCD
lift direction: l₀ = normalize(up − (up·d) d); r = d × l₀ (the right wing); l = l₀ cos(bank) + r sin(bank), so a positive bank turns right
force = q (CL · l − CD · d); vel += (force/m + gravity) dt; pos += vel dt
swing: a_fwd, a_side = the acceleration along and across the horizontal track;
       θ'' = −(g/linesM) sin θ − swingDamping θ' − (a_fwd/linesM) cos θ   (fore; braking swings the jumper ahead)
       φ'' likewise with a_side (side; a turn swings the jumper out)
```

The swing is an output for the camera and the canopy model; it does not feed back into the forces (prototyping showed the coupling did not change the outcomes).

- [ ] **Step 1: Failing tests** (sea level, 97 kg, calm, settled from full flight for 10 s first):
  - full flight and half brakes, every canopy: airspeed and sink within ±8 percent of the table;
  - **toggle turns**, the four mains: a full single toggle from full flight, released when the heading has changed by 90° (then 180°); altitude from toggle down until the canopy is back at trim (sink within 10 percent of trim and bank under 2°) within ±20 percent of 60/140, 95/225, 125/275 and 200/450 ft;
  - **turn rate:** holding a half toggle for 20 s, the yaw rate over the last 2 s is within 5 percent of g · tan(bank) / airspeed;
  - **deep brakes** (0.9 both, 30 s): slower than half brakes, sink 0.7 to 1.1 times the half-brake sink;
  - **stall:** full brakes (1.0) from full flight stall within 3 s; 8 s held then 6 s released loses at least 200 ft, and the canopy is back at trim within 8 s of the release;
  - **front risers** (both, full): sink 2.0 to 3.0 times trim and airspeed above full flight; **rear risers:** glide ratio 3 to 15 percent better and airspeed 2 to 10 percent lower;
  - **mass:** a 110 kg body on the Sport 210 flies faster and sinks more than 85 kg; 55 kg slower; all finite;
  - **stowed:** toggles change nothing until `unstow`; rear risers work while stowed;
  - **swing:** a flare stroke swings the jumper ahead by more than 10° at its peak; a full toggle turn swings the jumper out by more than 5°; in steady flight both settle under 1°.
- [ ] **Step 2: Run, fail. Step 3: Implement. Step 4: Run, pass.** If a target is missed, tune only the per-canopy spec values and `POLAR`, report the before and after, and stop if tuning one target breaks another.
- [ ] **Step 5: Commit** `feat(sim): five canopies, polar, brakes, turns, dive, stall, risers and swing`

---

### Task 14: The jump, part two: opening, canopy, flare and landing

**Files:**
- Create: `src/sim/landing.ts`
- Modify: `src/sim/Jump.ts`
- Test: `tests/sim/landing.test.ts`, `tests/sim/flare.test.ts`, extend `tests/sim/Jump.test.ts`

**Interfaces:**
- Consumes: Tasks 5, 12, 13.
- Produces:

```ts
// landing.ts
export type LandingOutcome = 'stand-up' | 'run-out' | 'slide' | 'plf' | 'sprain' | 'injury' | 'fatal';
export function classifyLanding(verticalMs: number, groundSpeedMs: number, plfInTime: boolean): LandingOutcome;
export const PLF_WINDOW_S = 0.4;
// Jump.ts additions
export interface Touchdown { tS: number; pos: Vec3; verticalMs: number; groundSpeedMs: number; airspeedMs: number; wind: Vec3; outcome: LandingOutcome }
class Jump { opening: Opening | null; canopy: CanopyState | null; canopySpec: CanopySpec; touchdown: Touchdown | null; maxOpeningG: number; aadFired: boolean; }
```

`JumpConfig.canopyId` becomes a `CanopyId`. `classifyLanding`, in this order: vertical > 9 → fatal; vertical > 5 or ground > 15 → injury; vertical ≥ 2.5 → `plf` if `plfInTime` else `sprain`; ground > 8 → slide; ground ≥ 5 → run-out; else stand-up. (The spec's table leaves 1.5 to 2.5 m/s at low ground speed open; reading it as a firm stand-up or run-out is this plan's call.)

The phases: `freefall` → (throw) `opening` → (`open`) `canopy` → (touchdown) `landing` → (`PLF_WINDOW_S` later, or at once when no PLF can matter) `landed`. Opening: the body keeps its freefall drag tilting to upright and adds `dragArea()` along the airflow plus `flightBlend()` × the canopy's force (the canopy state seeded from the jumper's velocity, brakes stowed); `stage` events per stage; the peak deceleration is kept as `maxOpeningG`. Canopy: `stepCanopy` with the chosen canopy or, after the AAD, `reserve-220`. **AAD:** in freefall below 750 ft with a vertical speed above 78 mph it fires once: `aad` event, a reserve `Opening`. **Touchdown:** when `heightAboveGround() ≤ 0` in any phase: `touchdown` event; in freefall or opening it is an `impact` and the outcome follows from the speeds. A PLF input counts if it came within `PLF_WINDOW_S` before or after the touchdown. `outcome` event at `landed`.

- [ ] **Step 1: Failing tests:**
  - `classifyLanding` for one case on each side of every boundary.
  - **Flare** (`tests/sim/flare.test.ts`; sea level, 97 kg, flat ground, settled full flight; the standard stroke: both toggles 0 → 0.5 over 0.3 s, then to 0.9 over 0.8 s, started at a height H): every main canopy has an H in 6 to 30 ft where touchdown is under 1.5 m/s vertical and under 8 m/s ground speed in calm air; for the Sport 170 such an H lies in 10 to 20 ft; at that best H the canopy's sink stays under 1 m/s for at least 1.5 s; started at 4 ft the touchdown is at least 55 percent of the full-flight sink and at least 0.5 m/s harder than at the best H (the slow student canopy keeps a little of the late stroke); started at 2 × best + 6 ft it lands at least 0.4 m/s harder than at the best H; the Sport 210 flared at its best H into a 4 m/s headwind is a `stand-up`.
  - **Full jump** (seed 1, flat ground 568 m, typical wind, exit 13,500 ft from `defaultExit`, neutral freefall, pull at 3,500 ft, unstow 3 s after `open`, a scripted pattern: hold the heading into the surface wind from 1,000 ft, the standard stroke at 12 ft): events in order exit, alarm ×2, pull, stage…, open, unstow, touchdown, outcome; freefall 55 to 65 s; opening from throw to `open` 3.7 to 5.2 s; the outcome is neither `injury` nor `fatal`.
  - **No pull:** the AAD fires between 700 and 800 ft and the reserve is `open` above 200 ft.
  - **Pull at 500 ft:** the opening (600 to 900 ft) cannot finish; the outcome is `injury` or `fatal`. A pull at 1,000 ft opens around 200 to 400 ft and lands.
  - **Inputs that do not apply:** toggles before unstowing change nothing; PLF in freefall changes nothing; replaying the input log reproduces the touchdown point to 1e-9.
- [ ] **Step 2: Run, fail. Step 3: Implement. Step 4: Run, pass.**
- [ ] **Step 5: Commit** `feat(sim): opening to landing, the AAD, flare and landing outcomes`

---

### Task 15: The debrief numbers and flags

**Files:**
- Create: `src/sim/debrief.ts`
- Test: `tests/sim/debrief.test.ts`

**Interfaces:**
- Consumes: Task 14.
- Produces:

```ts
export type DebriefFlag = 'low-turn' | 'late-pull' | 'no-pull' | 'downwind-landing' | 'hard-opening' | 'aad-fire' | 'impact';
export interface PatternTurn { startAglM: number; endAglM: number; headingChangeDeg: number }
export interface DebriefData {
  exitAltitudeAglM: number; freefallTimeS: number; deploymentAltitudeAglM: number | null;
  maxVerticalMs: number; avgVerticalMs: number;   // average from exit + 12 s to the throw
  maxOpeningG: number; canopyTimeS: number;
  patternTurns: PatternTurn[];                     // turns of more than 60° that end below 1,500 ft
  landing: null | { outcome: LandingOutcome; verticalMs: number; groundSpeedMs: number; distanceFromTargetM: number; bearingFromTargetDeg: number; windMs: number; windFromDeg: number };
  flags: DebriefFlag[];
}
export function computeDebrief(jump: Jump): DebriefData;
```

Turns come from the 10 Hz track under canopy: segments where the heading of the air velocity changes faster than 10°/s, joined across gaps under 1 s. **Low turn:** a segment of more than 90° whose lowest point is below 500 ft. **Late pull:** a throw more than 500 ft below `pullAltitudeFt`. **No pull:** the AAD fired or there was no throw. **Downwind landing:** a tailwind component above 1.5 m/s at touchdown. **Hard opening:** the plan was hard. **Impact:** touchdown in freefall or opening.

- [ ] **Step 1: Failing tests** on scripted jumps: the full jump of Task 14 gives a deployment altitude of 3,500 ft ±50, no flags and a landing distance under 1,500 m; a scripted 180° toggle turn started at 400 ft is flagged `low-turn` and listed in `patternTurns`; the no-pull jump is flagged `no-pull` and `aad-fire`; a landing flown downwind in the sporty preset is flagged `downwind-landing`.
- [ ] **Step 2: Run, fail. Step 3: Implement. Step 4: Run, pass.**
- [ ] **Step 5: Commit** `feat(sim): debrief numbers and flags`

---

### Task 16: Canopy controls

**Files:**
- Create: `src/ui/CanopyControls.ts`
- Modify: `src/style.css`
- Test: `tests/ui/CanopyControls.test.ts`

**Interfaces:**
- Consumes: Task 6.
- Produces:

```ts
export type CanopyScheme = 'toggles' | 'tilt-slider';
export class CanopyControls {
  constructor(root: HTMLElement, scheme: CanopyScheme, tilt: TiltSource | null);
  sample(): Pick<JumpInput, 'canopy' | 'plf'> & { lookUp: number };
  setPlfAvailable(on: boolean): void; // shows the PLF pill on touch-only devices below 30 ft
  show(on: boolean): void; dispose(): void;
}
```

The freefall Tilt scheme maps to `tilt-slider` under canopy and Touch to `toggles`. **Toggles:** the outer 30 percent of each side is that side's toggle: a finger dragged down pulls it by `toggleDepth`, letting go releases it; both together are the flare; a finger that first moves inward by 4 percent of the width and then down is that side's front riser; two fingers dragged up are the rear risers; both toggles past 0.3 within 0.5 s of each other unstow the brakes (once). **Tilt and slider:** roll banks (left toggle `max(0, −roll)`, right `max(0, roll)`, added to the slider), the slider at the bottom is symmetric brakes, a Fronts button held gives both front risers, an Unstow pill shows after the opening until tapped. In both schemes the phone tilted back looks up (`lookUp` 0 to 1 over 0 to −35° of pitch), and a quick roll (`isPlfRoll`) is the PLF; on devices without tilt the PLF pill does it.

- [ ] **Step 1: Failing tests (happy-dom):** a right-edge drag of 35 percent of the height gives `right = 1`, release gives 0; two edge drags give the flare; inward-then-down gives a front riser; both toggles past 0.3 within 0.5 s produce `unstow` once; in tilt-slider with a stubbed `TiltSource` at roll +25° and the slider at 0.4, `right` = 1 and `left` = 0.4; the PLF pill sets `plf` on one sample.
- [ ] **Step 2: Run, fail. Step 3: Implement. Step 4: Run, pass.**
- [ ] **Step 5: Commit** `feat(ui): canopy toggles, risers, tilt-and-slider and the PLF`

---

### Task 17: The canopy you look up at, the opening you feel, the sound under canopy

**Files:**
- Create: `src/render/CanopyModel.ts`
- Modify: `src/render/JumpCamera.ts`
- Test: `tests/render/CanopyModel.test.ts`, extend `tests/render/JumpCamera.test.ts`

**Interfaces:**
- Consumes: Tasks 8, 12, 13.
- Produces:

```ts
export class CanopyModel {
  constructor(spec: CanopySpec);
  readonly object: THREE.Object3D;   // origin at the jumper's risers; the wing 6 m above
  setPose(o: { headingRad: number; bank: number; swingFore: number; swingSide: number }): void;
  setInflation(inflation: number, slider: number): void; // 0 a bag-sized bundle, the snivel shape at 0.5, full at 1
  setBrakes(left: number, right: number): void;          // trailing edge pulled down up to 0.6 m outboard
  dispose(): void;
}
export function canopyEye(o: { pos: Vec3; headingRad: number; swingFore: number; swingSide: number; lookUp: number }): CameraPose; // forward 15° below the horizon, tipping with the swing; lookUp 1 = straight up the lines
export function openingEye(from: CameraPose, to: CameraPose, inflation: number): CameraPose; // the swing from looking down to looking ahead through the snivel
```

The wing: span from the area at aspect ratio 2.4 (9 cells, 2.0 for the 7-cell reserve), an arc of about 20° of anhedral, top and bottom skins with a bulge per cell and ribs between them, a darker underside, three cascades of lines to two risers, the slider and the brake lines; vertex colours or one small canvas texture; under 3,000 triangles. Colours per canopy (student blue and white, sport red and black, elliptical yellow and black, reserve white). The camera's shake follows the opening deceleration; the opening sounds follow the stages (`flutter` from line stretch, `snap` at inflation, `quiet` at open) and the canopy wind follows the airspeed.

- [ ] **Step 1: Failing tests:** `CanopyModel` builds under 3,000 triangles for every canopy; `setInflation(0)` shrinks its bounding box under 1 m and `setInflation(1)` gives a span within 10 percent of the computed one; `setBrakes(1, 0)` lowers the right trailing edge only; `canopyEye` looks 15° ±1° below the horizon along the heading at no swing and within 10° of straight up at `lookUp: 1`.
- [ ] **Step 2: Run, fail. Step 3: Implement. Step 4: Run, pass.**
- [ ] **Step 5: Commit** `feat(render): procedural canopy, canopy camera and the opening view`

---

### Task 18: Debrief screen and milestone 4 integration

**Files:**
- Create: `src/ui/DebriefScreen.ts`
- Modify: `src/app/JumpSession.ts`, `src/app/App.ts`, `src/main.ts`, `src/style.css`
- Test: `tests/ui/DebriefScreen.test.ts`, extend `tests/app/JumpSession.test.ts`

**Interfaces:**
- Consumes: everything above.
- Produces: `DebriefScreen` with `constructor(root, units)`, `show(data: DebriefData, o: { dzName: string; canopyName: string; lzRadiusM: number })`, `onAgain: (() => void) | null`.

The debrief: a one-line outcome in plain words ("Stand-up landing, 34 m from the target.", "PLF. Good roll.", "Sprained ankle: you landed at 3.1 m/s without a PLF."), the numbers with units (exit, freefall time, deployment altitude, max and average vertical speed, peak opening g, canopy time, the pattern turns with their altitudes, touchdown vertical and ground speed, wind at touchdown), the flags in plain sentences, an altitude-against-time line, and a top-down canvas of the ground track with the landing area circle, the target and a wind arrow. Jump again starts a new session with the next seed. The session now runs the whole jump: freefall controls until the throw, the opening view and sounds, the canopy model above the camera, canopy controls after `open`, the canopy wind, the touchdown, then the debrief. `?canopy=` takes the five ids (default `sport-210`); the AAD's reserve swaps the model.

- [ ] **Step 1: Failing tests:** `DebriefScreen.show` renders the outcome line, a flag sentence for `low-turn`, metres in a metre drop zone and feet in a feet one; the session test flies the scripted full jump of Task 14 through `JumpSession` with keyboard input and shows the debrief at the end.
- [ ] **Step 2: Run, fail. Step 3: Implement. Step 4: Run, pass;** `npm run build`.
- [ ] **Step 5: Commit** `feat(app): the whole jump, from the exit to the debrief`
- [ ] **Step 6 (Orchestrator): browser check, deploy and device pass.** A full jump at Interlaken in the visible pane with the keyboard; push; Shadi plays full jumps on both phones with both schemes, and his notes on the opening, the flare and the turns go into the milestone 5 plan. Append the execution notes to this plan.

---

## Self-review notes

- **Spec coverage, milestones 3 and 4:** the hill, freefall control, tracking, tumble and the target table (Tasks 3, 4); the altimeter and the audible (5, 8, 9); tilt and touch in both phases with the scheme choice and desktop keys (6, 7, 16); the pull (5, 7); the opening with its timeline, deceleration, altitude loss and hard openings (12); the AAD and the reserve (12, 14); the canopy with brakes, turns, dive and recovery, flare, stall, risers, swing and wing loading (13, 14); landing outcomes and the PLF (14); the debrief numbers and flags (15, 18); first-person canopy check by looking up (16, 17); the wind profile everything depends on (2); determinism and the input log (1, 5, 14). Deferred and said so above: malfunctions, line twists, cutaway, hazards and water, the logbook, desktop mouse, first-person arms, the spot UI (milestone 5).
- **Names across tasks:** `JumpInput`, `FreefallInput`, `CanopyInput`, `NEUTRAL_INPUT`, `SIM_DT`, `FixedStep`, `Wind`, `WindProfile`, `WIND_PRESETS`, `JumperParams`, `exitMassKg`, `bodyAreaScale`, `freefallForce`, `BodyFrame`, `FreefallState`, `stepFreefall`, `bodyFrame`, `airDirection`, `Audible`, `AudibleAlarm`, `defaultExit`, `Jump`, `JumpConfig`, `JumpEvent`, `TrackSample`, `Opening`, `planOpening`, `CanopySpec`, `CanopyId`, `CANOPIES`, `polarFor`, `CanopyState`, `stepCanopy`, `classifyLanding`, `computeDebrief`, `DebriefData`, `ControlScheme`, `CanopyScheme`, `TiltSource`, `CameraPose`, `freefallEye`, `canopyEye`, `JumpCamera`, `WristAltimeter`, `CanopyModel`, `JumpAudio`, `JumpSession`: each is defined once and used with the same signature.
- **Review Focus:** each line names its owning task and its test sits in that task's Step 1.
- **Proportion:** the reference pseudocode is limited to the attitude controller and the canopy step, the two places the spec names as the ones expected to bounce; the opening timeline is given as numbers. Everything else is signatures, values and assertions.
