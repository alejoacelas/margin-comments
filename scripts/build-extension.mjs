// Build the Chrome extension.
//
//   node scripts/build-extension.mjs                 -> dist/ (production API) + margin-comments-extension.zip
//   node scripts/build-extension.mjs --out build/ext-test --api http://localhost:8787 --no-zip
//
// The API URL is baked in at build time (env API_URL or --api).
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};
const DEFAULT_API = 'https://margin-comments.fly.dev';
const apiUrl = (arg('--api', process.env.API_URL || DEFAULT_API)).replace(/\/+$/, '');
const outDir = resolve(root, arg('--out', 'dist'));
const zip = !args.includes('--no-zip');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const { key, id } = JSON.parse(readFileSync(join(root, 'src/extension/extension-key.json'), 'utf8'));

rmSync(outDir, { recursive: true, force: true });
mkdirSync(join(outDir, 'icons'), { recursive: true });
mkdirSync(join(outDir, 'fonts'), { recursive: true });

const common = {
  bundle: true,
  target: 'chrome120',
  define: { __API_URL__: JSON.stringify(apiUrl) },
  jsx: 'automatic',
  jsxImportSource: 'preact',
  legalComments: 'none',
  logLevel: 'warning',
  minify: false,
  sourcemap: false,
};

await build({ ...common, entryPoints: [join(root, 'src/extension/background/index.ts')], outfile: join(outDir, 'background.js'), format: 'esm' });
await build({ ...common, entryPoints: [join(root, 'src/extension/content/early.ts')], outfile: join(outDir, 'early.js'), format: 'iife' });
await build({ ...common, entryPoints: [join(root, 'src/extension/content/index.tsx')], outfile: join(outDir, 'content.js'), format: 'iife' });

// Highlight styles (CSS Custom Highlight API). Names must match highlights.ts.
const HUES = [0, 22, 95, 125, 155, 180, 200, 222, 250, 278, 305, 335];
const rule = (name, body) => `::highlight(${name}) { ${body} }`;
const css = [];
for (const dark of [false, true]) {
  const d = dark ? '-d' : '';
  css.push(rule(`mc-own${d}`, dark ? 'background-color: rgba(214, 170, 0, 0.42);' : 'background-color: rgba(255, 230, 0, 0.45);'));
  css.push(rule(`mc-own-active${d}`, dark ? 'background-color: rgba(235, 190, 0, 0.66);' : 'background-color: rgba(255, 222, 0, 0.85);'));
  HUES.forEach((h, i) => {
    const line = `text-decoration-line: underline; text-decoration-thickness: 1px; text-decoration-color: hsl(${h} 55% ${dark ? 62 : 62}%);`;
    css.push(rule(`mc-h${i}${d}`, `background-color: hsl(${h} 60% ${dark ? 50 : 70}% / ${dark ? 0.35 : 0.3}); ${line}`));
    css.push(rule(`mc-h${i}-active${d}`, `background-color: hsl(${h} 60% ${dark ? 50 : 70}% / ${dark ? 0.6 : 0.58}); ${line}`));
  });
  css.push(rule(`mc-draft${d}`, dark ? 'background-color: rgba(235, 190, 0, 0.55);' : 'background-color: rgba(255, 222, 0, 0.6);'));
}
writeFileSync(join(outDir, 'highlights.css'), `/* Margin Comments highlights (CSS Custom Highlight API). */\n${css.join('\n')}\n`);

for (const size of [16, 32, 48, 128]) copyFileSync(join(root, `src/extension/icons/icon-${size}.png`), join(outDir, `icons/icon-${size}.png`));
const fonts = [
  ['@fontsource/source-sans-3/files/source-sans-3-latin-400-normal.woff2', 'source-sans-3-400.woff2'],
  ['@fontsource/source-sans-3/files/source-sans-3-latin-600-normal.woff2', 'source-sans-3-600.woff2'],
  ['@fontsource/source-sans-3/files/source-sans-3-latin-700-normal.woff2', 'source-sans-3-700.woff2'],
  ['@fontsource/lora/files/lora-latin-400-normal.woff2', 'lora-400.woff2'],
];
for (const [from, to] of fonts) copyFileSync(join(root, 'node_modules', from), join(outDir, 'fonts', to));
writeFileSync(
  join(outDir, 'fonts', 'LICENSE.txt'),
  'Source Sans 3 and Lora are licensed under the SIL Open Font License 1.1 (https://openfontlicense.org). Files from the @fontsource packages.\n',
);

const apiOrigin = new URL(apiUrl).origin;
const manifest = {
  manifest_version: 3,
  name: 'Margin Comments',
  version: pkg.version,
  description: 'Google Docs-style comment threads on any web page.',
  key,
  minimum_chrome_version: '120',
  icons: { 16: 'icons/icon-16.png', 32: 'icons/icon-32.png', 48: 'icons/icon-48.png', 128: 'icons/icon-128.png' },
  action: {
    default_title: 'Margin Comments',
    default_icon: { 16: 'icons/icon-16.png', 32: 'icons/icon-32.png' },
  },
  background: { service_worker: 'background.js', type: 'module' },
  permissions: ['storage', 'alarms', 'identity', 'scripting'],
  host_permissions: ['http://*/*', 'https://*/*', `${apiOrigin}/*`],
  content_scripts: [
    { matches: ['http://*/*', 'https://*/*'], js: ['early.js'], run_at: 'document_start', all_frames: false },
    { matches: ['http://*/*', 'https://*/*'], js: ['content.js'], css: ['highlights.css'], run_at: 'document_idle', all_frames: false },
  ],
  web_accessible_resources: [{ resources: ['fonts/*.woff2'], matches: ['http://*/*', 'https://*/*'] }],
};
writeFileSync(join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

if (zip) {
  const zipPath = join(root, 'margin-comments-extension.zip');
  rmSync(zipPath, { force: true });
  execFileSync('zip', ['-r', '-X', '-q', zipPath, '.'], { cwd: outDir });
  console.log(`zipped ${zipPath}`);
}
console.log(`built extension ${id} -> ${outDir} (API ${apiUrl})`);
