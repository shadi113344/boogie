/**
 * The application: renderer, scene, sky, terrain and the frame loop.
 *
 * The camera starts at the exit altitude above the drop zone, the sky is
 * painted by the computed sun and the ground streams in underneath it. The
 * world the terrain lives in is rebased around the camera, so the ground stays
 * in single precision no matter how far the camera has travelled.
 */

import * as THREE from 'three';
import { Renderer } from '@/render/Renderer';
import { Atmosphere } from '@/render/Atmosphere';
import { Sky } from '@/render/Sky';
import { FloatingOrigin } from '@/render/FloatingOrigin';
import { FreeCamera } from '@/render/FreeCamera';
import { Terrain } from '@/render/terrain/Terrain';
import type { LodCamera } from '@/render/terrain/TerrainQuadtree';
import { DebugHud } from '@/ui/DebugHud';
import { Loop } from './Loop';
import { AdaptiveQuality, QUALITY, defaultTier } from './Quality';
import type { QualityTier } from './Quality';
import { localDayInZone, localTimeToDate, sunDirectionLocal } from '@/world/sun';
import { LocalFrame } from '@/world/geo';
import type { LonLat } from '@/world/geo';
import { ElevationGrid } from '@/world/ElevationGrid';
import { TileCache } from '@/world/TileCache';

export interface AppOptions {
  /** The drop zone: where it is, its time zone and its exit altitude. */
  dz: { lz: LonLat; timeZone: string; exitAltitudeFt: number };
  /** The hour of the day, local to the drop zone. */
  hourLocal: number;
  /** Developer overlay and console logging. */
  debug: boolean;
  /** Quality tier. A given tier is locked; without one the tier adapts. */
  quality?: QualityTier;
}

/**
 * The exit height: 13,500 ft. The camera parks at it above mean sea level
 * while it waits for the ground, and the exit button puts it at that height
 * above the landing area.
 */
const EXIT_ALTITUDE_M = 4115;

/** One thousand feet: the low pass over the drop zone. */
const LOW_ALTITUDE_M = 305;

/** The height above the ground the camera keeps, in metres. */
const MIN_CLEARANCE_M = 2;

/** Vertical field of view, in degrees. */
const FOV_DEG = 60;

/** Near and far planes, in metres. The horizon is over 200 km away. */
const NEAR_M = 1;
const FAR_M = 600000;

/** Downward tilt of the parked camera, in radians. */
const START_PITCH_RAD = -Math.PI / 4;

/** Downward tilt at the exit, in radians: sixty degrees below the horizon. */
const EXIT_PITCH_RAD = -Math.PI / 3;

/** How often the overlay is refreshed, in milliseconds. */
const HUD_INTERVAL_MS = 100;

/** The tiles the cache keeps: enough for a flight without a stall. */
const CACHE_ENTRIES = 1024;

export class App {
  readonly renderer: Renderer;
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
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

  private readonly canvas: HTMLCanvasElement;

  private readonly options: AppOptions;

  /** The developer overlay, when the app was started in debug mode. */
  private readonly hud: DebugHud | null = null;

  /** Scratch: the view direction of the camera, in world space. */
  private readonly viewDirection = new THREE.Vector3();

  /** Scratch: the size of the drawing buffer, in pixels. */
  private readonly bufferSize = new THREE.Vector2();

  private lastDebugAt = 0;

  private lastHudAt = 0;

  /** The time the terrain update took, summed over the current window. */
  private updateMsTotal = 0;

  /** The number of terrain updates in the current window. */
  private updateMsCount = 0;

  /** The mean duration of the terrain update over the last second. */
  private updateMsAvg = 0;

  /** When the current window began, in frame time. */
  private updateWindowStart = Number.NaN;

  /** Whether the camera has been put at the exit height above the ground. */
  private atExit = false;

