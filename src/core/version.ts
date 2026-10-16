declare const __ASSET_HASHES__: Record<string, string>;
const HASHES: Record<string, string> = typeof __ASSET_HASHES__ !== 'undefined' ? __ASSET_HASHES__ : {};

/**
 * Add the file's content fingerprint to an asset URL ("./assets/people/hero.glb" -> "...hero.glb?v=1a2b3c4d").
 * Public assets keep fixed names, so without this a cached old copy (a previous character model, an old
 * sound) can outlive an update on players' devices.
 */
export function av(url: string): string {
  const i = url.indexOf('assets/');
  if (i < 0) return url;
  const key = url.slice(i + 7).split(/[?#]/)[0];
  const h = HASHES[key];
  return h ? `${url}${url.includes('?') ? '&' : '?'}v=${h}` : url;
}
