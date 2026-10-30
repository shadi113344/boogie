/**
 * The application: renderer, scene, sky and the frame loop.
 *
 * This is the first frame of the simulator: a camera at the exit altitude
 * above the drop zone, the sky painted by the computed sun, and nothing else
 * yet. Later plans add the terrain, the free camera and the quality tiers.
 */

import * as THREE from 'three';
import { Renderer } from '@/render/Renderer';
import { Atmosphere } from '@/render/Atmosphere';
import { Sky } from '@/render/Sky';
import { Loop } from './Loop';
import { localDayInZone, localTimeToDate, sunDirectionLocal } from '@/world/sun';
import type { LonLat } from '@/world/geo';

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

export class App {
  readonly renderer: Renderer;
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  readonly atmosphere: Atmosphere;
  readonly sky: Sky;
  readonly loop: Loop;

  /** The instant the sun was computed for. */
  readonly sunDate: Date;

  private readonly canvas: HTMLCanvasElement;

  private readonly options: AppOptions;

  private lastDebugAt = 0;

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
    this.sky.update(this.camera.position);
    this.atmosphere.setCameraY(this.camera.position.y);
    this.renderer.render(this.scene, this.camera);

    if (this.options.debug && now - this.lastDebugAt > 1000) {
      this.lastDebugAt = now;
      const stats = this.loop.stats();
      const info = this.renderer.info();
      console.info(
        `[boogie] ${stats.fps.toFixed(0)} fps, ${stats.frameMs.toFixed(1)} ms, ` +
          `${info.calls} calls, ${info.triangles} triangles, ` +
          `camera ${this.camera.position.y.toFixed(0)} m, ` +
          `sun ${this.atmosphere.uniforms.uSunDir.value.toArray().map((n) => n.toFixed(2)).join(', ')}`,
      );
    }
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
