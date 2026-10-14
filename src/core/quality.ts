export type QualityLevel = 'low' | 'med' | 'high';

export interface QualitySettings {
  level: QualityLevel;
  pixelRatio: number;
  reflection: boolean;
  reflectionScale: number;
  reflectionEvery: number; // render reflection every N frames
  ao: boolean;
  bloom: boolean;
  smaa: boolean;
  rainCount: number;
  splashCount: number;
  traffic: number;
  fogSprites: number;
  viewDistance: number;
  realLights: number; // dynamic neon pool lights
  lensFx: boolean;
}

export function qualitySettings(level: QualityLevel): QualitySettings {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  switch (level) {
    case 'low':
      return { level, pixelRatio: Math.min(dpr, 1) * 0.75, reflection: true, reflectionScale: 0.25, reflectionEvery: 3, ao: false, bloom: true, smaa: false, rainCount: 3000, splashCount: 150, traffic: 12, fogSprites: 20, viewDistance: 260, realLights: 2, lensFx: false };
    case 'med':
      return { level, pixelRatio: Math.min(dpr, 1.25), reflection: true, reflectionScale: 0.4, reflectionEvery: 2, ao: false, bloom: true, smaa: true, rainCount: 6000, splashCount: 350, traffic: 22, fogSprites: 45, viewDistance: 330, realLights: 4, lensFx: true };
    default:
      return { level, pixelRatio: Math.min(dpr, 1.5), reflection: true, reflectionScale: 0.5, reflectionEvery: 1, ao: true, bloom: true, smaa: true, rainCount: 9000, splashCount: 600, traffic: 32, fogSprites: 70, viewDistance: 400, realLights: 6, lensFx: true };
  }
}

export function isMobile() {
  return /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent) || (navigator.maxTouchPoints > 1 && /Macintosh/.test(navigator.userAgent));
}

/** Pick a starting quality from the GPU string + device class. Adaptive tuning refines it at runtime. */
export function autoDetectQuality(gl: WebGL2RenderingContext | null): QualityLevel {
  if (isMobile()) return 'low';
  if (!gl) return 'low';
  const ext = gl.getExtension('WEBGL_debug_renderer_info');
  const r = String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)).toLowerCase();
  if (/swiftshader|llvmpipe|software|basic render/.test(r)) return 'low';
  if (/rtx|radeon rx|radeon pro|apple m\d (pro|max|ultra)|arc a\d/.test(r)) return 'high';
  if (/apple m\d|apple gpu|iris xe|radeon/.test(r)) return 'med';
  if (/intel/.test(r)) return 'low';
  return 'med';
}
