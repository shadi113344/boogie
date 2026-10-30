/**
 * The atmosphere: the sun direction, the sky colours and the aerial
 * perspective that fades the ground into the horizon.
 *
 * The uniforms are shared with every material the atmosphere is applied to, so
 * one call to `setSun` repaints the whole scene.
 */

import * as THREE from 'three';

export interface AtmosphereUniforms {
  uSunDir: { value: THREE.Vector3 };
  uHorizonColor: { value: THREE.Color };
  uZenithColor: { value: THREE.Color };
  uBeta: { value: number };
  uScaleHeight: { value: number };
  uCameraY: { value: number };
}

/** Key colours for the sky, in sRGB. */
const NIGHT_ZENITH = 0x04070f;
const NIGHT_HORIZON = 0x0d1526;
const DAY_ZENITH = 0x1d5cb8;
const DAY_HORIZON = 0xa9c9e8;
const SUNSET_HORIZON = 0xf0a05a;

/** Height of the haze layer, in metres. */
const SCALE_HEIGHT_M = 1500;

/** Default visibility, in kilometres. */
const DEFAULT_VISIBILITY_KM = 60;

const VERTEX_DECLARATIONS = `
varying vec3 vWorldPosition;
varying float vWorldY;
`;

const VERTEX_ASSIGNMENT = `
vWorldPosition = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;
vWorldY = vWorldPosition.y;
`;

const FRAGMENT_DECLARATIONS = `
uniform vec3 uSunDir;
uniform vec3 uHorizonColor;
uniform vec3 uZenithColor;
uniform float uBeta;
uniform float uScaleHeight;
uniform float uCameraY;
varying vec3 vWorldPosition;
varying float vWorldY;
`;

