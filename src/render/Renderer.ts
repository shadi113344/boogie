/**
 * The WebGL renderer.
 *
 * One canvas, one renderer: ACES tone mapping at exposure 1 and sRGB output,
 * a capped pixel ratio and a resize that follows the canvas.
 */

import * as THREE from 'three';

export interface RenderInfo {
  /** Draw calls in the last frame. */
  calls: number;
  /** Triangles in the last frame. */
  triangles: number;
  /** Textures held by the renderer. */
  textures: number;
}

export class Renderer {
  readonly gl: THREE.WebGLRenderer;

  private pixelRatioCap = 2;

  constructor(canvas: HTMLCanvasElement) {
    this.gl = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: false,
      stencil: false,
      powerPreference: 'high-performance',
    });
    this.gl.toneMapping = THREE.ACESFilmicToneMapping;
    this.gl.toneMappingExposure = 1;
    this.gl.outputColorSpace = THREE.SRGBColorSpace;
    this.gl.setClearColor(0x000000, 1);
    this.applySize();
  }

  /**
   * Cap the device pixel ratio, so a three-times-density phone does not render
   * three times the pixels. The lower of the two wins.
   */
  setPixelRatioCap(cap: number): void {
    this.pixelRatioCap = Math.max(0.5, cap);
    this.applySize();
  }

  /** Match the drawing buffer to the canvas. */
  resize(): void {
    this.applySize();
  }

  /** Draw one frame. */
  render(scene: THREE.Scene, camera: THREE.Camera): void {
    this.gl.render(scene, camera);
  }

  /**
   * Draw the first-person instruments over the world.
   *
   * The watch on the wrist is a third of a metre from the eye, and the
   * camera of the world has a near plane a metre away, so the watch is
   * drawn in a pass of its own: the depth is cleared and the colour is
   * not, so the instruments sit over the world without touching it.
   */
  renderOverlay(scene: THREE.Scene, camera: THREE.Camera): void {
    const gl = this.gl;
    gl.autoClear = false;
    gl.clearDepth();
    gl.render(scene, camera);
    gl.autoClear = true;
  }

  /** What the last frame cost. */
  info(): RenderInfo {
    return {
      calls: this.gl.info.render.calls,
      triangles: this.gl.info.render.triangles,
      textures: this.gl.info.memory.textures,
    };
  }

  private applySize(): void {
    const canvas = this.gl.domElement;
    const width = Math.max(1, Math.floor(canvas.clientWidth || window.innerWidth || 1));
    const height = Math.max(1, Math.floor(canvas.clientHeight || window.innerHeight || 1));
    const ratio = Math.min(window.devicePixelRatio || 1, this.pixelRatioCap);
    this.gl.setPixelRatio(ratio);
    this.gl.setSize(width, height, false);
  }
}
