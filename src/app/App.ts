/**
 * The application: renderer, scene, sky, terrain and the frame loop.
 *
 * The camera starts at the exit altitude above the drop zone, the sky is
 * painted by the computed sun and the ground streams in underneath it. The
 * world the terrain lives in is rebased around the camera, so the ground stays
 * in single precision no matter how far the camera has travelled.
 */

import * as THREE from 'three';
import { JumpAudio } from '@/audio/JumpAudio';
import { DEFAULT_CANOPY, type CanopyId } from '@/data/canopies';
import type { DropZone } from '@/data/dropzones';
import { Renderer } from '@/render/Renderer';
import { Atmosphere } from '@/render/Atmosphere';
import { Sky } from '@/render/Sky';
import { FloatingOrigin } from '@/render/FloatingOrigin';
import { FreeCamera } from '@/render/FreeCamera';
import { Terrain } from '@/render/terrain/Terrain';
import type { LodCamera } from '@/render/terrain/TerrainQuadtree';
import { DebugHud } from '@/ui/DebugHud';
import { StartScreen, type ControlScheme } from '@/ui/StartScreen';
import { Loop } from './Loop';
import { AdaptiveQuality, QUALITY, defaultTier } from './Quality';
import type { QualityTier } from './Quality';
import { JumpSession, type JumpHost } from './JumpSession';
import { clampBodyMass, DEFAULT_JUMPER } from '@/sim/jumper';
import { formatAltitude, formatSpeed } from '@/sim/units';
import { WIND_PRESETS, type WindProfile } from '@/sim/wind';
import { localDayInZone, localTimeToDate, sunDirectionLocal } from '@/world/sun';
import { LocalFrame } from '@/world/geo';
import { ElevationGrid } from '@/world/ElevationGrid';
import { TileCache } from '@/world/TileCache';

export interface AppOptions {
  /** The drop zone: where it is, its time zone and its exit altitude. */
  dz: DropZone;
  /** The hour of the day, local to the drop zone. */
  hourLocal: number;
  /** Developer overlay and console logging. */
  debug: boolean;
  /** Quality tier. A given tier is locked; without one the tier adapts. */
  quality?: QualityTier;
  /** Plan 1's free camera, with no jump: the camera flies on its own. */
  free?: boolean;
  /** The wind over the drop zone. */
  wind?: WindProfile;
  /** The body mass of the jumper, in kilograms. */
  bodyMassKg?: number;
  /** The canopy the jumper flies. */
  canopyId?: CanopyId;
  /** The seed of the jump. */
  seed?: number;
}

/** One thousand feet: the low pass over the drop zone. */
const LOW_ALTITUDE_M = 305;

/** The height above the ground the camera keeps, in metres. */
const MIN_CLEARANCE_M = 2;

/** Vertical field of view, in degrees. */
const FOV_DEG = 60;

/** Near and far planes, in metres. The horizon is over 200 km away. */
const NEAR_M = 1;
const FAR_M = 600000;

/**
 * The near and far planes of the overlay, in metres.
 *
 * The watch on the wrist is a third of a metre from the eye, which the
 * near plane of the world would cut away, so the instruments are drawn in
 * a pass of their own with a near plane of its own.
 */
const OVERLAY_NEAR_M = 0.01;
const OVERLAY_FAR_M = 10;

/** How many tiles may still be on their way before the jump is offered. */
const READY_PENDING_TILES = 15;

/** How long the app waits for the ground before it offers the jump anyway. */
const READY_TIMEOUT_MS = 20000;

/** Downward tilt of the parked camera, in radians. */
const START_PITCH_RAD = -Math.PI / 4;

/** Downward tilt at the exit, in radians: sixty degrees below the horizon. */
const EXIT_PITCH_RAD = -Math.PI / 3;

/** How often the overlay is refreshed, in milliseconds. */
const HUD_INTERVAL_MS = 100;

/**
 * The frames the refresh interval of the display is measured over.
 *
 * The first frames are the loading of the ground and the first hitch, so
 * the measurement starts once the app has settled and stops before it has
 * been running long enough to have met a hitch of its own.
 */
const REFRESH_FIRST_FRAME = 30;
const REFRESH_LAST_FRAME = 90;

