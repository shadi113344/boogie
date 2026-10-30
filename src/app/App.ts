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
import { Terrain } from '@/render/terrain/Terrain';
import type { LodCamera } from '@/render/terrain/TerrainQuadtree';
import { Loop } from './Loop';
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
  /** Quality tier. Task 11 turns this into an adaptive tier. */
  quality?: 'low' | 'medium' | 'high';
}

/** Height of the camera at the start: 13,500 ft above mean sea level. */
const EXIT_ALTITUDE_M = 4115;

/** Height of the landing area. A placeholder until the terrain arrives. */
const LANDING_HEIGHT_M = 0;

/** Vertical field of view, in degrees. */
const FOV_DEG = 60;

/** Near and far planes, in metres. The horizon is over 200 km away. */
const NEAR_M = 1;
const FAR_M = 600000;

/** Downward tilt at the start, in radians. */
const START_PITCH_RAD = -Math.PI / 4;

/** Pixel ratio cap per quality tier. Task 11 owns the tiers. */
const PIXEL_RATIO_CAP: Record<'low' | 'medium' | 'high', number> = {
  low: 1,
  medium: 1.5,
  high: 2,
};

/** Anisotropic filtering allowed per quality tier. */
const ANISOTROPY_CAP: Record<'low' | 'medium' | 'high', number> = {
  low: 2,
  medium: 4,
  high: 8,
};

export class App {
  readonly renderer: Renderer;
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  readonly atmosphere: Atmosphere;
  readonly sky: Sky;
  readonly loop: Loop;

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

  /** Scratch: the view direction of the camera, in world space. */
  private readonly viewDirection = new THREE.Vector3();

  /** Scratch: the size of the drawing buffer, in pixels. */
  private readonly bufferSize = new THREE.Vector2();

  private lastDebugAt = 0;

  /** The time the terrain update took, summed over the current window. */
  private updateMsTotal = 0;

  /** The number of terrain updates in the current window. */
  private updateMsCount = 0;

  /** The mean duration of the terrain update over the last second. */
  private updateMsAvg = 0;

  /** When the current window began, in frame time. */
  private updateWindowStart = Number.NaN;

  constructor(canvas: HTMLCanvasElement, opts: AppOptions) {
    this.canvas = canvas;
    this.options = opts;

    this.renderer = new Renderer(canvas);
    this.renderer.setPixelRatioCap(PIXEL_RATIO_CAP[opts.quality ?? 'high']);

    this.scene = new THREE.Scene();

    this.atmosphere = new Atmosphere();
    this.sky = new Sky(this.atmosphere);
    this.scene.add(this.sky.mesh);

    this.camera = new THREE.PerspectiveCamera(FOV_DEG, 1, NEAR_M, FAR_M);
    this.camera.position.set(0, EXIT_ALTITUDE_M + LANDING_HEIGHT_M, 0);
    this.camera.rotation.set(START_PITCH_RAD, 0, 0);

    // The world the terrain lives in. The floating origin moves it, so the
    // ground keeps its place while the camera stays near the origin.
    this.world = new THREE.Group();
    this.scene.add(this.world);
    this.floatingOrigin = new FloatingOrigin(this.world);

    // The terrain fetches its own tiles: the cache brings them, the grid
    // holds the heights and the terrain drapes the meshes over them.
    this.localFrame = new LocalFrame(opts.dz.lz);
    this.elevation = new ElevationGrid(this.localFrame);
    this.cache = new TileCache();
    this.terrain = new Terrain(
      this.world,
      this.localFrame,
      { x: 0, z: 0 },
      this.elevation,
      this.cache,
      this.atmosphere,
      {
        anisotropy: Math.min(
          ANISOTROPY_CAP[opts.quality ?? 'high'],
          this.renderer.gl.capabilities.getMaxAnisotropy(),
        ),
      },
    );

    // The sun, for today in the drop zone's own time zone.
    this.sunDate = localTimeToDate(
      opts.dz.lz,
      opts.dz.timeZone,
      localDayInZone(opts.dz.timeZone),
      opts.hourLocal,
    );
    this.atmosphere.setSun(sunDirectionLocal(this.sunDate, opts.dz.lz));
    this.atmosphere.setCameraY(this.camera.position.y);

    this.loop = new Loop((_dt, now) => {
      this.frame(now);
    });

    // The debug handle: the terrain and the frame timings are one console
    // line away, without a build of the app.
    if (opts.debug) {
      (window as unknown as { __boogie?: unknown }).__boogie = this;
    }

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

  private frame(now: number): void {
    // The world is rebased first: everything after it works with the camera's
    // true position in the local frame.
    this.floatingOrigin.update(this.camera);

    const started = performance.now();
    this.terrain.update(this.lodCamera(this.floatingOrigin.truePosition(this.camera)));
    this.measureUpdate(performance.now() - started, now);

    this.sky.update(this.camera.position);
    this.atmosphere.setCameraY(this.camera.position.y);
    this.renderer.render(this.scene, this.camera);

    if (this.options.debug && now - this.lastDebugAt > 1000) {
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
