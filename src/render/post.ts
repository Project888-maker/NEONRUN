import * as THREE from 'three';
import {
  EffectComposer, RenderPass, EffectPass, BloomEffect, ToneMappingEffect, ToneMappingMode,
  VignetteEffect, NoiseEffect, ChromaticAberrationEffect, SMAAEffect, BlendFunction, Effect, EffectAttribute,
} from 'postprocessing';
import { N8AOPostPass } from 'n8ao';
import type { QualitySettings } from '../core/quality';

const lensFrag = /* glsl */ `
uniform float time;
uniform float rain;     // 0..1 droplet amount
uniform float speedBlur; // 0..1 radial blur
uniform float wipe;     // >0 right after boost: droplets pushed outwards

float h21(vec2 p){ p = fract(p*vec2(123.34, 456.21)); p += dot(p, p+45.32); return fract(p.x*p.y); }
vec2 h22(vec2 p){ float n = h21(p); return vec2(n, h21(p+n)); }

// Static droplets + running drips on the lens (cheap layered grid approach).
vec3 drops(vec2 uv, float t, float scale){
  vec2 aspect = vec2(2.0, 1.0);
  vec2 st = uv * scale * aspect;
  st.y += t * 0.22;
  vec2 id = floor(st);
  vec2 f = fract(st) - 0.5;
  vec2 n = h22(id);
  float life = fract(t * (0.15 + n.x*0.3) + n.y);
  vec2 p = (n - 0.5) * 0.7;
  p.y += (life - 0.5) * 0.4 * step(0.6, n.x); // some drops slide
  vec2 d = (f - p) / aspect * aspect;
  float r = 0.08 + 0.12 * n.y;
  float m = smoothstep(r, r*0.6, length(d)) * step(0.35, n.x) * smoothstep(1.0, 0.7, life);
  // trail
  float trail = smoothstep(0.03, 0.0, abs(f.x - p.x)) * smoothstep(p.y, p.y + 0.4, f.y) * step(0.6, n.x) * 0.4;
  return vec3(d * m * 1.8, m + trail);
}

void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
  vec2 o = vec2(0.0);
  float mask = 0.0;
  if (rain > 0.001) {
    vec3 a = drops(uv, time, 9.0);
    vec3 b = drops(uv * 1.7 + 3.1, time * 1.3, 9.0);
    o = (a.xy + b.xy * 0.6) * rain * 0.06;
    mask = clamp(a.z + b.z, 0.0, 1.0) * rain;
  }
  vec2 suv = uv + o;
  vec4 col = texture2D(inputBuffer, suv);
  if (speedBlur > 0.01) {
    vec2 dir = (suv - 0.5);
    float edge = smoothstep(0.15, 0.7, length(dir));
    vec4 acc = col;
    for (int i = 1; i < 6; i++) {
      acc += texture2D(inputBuffer, suv - dir * float(i) * 0.012 * speedBlur * edge);
    }
    col = acc / 6.0;
  }
  // droplets brighten/blur slightly what they refract
  col.rgb += col.rgb * mask * 0.25;
  outputColor = col;
}`;

export class LensEffect extends Effect {
  constructor() {
    super('LensEffect', lensFrag, {
      attributes: EffectAttribute.CONVOLUTION,
      uniforms: new Map<string, THREE.Uniform>([
        ['time', new THREE.Uniform(0)],
        ['rain', new THREE.Uniform(0.6)],
        ['speedBlur', new THREE.Uniform(0)],
        ['wipe', new THREE.Uniform(0)],
      ]),
    });
  }
  set(time: number, rain: number, speedBlur: number) {
    this.uniforms.get('time')!.value = time;
    this.uniforms.get('rain')!.value = rain;
    this.uniforms.get('speedBlur')!.value = speedBlur;
  }
}

export class Post {
  composer: EffectComposer;
  bloom: BloomEffect;
  lens: LensEffect;
  chroma: ChromaticAberrationEffect;
  vignette: VignetteEffect;
  ao?: any;
  private lensPass: EffectPass;

  constructor(public renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.PerspectiveCamera, q: QualitySettings) {
    const composer = new EffectComposer(renderer, { frameBufferType: THREE.HalfFloatType, multisampling: 0 });
    this.composer = composer;
    composer.addPass(new RenderPass(scene, camera));
    const size = renderer.getSize(new THREE.Vector2());
    if (q.ao) {
      const ao = new N8AOPostPass(scene, camera, size.x, size.y);
      ao.configuration.aoRadius = 3.0;
      ao.configuration.distanceFalloff = 1.2;
      ao.configuration.intensity = 2.5;
      ao.configuration.halfRes = true;
      ao.configuration.gammaCorrection = false;
      ao.setQualityMode('Performance');
      this.ao = ao;
      composer.addPass(ao as any);
    }
    this.lens = new LensEffect();
    this.lensPass = new EffectPass(camera, this.lens);
    this.lensPass.enabled = q.lensFx;
    composer.addPass(this.lensPass);

    this.bloom = new BloomEffect({ mipmapBlur: true, luminanceThreshold: 0.9, luminanceSmoothing: 0.25, intensity: 1.15, radius: 0.72, levels: 7 });
    this.chroma = new ChromaticAberrationEffect({ offset: new THREE.Vector2(0.0006, 0.0004), radialModulation: true, modulationOffset: 0.25 });
    this.vignette = new VignetteEffect({ darkness: 0.55, offset: 0.3 });
    const noise = new NoiseEffect({ blendFunction: BlendFunction.OVERLAY, premultiply: false });
    noise.blendMode.opacity.value = 0.11;
    const tone = new ToneMappingEffect({ mode: ToneMappingMode.ACES_FILMIC });
    const effects: Effect[] = [];
    if (q.bloom) effects.push(this.bloom);
    effects.push(tone, this.chroma, this.vignette, noise);
    composer.addPass(new EffectPass(camera, ...effects));
    if (q.smaa) composer.addPass(new EffectPass(camera, new SMAAEffect()));
  }

  setSize(w: number, h: number) { this.composer.setSize(w, h); }
  render(dt: number) { this.composer.render(dt); }
}