/** How many tiles may be on their way before the adaptation waits for them. */
const PENDING_TILE_LIMIT = 20;

/** The window the mean terrain update time is taken over, in milliseconds. */
const UPDATE_WINDOW_MS = 1000;

/**
 * The tiles the cache keeps: enough for a flight without a stall.
 *
 * A decoded tile is 256 KB of pixels or of heights, so this is the RAM of
 * the phone: 512 tiles are 128 MB at the worst, and half of what the cache
 * held before.
 */
const CACHE_ENTRIES = 512;

/**
 * The zoom at which the ground under the landing area is good enough to
 * place the exit pose.
 *
 * A zoom-10 height tile is about a hundred metres across here: close
 * enough to say how high the drop zone is, and coarse enough that the
 * camera does not chase the noise of the height data.
 */
const EXIT_SAMPLE_ZOOM = 10;

export class App implements JumpHost {
  readonly renderer: Renderer;
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;

  /** The scene and the camera of the first-person instruments. */
  readonly overlay: { scene: THREE.Scene; camera: THREE.PerspectiveCamera };

  readonly atmosphere: Atmosphere;
  readonly sky: Sky;
  readonly loop: Loop;

  /** The camera you fly with. */
  readonly freeCamera: FreeCamera;

  /** The tier of the app, and the watch on the frame times. */
  readonly quality: AdaptiveQuality;

  /** The world the terrain lives in; the floating origin moves it. */
  readonly world: THREE.Group;

  /** The rebasing of the world around the camera. */
  readonly floatingOrigin: FloatingOrigin;

  /** The streamed ground. */
  readonly terrain: Terrain;

  /** The local tangent frame of the drop zone, in metres. */
  readonly localFrame: LocalFrame;

  /** The heights that have arrived. */
  readonly elevation: ElevationGrid;

  /** The tile fetcher. */
  readonly cache: TileCache;

  /** The instant the sun was computed for. */
  readonly sunDate: Date;

  /** The window the app is in. */
  readonly window: Window = globalThis.window;

  /** Where the controls and the cards of the app go. */
  readonly uiRoot: HTMLElement;

  /** True when the developer overlay is on. */
  readonly debug: boolean;

  /** The height of the landing area above mean sea level, in metres. */
  lzGroundY = 0;

  private readonly canvas: HTMLCanvasElement;

  private readonly options: AppOptions;

  /** True when the app flies Plan 1's free camera, with no jump. */
  private readonly freeMode: boolean;

  /** The screen before the jump, when the app is flying a jump. */
  private readonly startScreen: StartScreen | null;

  /** The jump in progress, when there is one. */
  private session: JumpSession | null = null;

  /** The sound of the jump, made when the jumper taps the button. */
  audio?: JumpAudio;

  /** The seed of the jump, and the one of the next jump after it. */
  private nextSeed: number;

  /** The developer overlay, when the app was started in debug mode. */
  private readonly hud: DebugHud | null = null;

  /** Scratch: the view direction of the camera, in world space. */
  private readonly viewDirection = new THREE.Vector3();

  /** Scratch: the size of the drawing buffer, in pixels. */
  private readonly bufferSize = new THREE.Vector2();

  private lastDebugAt = 0;

  private lastHudAt = 0;

  /** The mean duration of the terrain update over the last second. */
  private updateMsAvg = 0;

  /** How long each terrain update took, with the time it happened. */
  private readonly updateSamples: { t: number; ms: number }[] = [];

  /** How many frames have gone by since the app started. */
  private frameCount = 0;

  /** The intervals of the frames the refresh is measured over, in ms. */
  private readonly frameIntervals: number[] = [];

  /** True once the refresh of the display has been measured and handed over. */
  private refreshMeasured = false;

  /** True while the overlay is showing the lines of a jump. */
  private jumpLinesShown = false;

  /** When the app started, on the clock of the frame loop. */
  private readonly startedAt = performance.now();

  /**
   * The zoom of the elevation the exit pose was placed from, -1 for none.
   *
   * The exit pose is placed again for every finer sample of the ground, so
   * the camera settles onto the ground as the ground is known better.
   */
  private exitSampleZoom = -1;

