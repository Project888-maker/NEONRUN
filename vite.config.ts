import { defineConfig, type Plugin } from 'vite';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Content fingerprints for everything in public/assets. Those files keep fixed names (people/hero.glb …),
 * so a long browser cache would serve an old model after an update. The game appends ?v=<hash> to every
 * asset URL (src/core/version.ts); a changed file gets a new URL, unchanged files stay cached.
 */
function assetHashes(): Record<string, string> {
  const root = path.resolve(__dirname, 'public/assets');
  const out: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else out[path.relative(root, p).split(path.sep).join('/')] = createHash('md5').update(fs.readFileSync(p)).digest('hex').slice(0, 8);
    }
  };
  if (fs.existsSync(root)) walk(root);
  return out;
}

/** The same fingerprints for the asset references written directly in index.html. */
function versionHtmlAssets(hashes: Record<string, string>): Plugin {
  return {
    name: 'neonrun-asset-versions',
    transformIndexHtml: (html) => html.replace(/(["(])\.?\/assets\/([^"')?#]+)/g, (m, q, p) => (hashes[p] ? `${q}./assets/${p}?v=${hashes[p]}` : m)),
  };
}

const hashes = assetHashes();

export default defineConfig({
  base: './',
  define: { __ASSET_HASHES__: JSON.stringify(hashes) },
  plugins: [versionHtmlAssets(hashes)],
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 4000,
    assetsInlineLimit: 0,
  },
  server: { host: true, port: 5173 },
  preview: { host: true, port: 4173 },
});
