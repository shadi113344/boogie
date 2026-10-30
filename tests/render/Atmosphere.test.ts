import { describe, it, expect } from 'vitest';
import { MeshBasicMaterial, ShaderLib } from 'three';
import { Atmosphere } from '@/render/Atmosphere';

describe('Atmosphere', () => {
  it('defaults to 60 km of visibility and a 1,500 m haze layer', () => {
    const atmo = new Atmosphere();
    expect(atmo.uniforms.uBeta.value).toBeCloseTo(3 / (60 * 1000), 12);
    expect(atmo.uniforms.uScaleHeight.value).toBe(1500);
  });

  it('turns the visibility into the extinction coefficient', () => {
    const atmo = new Atmosphere();
    atmo.setVisibilityKm(30);
    expect(atmo.uniforms.uBeta.value).toBeCloseTo(3 / (30 * 1000), 12);
    expect(atmo.uniforms.uScaleHeight.value).toBe(1500);
  });

  it('normalises the sun direction', () => {
    const atmo = new Atmosphere();
    atmo.setSun({ x: 0, y: 2, z: 0 });
    expect(atmo.uniforms.uSunDir.value.x).toBeCloseTo(0, 6);
    expect(atmo.uniforms.uSunDir.value.y).toBeCloseTo(1, 6);
    expect(atmo.uniforms.uSunDir.value.z).toBeCloseTo(0, 6);
  });

  it('is blue at midday and warm near the horizon at sunset', () => {
    const atmo = new Atmosphere();
    atmo.setSun({ x: 0.3, y: 0.9, z: -0.3 });
    const highZenith = atmo.uniforms.uZenithColor.value.clone();
    const highHorizon = atmo.uniforms.uHorizonColor.value.clone();

    atmo.setSun({ x: 0.9, y: 0.05, z: -0.4 });
    const lowHorizon = atmo.uniforms.uHorizonColor.value.clone();

    // Midday: a blue zenith over a pale horizon.
    expect(highZenith.b).toBeGreaterThan(highZenith.r);
    expect(highHorizon.b).toBeGreaterThan(highHorizon.r);
    // Sunset: the horizon turns warm.
    expect(lowHorizon.r).toBeGreaterThan(highHorizon.r);
  });

  it('is dark at night', () => {
    const atmo = new Atmosphere();
    atmo.setSun({ x: 0, y: -0.5, z: 0 });
    expect(atmo.uniforms.uZenithColor.value.r).toBeLessThan(0.02);
    expect(atmo.uniforms.uHorizonColor.value.r).toBeLessThan(0.05);
  });

  it('keeps the camera height in the uniforms', () => {
    const atmo = new Atmosphere();
    atmo.setCameraY(4115);
    expect(atmo.uniforms.uCameraY.value).toBe(4115);
  });

  it('injects the uniforms and the fog mix into a material', () => {
    const atmo = new Atmosphere();
    const material = new MeshBasicMaterial();
    const version = material.version;
    atmo.applyTo(material);
    // needsUpdate is a setter: it bumps the material's version.
    expect(material.version).toBeGreaterThan(version);
    expect(typeof material.customProgramCacheKey).toBe('function');

    const shader = {
      uniforms: {} as Record<string, unknown>,
      vertexShader: ShaderLib.basic.vertexShader,
      fragmentShader: ShaderLib.basic.fragmentShader,
    } as unknown as Parameters<typeof material.onBeforeCompile>[0];
    material.onBeforeCompile(shader, null as never);

    expect(Object.keys(shader.uniforms).sort()).toEqual([
      'uBeta',
      'uCameraY',
      'uHorizonColor',
      'uScaleHeight',
      'uSunDir',
      'uZenithColor',
    ]);
    expect(shader.vertexShader).toContain('vWorldPosition');
    expect(shader.fragmentShader).toContain('vWorldPosition');

    // The fog mix sits in linear space, just before tone mapping, so the
    // ground fades into the same horizon colour the sky dome shows.
    const toneMapping = shader.fragmentShader.indexOf('#include <tonemapping_fragment>');
    const fog = shader.fragmentShader.indexOf('uBeta * boogieDistance');
    expect(toneMapping).toBeGreaterThan(-1);
    expect(fog).toBeGreaterThan(-1);
    expect(fog).toBeLessThan(toneMapping);
    expect(shader.fragmentShader).not.toContain('linearToOutputTexel( vec4( uHorizonColor');
  });
});