// The aerial perspective: the further away and the lower down the fragment is,
// the more of the horizon's colour it takes on. Mixed in linear space before
// tone mapping, so the ground fades into exactly the colour the sky dome shows.
const FRAGMENT_FOG = `
{
  float boogieDistance = length( vWorldPosition - cameraPosition );
  float boogieHeight = max( 0.0, 0.5 * ( vWorldY + uCameraY ) );
  float boogieTransmittance = exp( -uBeta * boogieDistance * exp( -boogieHeight / uScaleHeight ) );
  gl_FragColor.rgb = mix( uHorizonColor, gl_FragColor.rgb, boogieTransmittance );
}
`;

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Smoothstep from 0 to 1 between two edges. */
function smoothstep(edge0: number, edge1: number, x: number): number {
  if (edge0 === edge1) return x < edge0 ? 0 : 1;
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

/** Insert code just before the closing brace of the shader's main. */
function appendToMain(shader: string, code: string): string {
  const end = shader.lastIndexOf('}');
  if (end < 0) return `${shader}\n${code}`;
  return `${shader.slice(0, end)}\n${code}\n${shader.slice(end)}`;
}

/** Insert code just before the first occurrence of a chunk marker. */
function insertBeforeChunk(shader: string, marker: string, code: string): string {
  const at = shader.indexOf(marker);
  if (at < 0) return appendToMain(shader, code);
  return `${shader.slice(0, at)}${code}\n${shader.slice(at)}`;
}

export class Atmosphere {
  readonly uniforms: AtmosphereUniforms = {
    uSunDir: { value: new THREE.Vector3(0, 1, 0) },
    uHorizonColor: { value: new THREE.Color(NIGHT_HORIZON) },
    uZenithColor: { value: new THREE.Color(NIGHT_ZENITH) },
    uBeta: { value: 3 / (DEFAULT_VISIBILITY_KM * 1000) },
    uScaleHeight: { value: SCALE_HEIGHT_M },
    uCameraY: { value: 0 },
  };

  private readonly nightZenith = new THREE.Color(NIGHT_ZENITH);
  private readonly nightHorizon = new THREE.Color(NIGHT_HORIZON);
  private readonly dayZenith = new THREE.Color(DAY_ZENITH);
  private readonly dayHorizon = new THREE.Color(DAY_HORIZON);
  private readonly sunsetHorizon = new THREE.Color(SUNSET_HORIZON);

  /**
   * Point the atmosphere at the sun.
   *
   * The horizon and zenith colours follow the sun's elevation: a blue day, a
   * warm band at sunrise and sunset, a dark sky at night.
   */
  setSun(dir: { x: number; y: number; z: number }): void {
    const sun = this.uniforms.uSunDir.value;
    sun.set(dir.x, dir.y, dir.z);
    if (sun.lengthSq() > 0) sun.normalize();

    const elevation = Math.asin(clamp(sun.y, -1, 1)) * (180 / Math.PI);
    const day = smoothstep(-6, 6, elevation);
    const twilight = smoothstep(-8, -2, elevation) * (1 - smoothstep(-2, 4, elevation));
    const golden = smoothstep(18, 2, elevation) * smoothstep(-4, 4, elevation);

    this.uniforms.uZenithColor.value
      .lerpColors(this.nightZenith, this.dayZenith, day)
      .lerp(this.nightHorizon, twilight * 0.5);
    this.uniforms.uHorizonColor.value
      .lerpColors(this.nightHorizon, this.dayHorizon, day)
      .lerp(this.sunsetHorizon, golden * 0.75);
  }

  /**
   * How far the eye can see, in kilometres.
   *
   * The extinction coefficient follows from it: `uBeta = 3 / (km * 1000)`.
   */
  setVisibilityKm(km: number): void {
    const metres = Math.max(0.1, km) * 1000;
    this.uniforms.uBeta.value = 3 / metres;
    this.uniforms.uScaleHeight.value = SCALE_HEIGHT_M;
  }

  /** The height of the camera above mean sea level, in metres. */
  setCameraY(y: number): void {
    this.uniforms.uCameraY.value = y;
  }

  /**
   * Give a material the atmosphere: the uniforms, and the aerial perspective
   * mixed in just before tone mapping.
   */
  applyTo(material: THREE.Material): void {
    const uniforms = this.uniforms;

    material.onBeforeCompile = (shader): void => {
      shader.uniforms.uSunDir = uniforms.uSunDir;
      shader.uniforms.uHorizonColor = uniforms.uHorizonColor;
      shader.uniforms.uZenithColor = uniforms.uZenithColor;
      shader.uniforms.uBeta = uniforms.uBeta;
      shader.uniforms.uScaleHeight = uniforms.uScaleHeight;
      shader.uniforms.uCameraY = uniforms.uCameraY;

      shader.vertexShader = this.patchVertex(shader.vertexShader);
      shader.fragmentShader = this.patchFragment(shader.fragmentShader);
    };

    // One program for every material the atmosphere touches.
    material.customProgramCacheKey = (): string => 'boogie-atmosphere';
    material.needsUpdate = true;
  }

  private patchVertex(shader: string): string {
    let out = shader;
    if (out.includes('#include <common>')) {
      out = out.replace('#include <common>', `#include <common>\n${VERTEX_DECLARATIONS}`);
    } else {
      out = `${VERTEX_DECLARATIONS}\n${out}`;
    }
    if (out.includes('#include <project_vertex>')) {
      out = out.replace('#include <project_vertex>', `#include <project_vertex>\n${VERTEX_ASSIGNMENT}`);
    } else {
      out = appendToMain(out, VERTEX_ASSIGNMENT);
    }
    return out;
  }

  private patchFragment(shader: string): string {
    let out = shader;
    if (out.includes('#include <common>')) {
      out = out.replace('#include <common>', `#include <common>\n${FRAGMENT_DECLARATIONS}`);
    } else {
      out = `${FRAGMENT_DECLARATIONS}\n${out}`;
    }
    return insertBeforeChunk(out, '#include <tonemapping_fragment>', FRAGMENT_FOG);
  }
}