  constructor(canvas: HTMLCanvasElement, opts: AppOptions) {
    this.canvas = canvas;
    this.options = opts;
    this.debug = opts.debug;
    this.freeMode = opts.free === true;
    this.nextSeed = opts.seed ?? Math.floor(Math.random() * 0x7fffffff);

    // The tier the app starts on: the one that was asked for, or the one the
    // device can be trusted with. A phone is never trusted with the high
    // tier: it is the tier of a desktop.
    const tier =
      opts.quality ??
      defaultTier(this.devicePixelRatio(), this.cores(), navigator.maxTouchPoints || 0);
    this.quality = new AdaptiveQuality(tier);
    // A tier that was asked for is the tier that stays.
    this.quality.locked = opts.quality !== undefined;

    this.renderer = new Renderer(canvas);
    this.renderer.setPixelRatioCap(QUALITY[tier].maxPixelRatio);

    this.scene = new THREE.Scene();

    this.atmosphere = new Atmosphere();
    this.sky = new Sky(this.atmosphere);
    this.scene.add(this.sky.mesh);

    this.camera = new THREE.PerspectiveCamera(FOV_DEG, 1, NEAR_M, FAR_M);

    // The instruments of the first person: the watch on the wrist, drawn in
    // a pass of its own, because the camera of the world has a near plane
    // a metre away and the watch is a third of a metre from the eye.
    this.overlay = {
      scene: new THREE.Scene(),
      camera: new THREE.PerspectiveCamera(FOV_DEG, 1, OVERLAY_NEAR_M, OVERLAY_FAR_M),
    };

    // The world the terrain lives in. The floating origin moves it, so the
    // ground keeps its place while the camera stays near the origin.
    this.world = new THREE.Group();
    this.scene.add(this.world);
    this.floatingOrigin = new FloatingOrigin(this.world);

    // The terrain fetches its own tiles: the cache brings them, the grid
    // holds the heights and the terrain drapes the meshes over them.
    this.localFrame = new LocalFrame(opts.dz.lz);
    this.elevation = new ElevationGrid(this.localFrame);
    this.cache = new TileCache({ maxEntries: CACHE_ENTRIES });
    this.terrain = new Terrain(
      this.world,
      this.localFrame,
      { x: 0, z: 0 },
      this.elevation,
      this.cache,
      this.atmosphere,
      {
        tau: QUALITY[tier].tau,
        anisotropy: Math.min(
          QUALITY[tier].anisotropy,
          this.renderer.gl.capabilities.getMaxAnisotropy(),
        ),
        maxTextures: QUALITY[tier].maxTextures,
        maxVisibleTiles: QUALITY[tier].maxLeaves,
      },
    );

    // The camera you fly with. Its position is the one in the scene, so the
    // ground is sampled with the rebasing put back in.
    this.freeCamera = new FreeCamera(this.camera, this.canvas, (x, z) =>
      this.elevation.groundY(
        x + this.floatingOrigin.offset.x,
        z + this.floatingOrigin.offset.z,
      ),
    );
    // The camera parks at the exit height, looking down, until the ground
    // under the landing area is known: the exit is a height above it.
    this.freeCamera.setPose(0, exitAltitudeM(opts.dz), 0, 0, START_PITCH_RAD);

    // The sun, for today in the drop zone's own time zone.
    this.sunDate = localTimeToDate(
      opts.dz.lz,
      opts.dz.timeZone,
      localDayInZone(opts.dz.timeZone),
      opts.hourLocal,
    );
    this.atmosphere.setSun(sunDirectionLocal(this.sunDate, opts.dz.lz));
    this.atmosphere.setCameraY(this.camera.position.y);

    this.loop = new Loop((dt, now) => {
      this.frame(dt, now);
    });

    // The layer the controls and the cards go on.
    this.uiRoot = document.querySelector<HTMLElement>('#ui') ?? this.makeUiRoot();

    // The screen before the jump, over the parked camera.
    if (this.freeMode) {
      this.startScreen = null;
    } else {
      this.startScreen = new StartScreen(this.uiRoot, {
        dzName: opts.dz.name,
        units: opts.dz.units,
      });
      this.startScreen.onJump = (scheme) => this.startJump(scheme);
      this.wireAudioGesture();
    }

    // The debug handle: the terrain and the frame timings are one console
    // line away, without a build of the app.
    if (opts.debug) {
      (window as unknown as { __boogie?: unknown }).__boogie = this;

      // The camera buttons are the developer's: they stay hidden otherwise.
      const buttons = document.querySelector<HTMLElement>('#camera-buttons');
      if (buttons) buttons.removeAttribute('hidden');

      this.hud = new DebugHud(this.uiRoot);
      this.hud.show(true);
    }

    this.wireButtons();

    this.resize();
    window.addEventListener('resize', this.onResize);
  }

