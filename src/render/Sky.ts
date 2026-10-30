/**
 * The sky dome.
 *
 * A sphere around the camera, painted by the shader: the zenith colour down
 * to the horizon colour by the elevation of the view direction, with the sun
 * and its glow where the sun actually is.
 */

import * as THREE from 'three';
import type { Atmosphere } from './Atmosphere';

/** Radius of the dome, in metres. It only has to be bigger than the near plane. */
const SKY_RADIUS = 1000;

const VERTEX_SHADER = `
varying vec3 vDirection;

void main() {
  vDirection = normalize( ( modelMatrix * vec4( position, 1.0 ) ).xyz - cameraPosition );
  gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
}
`;

const FRAGMENT_SHADER = `
uniform vec3 uZenithColor;
uniform vec3 uHorizonColor;
uniform vec3 uSunDir;

varying vec3 vDirection;

void main() {
  vec3 direction = normalize( vDirection );
  float elevation = clamp( direction.y, -1.0, 1.0 );

  // The gradient: horizon colour at the skyline, zenith colour overhead.
  float height = pow( clamp( elevation, 0.0, 1.0 ), 0.55 );
  vec3 color = mix( uHorizonColor, uZenithColor, height );

  // Below the skyline the dome darkens into the ground haze.
  color = mix( color * 0.55, color, smoothstep( -0.15, 0.02, elevation ) );

  // The sun: a small disc with a wide glow around it.
  vec3 sun = normalize( uSunDir );
  float towardsSun = dot( direction, sun );
  float disc = smoothstep( 0.999960, 0.999985, towardsSun );
  float glow = pow( max( towardsSun, 0.0 ), 180.0 ) * 0.35
             + pow( max( towardsSun, 0.0 ), 12.0 ) * 0.08;
  float sunUp = smoothstep( -0.12, 0.15, sun.y );
  vec3 sunColor = vec3( 1.0, 0.94, 0.84 );
  color += sunColor * ( disc * 6.0 + glow * ( 0.35 + 0.65 * sunUp ) );

  gl_FragColor = vec4( color, 1.0 );

  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

export class Sky {
  readonly mesh: THREE.Mesh;

  private readonly material: THREE.ShaderMaterial;

  constructor(atmo: Atmosphere) {
    const geometry = new THREE.SphereGeometry(SKY_RADIUS, 32, 16);
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uZenithColor: atmo.uniforms.uZenithColor,
        uHorizonColor: atmo.uniforms.uHorizonColor,
        uSunDir: atmo.uniforms.uSunDir,
      },
      vertexShader: VERTEX_SHADER,
      fragmentShader: FRAGMENT_SHADER,
      side: THREE.BackSide,
      depthWrite: false,
      depthTest: false,
      fog: false,
      toneMapped: true,
    });

    this.mesh = new THREE.Mesh(geometry, this.material);
    this.mesh.name = 'sky';
    this.mesh.renderOrder = -1;
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = true;
  }

  /** Keep the dome on the camera. */
  update(cameraPosition: THREE.Vector3): void {
    this.mesh.position.copy(cameraPosition);
  }

  /** The dome's material, for tests and later tweaks. */
  get skyMaterial(): THREE.ShaderMaterial {
    return this.material;
  }
}