  constructor(canvas: HTMLCanvasElement, opts: AppOptions) {
    this.canvas = canvas;
    this.options = opts;

    // The tier the app starts on: the one that was asked for, or the one the
    // device can be trusted with.
    const tier = opts.quality ?? defaultTier(this.devicePixelRatio(), this.cores());
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
    this.freeCamera.setPose(0, EXIT_ALTITUDE_M, 0, 0, START_PITCH_RAD);

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

    // The debug handle: the terrain and the frame timings are one console
    // line away, without a build of the app.
    if (opts.debug) {
      (window as unknown as { __boogie?: unknown }).__boogie = this;

      // The camera buttons are the developer's: they stay hidden otherwise.
      const buttons = document.querySelector<HTMLElement>('#camera-buttons');
      if (buttons) buttons.removeAttribute('hidden');

      const ui = document.querySelector<HTMLElement>('#ui');
      if (ui) {
        this.hud = new DebugHud(ui);
        this.hud.show(true);
      }
    }

    this.wireButtons();

    this.resize();
    window.addEventListener('resize', this.onResize);
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
    // The world is rebased first: everything after it works with the camera's
    // true position in the local frame.
    this.floatingOrigin.update(this.camera);

    // The camera flies.
    this.freeCamera.update(dt);

    const started = performance.now();
    this.terrain.update(this.lodCamera(this.floatingOrigin.truePosition(this.camera)));
    this.measureUpdate(performance.now() - started, now);

    // The exit pose waits for the ground: the camera is put at the exit
    // height above the landing area, once the elevation under it has arrived.
    this.placeAtExit();

    this.sky.update(this.camera.position);
    this.atmosphere.setCameraY(this.camera.position.y);
    this.renderer.render(this.scene, this.camera);

    // The tier watches the frame times: a phone that cannot keep up gives
    // up the sharpness of the ground instead of the smoothness of the flight.
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
  }

  /**
   * Take the tier the app is on.
   *
   * The renderer draws fewer pixels, the terrain is less sharp and the
   * imagery is filtered less.
   */
  private applyTier(tier: QualityTier): void {
    const settings = QUALITY[tier];
    this.renderer.setPixelRatioCap(settings.maxPixelRatio);
    this.terrain.setTau(settings.tau);
    this.terrain.setAnisotropy(
      Math.min(settings.anisotropy, this.renderer.gl.capabilities.getMaxAnisotropy()),
    );
    this.terrain.setMaxTextures(settings.maxTextures);
  }

  /**
   * Put the camera at the exit height above the landing area.
   *
   * The exit is a height above the ground, so the ground has to be known
   * first: the elevation under the landing area is asked for every frame
   * until it arrives, and the camera is put at the exit once, when it does.
   */
  private placeAtExit(): void {
    if (this.atExit) return;

    const sample = this.elevation.sample(this.options.dz.lz);
    if (!sample) return;

    this.atExit = true;
    this.goto(sample.height + exitAltitudeM(this.options.dz), EXIT_PITCH_RAD);
  }

  /**
   * The buttons of the overlay: the exit altitude, the low pass and the
   * ground, all above the landing area.
   */
  private wireButtons(): void {
    for (const button of document.querySelectorAll<HTMLButtonElement>('#ui button[data-pose]')) {
      const pose = button.dataset.pose;
      button.addEventListener('click', () => {
        // The poses are heights above the landing area, so the ground under
        // it is read at the moment of the click.
        const ground = this.elevation.groundY(0, 0);
        if (pose === 'exit') {
          this.goto(ground + EXIT_ALTITUDE_M, -Math.PI / 3);
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
   * The window is a second long, the same as the debug line, so the number
   * on the console is the average of the frames it reports.
   */
  private measureUpdate(elapsedMs: number, now: number): void {
    this.updateMsTotal += elapsedMs;
    this.updateMsCount += 1;

    if (Number.isNaN(this.updateWindowStart)) this.updateWindowStart = now;
    if (now - this.updateWindowStart < 1000) return;

    this.updateMsAvg = this.updateMsCount > 0 ? this.updateMsTotal / this.updateMsCount : 0;
    this.updateMsTotal = 0;
    this.updateMsCount = 0;
    this.updateWindowStart = now;
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