  /** The layer the app draws its own things on, when the page has none. */
  private makeUiRoot(): HTMLElement {
    const root = document.createElement('div');
    root.id = 'ui';
    document.body.appendChild(root);
    return root;
  }

  /**
   * Starts the sound of the jump from the tap on the jump button.
   *
   * The browser only lets a context make a noise inside the gesture of the
   * tap, so the context is made and started here, in the capture phase of
   * the click, before the start screen asks for anything.
   */
  private wireAudioGesture(): void {
    this.uiRoot.addEventListener(
      'click',
      (event) => {
        const target = event.target as Element | null;
        if (!target?.closest?.('[data-action="jump"]')) return;
        void this.ensureAudio().resume();
      },
      true,
    );
  }

  /** The sound of the jump, made the first time it is needed. */
  private ensureAudio(): JumpAudio {
    this.audio ??= new JumpAudio();
    return this.audio;
  }

  /** Start the frame loop. */
  start(): void {
    this.loop.start();
  }

  /** Stop the frame loop. */
  stop(): void {
    this.loop.stop();
  }

  private frame(dt: number, now: number): void {
    // The frames are counted from the first one, and the interval of the
    // display is measured over the frames in the middle of them.
    this.frameCount += 1;
    this.measureRefresh(dt);

    // The jump comes first: it samples the controls, moves the simulation
    // and puts the camera where the jumper's eye is.
    if (this.session) {
      this.session.frame(dt);
    } else {
      // The camera flies.
      this.freeCamera.update(dt);
    }

    // The world is rebased first: everything after it works with the camera's
    // true position in the local frame.
    this.floatingOrigin.update(this.camera);

    const started = performance.now();
    this.terrain.update(this.lodCamera(this.floatingOrigin.truePosition(this.camera)));
    this.measureUpdate(performance.now() - started, now);

    if (!this.session) {
      // The exit pose waits for the ground: the camera is put at the exit
      // height above the landing area, and put there again for every finer
      // sample of the ground under it.
      this.placeAtExit();
      this.updateReadiness(now);
    }

    this.sky.update(this.camera.position);
    this.atmosphere.setCameraY(this.camera.position.y);
    this.renderer.render(this.scene, this.camera);

    // The instruments of the first person go over the world.
    if (this.session) this.renderer.renderOverlay(this.overlay.scene, this.overlay.camera);

    // The tier watches the frame times: a phone that cannot keep up gives
    // up the sharpness of the ground instead of the smoothness of the flight.
    // The ground that is still on its way is not evidence of a slow machine:
    // the adaptation waits for the loading to be over.
    this.quality.hold(this.terrain.stats().pending > PENDING_TILE_LIMIT);
    const changed = this.quality.pushFrame(this.loop.stats().frameMs, now);
    if (changed) this.applyTier(changed);

    if (this.options.debug) {
      this.updateHud(now);

      // The console line is the fallback for a page without the overlay.
      if (!this.hud && now - this.lastDebugAt > 1000) {
        this.lastDebugAt = now;
        const stats = this.loop.stats();
        const info = this.renderer.info();
        const tiles = this.terrain.stats();
        console.info(
          `[boogie] ${stats.fps.toFixed(0)} fps, ${stats.frameMs.toFixed(1)} ms, ` +
            `${info.calls} calls, ${info.triangles} triangles, ` +
            `tiles ${tiles.visible}/${tiles.desired} shown, ${tiles.pending} pending, ` +
            `update ${this.updateMsAvg.toFixed(1)} ms, ` +
            `camera ${this.camera.position.y.toFixed(0)} m, ` +
            `sun ${this.atmosphere.uniforms.uSunDir.value.toArray().map((n) => n.toFixed(2)).join(', ')}`,
        );
      }
    }
  }

