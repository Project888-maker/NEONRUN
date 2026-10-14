#!/usr/bin/env node
// Builds an artifact-friendly page from dist/index.html: the artifact host supplies the
// <!doctype>/<html>/<head>/<body> skeleton, so we keep the title, styles, module script and body content.
// Output: dist/artifact.html (published as the page; dist/assets/** are published alongside it).
import fs from 'node:fs';

const html = fs.readFileSync('dist/index.html', 'utf8');
const title = html.match(/<title>.*?<\/title>/s)[0];
const head = html.match(/<head>([\s\S]*?)<\/head>/)[1];
const keep = head.split('\n').filter((l) => /<link[^>]+(stylesheet|preconnect)|<script/.test(l)).join('\n');
const body = html.match(/<body>([\s\S]*?)<\/body>/)[1];
const page = `${title}\n<style>html,body{height:100%;background:#05060c;color:#e9f3ff;color-scheme:dark}</style>\n${keep}\n${body}`;
fs.writeFileSync('dist/artifact.html', page);
// .glb is not a served type on the artifact host: ship models as base64 JSON (the loader falls back to it)
for (const f of fs.readdirSync('dist/assets/models')) {
  if (!f.endsWith('.glb')) continue;
  fs.writeFileSync(`dist/assets/models/${f}.json`, JSON.stringify({ glb: fs.readFileSync(`dist/assets/models/${f}`).toString('base64') }));
}
const files = [];
const walk = (d) => { for (const f of fs.readdirSync(d, { withFileTypes: true })) { const p = `${d}/${f.name}`; f.isDirectory() ? walk(p) : files.push(p.replace(/^dist\//, '')); } };
walk('dist/assets');
for (let i = files.length - 1; i >= 0; i--) if (files[i].endsWith('.glb')) files.splice(i, 1);
fs.writeFileSync('dist/artifact-files.json', JSON.stringify(files));
console.log('artifact page', page.length, 'bytes;', files.length, 'files');