  /**
   * Measure the refresh interval of the display and hand it to the tier.
   *
   * The interval is the median of the frames from the thirtieth to the
   * ninetieth: the first frames are the loading of the ground and the last
   * ones may have met a hitch, and the median of the middle is the honest
   * number. It is measured once; until it is, the tier keeps its fixed
   * threshold.
   */
  private measureRefresh(dt: number): void {
    if (this.refreshMeasured) return;
    if (this.frameCount < REFRESH_FIRST_FRAME) return;

    this.frameIntervals.push(dt * 1000);
    if (this.frameCount < REFRESH_LAST_FRAME) return;

    this.refreshMeasured = true;
    this.quality.setRefreshIntervalMs(median(this.frameIntervals));
  }

  /**
   * Show what the app is doing.
   *
   * The numbers of the old console line and the new ones: the tier, the
   * screen, the tiles and where the camera is.
   */
  private updateHud(now: number): void {
    const hud = this.hud;
    if (!hud) return;
    if (now - this.lastHudAt < HUD_INTERVAL_MS) return;
    this.lastHudAt = now;

    const stats = this.loop.stats();
    const info = this.renderer.info();
    const tiles = this.terrain.stats();
    const truePosition = this.floatingOrigin.truePosition(this.camera);
    const lonLat = this.localFrame.toLonLat(truePosition.x, truePosition.z);

    hud.set({
      fps: stats.fps.toFixed(0),
      ms: stats.frameMs.toFixed(1),
      tier: this.quality.tier,
      dpr: this.devicePixelRatio().toFixed(2),
      tiles: `${tiles.visible}/${tiles.desired} shown, ${tiles.pending} pending`,
      calls: info.calls,
      tris: info.triangles,
      msl: `${this.camera.position.y.toFixed(0)} m`,
      agl: `${this.freeCamera.agl.toFixed(0)} m`,
      lon: lonLat.lon.toFixed(5),
      lat: lonLat.lat.toFixed(5),
      update: `${this.updateMsAvg.toFixed(1)} ms`,
      sun: this.atmosphere.uniforms.uSunDir.value
        .toArray()
        .map((n) => n.toFixed(2))
        .join(', '),
    });

    // The lines of the jump: where the jumper is and what they are doing.
    const session = this.session;
    if (session) {
      const jump = session.jump;
      const units = this.options.dz.units;
      hud.set({
        phase: jump.phase,
        agl: formatAltitude(jump.altitudeAglM(), units),
        vspeed: formatSpeed(-jump.velocity().y, units),
        fallRate: session.input.freefall.fallRate.toFixed(2),
        heading: `${((session.headingRad * 180) / Math.PI).toFixed(0)}°`,
      });
      this.jumpLinesShown = true;
    } else if (this.jumpLinesShown) {
      // The jump is over: the lines of the jump are emptied, so nothing
      // stale is left on the screen.
      hud.set({
        phase: '-',
        agl: `${this.freeCamera.agl.toFixed(0)} m`,
        vspeed: '-',
        fallRate: '-',
        heading: '-',
      });
      this.jumpLinesShown = false;
    }
  }

  /**
   * Says whether the ground under the landing area is ready for a jump.
   *
   * The jump is offered when the ground under the landing area is known at
   * zoom ten or finer and the tiles have nearly all arrived, or after
   * twenty seconds, when the ground is good enough to jump over even if it
   * is not complete.
   */
  private updateReadiness(now: number): void {
    const screen = this.startScreen;
    if (!screen) return;

    const sample = this.elevation.sample(this.options.dz.lz);
    if (sample) this.lzGroundY = sample.height;

    const pending = this.terrain.stats().pending;
    const groundKnown = sample !== null && sample.zoom >= EXIT_SAMPLE_ZOOM;
    const waited = now - this.startedAt >= READY_TIMEOUT_MS;
    const ready = (groundKnown && pending < READY_PENDING_TILES) || waited;

    screen.setLoading(ready ? null : `Loading the ground: ${pending} tiles to go`);
    screen.setReady(ready);
  }

  /**
   * The jump begins.
   *
   * The tap on the jump button is the gesture the browser wants before the
   * sound may start, so the sound is started here as well as in the
   * gesture itself.
   */
  private startJump(scheme: ControlScheme): void {
    if (this.session) return;

    void this.ensureAudio().resume();

    // The free camera has had its turn: the jumper's eye is in the scene
    // now, and the fingers of the free camera must not move it.
    this.freeCamera.dispose();

    const session = new JumpSession(this, {
      dz: this.options.dz,
      jumper: {
        bodyMassKg: clampBodyMass(this.options.bodyMassKg ?? DEFAULT_JUMPER.bodyMassKg),
        gearMassKg: DEFAULT_JUMPER.gearMassKg,
      },
      wind: this.options.wind ?? WIND_PRESETS.typical,
      canopyId: this.options.canopyId ?? DEFAULT_CANOPY,
      seed: this.nextSeed,
      scheme,
    });
    session.onEnd = () => this.endJump();
    this.session = session;

    // The goggle vignette goes on with the jump.
    document.querySelector('#vignette')?.removeAttribute('hidden');
    this.startScreen?.show(false);
  }

  /** The jump is over: the session is let go and the start screen comes back. */
  private endJump(): void {
    this.session?.dispose();
    this.session = null;
    // The next jump is a different jump: the seed moves on.
    this.nextSeed = (this.nextSeed + 1) % 0x7fffffff;
    // The camera goes back to the exit, over the landing area.
    this.exitSampleZoom = -1;
    document.querySelector('#vignette')?.setAttribute('hidden', '');
    this.startScreen?.setLoading(null);
    this.startScreen?.show(true);
  }

  /** Where the world has been rebased to, in metres. */
  originOffset(): { x: number; z: number } {
    return { x: this.floatingOrigin.offset.x, z: this.floatingOrigin.offset.z };
  }

  /** The height of the ground at a place in the local frame, in metres. */
  groundY(x: number, z: number): number {
    return this.elevation.groundY(x, z);
  }

  /**
   * Take the tier the app is on.
   *
   * The renderer draws fewer pixels, the terrain is less sharp, the imagery
   * is filtered less and there are fewer tiles of ground on screen.
   */
  private applyTier(tier: QualityTier): void {
    const settings = QUALITY[tier];
    this.renderer.setPixelRatioCap(settings.maxPixelRatio);
    this.terrain.setTau(settings.tau);
    this.terrain.setAnisotropy(
      Math.min(settings.anisotropy, this.renderer.gl.capabilities.getMaxAnisotropy()),
    );
    this.terrain.setMaxTextures(settings.maxTextures);
    this.terrain.setMaxVisibleTiles(settings.maxLeaves);
  }

  /**
   * Put the camera at the exit height above the landing area.
   *
   * The exit is a height above the ground, so the ground has to be known
   * first: the elevation under the landing area is asked for every frame
   * until it arrives, and the camera is put at the exit when the ground is
   * known well enough. The pose is placed again for every finer sample, so
   * the camera settles onto the ground as the ground is known better.
   *
   * The user has the last word: once they have moved the camera, it is
   * theirs and the app leaves it alone.
   */
  private placeAtExit(): void {
    if (this.freeCamera.userMoved) return;

    const sample = this.elevation.sample(this.options.dz.lz);
    if (!sample) return;
    if (sample.zoom < EXIT_SAMPLE_ZOOM) return;
    if (sample.zoom <= this.exitSampleZoom) return;

    this.exitSampleZoom = sample.zoom;
    this.goto(sample.height + exitAltitudeM(this.options.dz), EXIT_PITCH_RAD);
  }

  /**
   * The buttons of the overlay: the exit altitude, the low pass and the
   * ground, all above the landing area.
   *
   * The exit is the drop zone's own exit height, and the buttons say so in
   * the units of the drop zone.
   */
  private wireButtons(): void {
    const units = this.options.dz.units;

    const exit = document.querySelector<HTMLButtonElement>('#pose-exit');
    if (exit) exit.textContent = formatAltitude(exitAltitudeM(this.options.dz), units);

    const low = document.querySelector<HTMLButtonElement>('#pose-low');
    if (low) low.textContent = formatAltitude(LOW_ALTITUDE_M, units);

    for (const button of document.querySelectorAll<HTMLButtonElement>('#ui button[data-pose]')) {
      const pose = button.dataset.pose;
      button.addEventListener('click', () => {
        // The poses are heights above the landing area, so the ground under
        // it is read at the moment of the click.
        const ground = this.elevation.groundY(0, 0);
        if (pose === 'exit') {
          this.goto(ground + exitAltitudeM(this.options.dz), -Math.PI / 3);
        } else if (pose === 'low') {
          this.goto(ground + LOW_ALTITUDE_M, -Math.PI / 6);
        } else {
          this.goto(ground + MIN_CLEARANCE_M, 0);
        }
      });
    }
  }

  /**
   * Put the camera above the landing area, at a height and a tilt.
   *
   * The landing area is the origin of the local frame, and the camera's own
   * position is relative to the floating origin.
   */
  private goto(altitudeM: number, pitch: number): void {
    this.freeCamera.setPose(
      -this.floatingOrigin.offset.x,
      altitudeM,
      -this.floatingOrigin.offset.z,
      0,
      pitch,
    );
  }

  /** The density of the screen. */
  private devicePixelRatio(): number {
    return window.devicePixelRatio || 1;
  }

  /** The number of cores the browser says the device has. */
  private cores(): number {
    return navigator.hardwareConcurrency || 4;
  }

  /**
   * Keep the mean duration of the terrain update over the last second.
   *
   * The window slides: every update is kept with the time it happened, the
   * ones that fall out of the window are dropped, and the mean of what is
   * left is the number the overlay shows. The average is therefore there
   * from the first frame on, instead of only after a whole window has
   * passed.
   */
  private measureUpdate(elapsedMs: number, now: number): void {
    this.updateSamples.push({ t: now, ms: elapsedMs });

    const cutoff = now - UPDATE_WINDOW_MS;
    while (this.updateSamples.length > 0 && (this.updateSamples[0]?.t ?? 0) < cutoff) {
      this.updateSamples.shift();
    }

    let total = 0;
    for (const sample of this.updateSamples) total += sample.ms;
    this.updateMsAvg = this.updateSamples.length > 0 ? total / this.updateSamples.length : 0;
  }

  /**
   * The camera as the terrain sees it: where it really is, where it looks and
   * how many pixels a texel has to cover.
   */
  private lodCamera(truePosition: { x: number; y: number; z: number }): LodCamera {
    this.camera.getWorldDirection(this.viewDirection);

    // The focal length in pixels, and the half of the diagonal field of view.
    const size = this.renderer.gl.getDrawingBufferSize(this.bufferSize);
    const focalPx = size.y / (2 * Math.tan((this.camera.fov * Math.PI) / 360));
    const halfAngleRad = Math.atan(Math.hypot(size.x, size.y) / (2 * focalPx));

    return {
      x: truePosition.x,
      y: truePosition.y,
      z: truePosition.z,
      focalPx,
      dir: {
        x: this.viewDirection.x,
        y: this.viewDirection.y,
        z: this.viewDirection.z,
      },
      halfAngleRad,
    };
  }

  private readonly onResize = (): void => {
    this.resize();
  };

  private resize(): void {
    this.renderer.resize();
    const width = this.canvas.clientWidth || window.innerWidth || 1;
    const height = this.canvas.clientHeight || window.innerHeight || 1;
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    // The overlay is drawn with the same view of the world, so it has the
    // same shape of picture.
    this.overlay.camera.aspect = width / height;
    this.overlay.camera.updateProjectionMatrix();
  }
}

/**
 * The exit altitude of a drop zone, in metres.
 *
 * The drop zone gives its exit height in feet, the world in metres.
 */
function exitAltitudeM(dz: { exitAltitudeFt: number }): number {
  return dz.exitAltitudeFt * 0.3048;
}

/**
 * The median of a list of numbers: the middle one, or the mean of the two
 * middle ones when the count is even.
 */
function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  if (sorted.length % 2 === 1) return sorted[middle] ?? 0;
  const lower = sorted[middle - 1] ?? 0;
  const upper = sorted[middle] ?? 0;
  return (lower + upper) / 2;
}
