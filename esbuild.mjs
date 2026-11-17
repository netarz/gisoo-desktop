/**
 * Builds Gisoo Desktop into dist/:
 *   main.js        Electron main process; the extension core runs here with `vscode` → shim/vscode.ts
 *   preload.js     the shell's bridge to the main process
 *   shell/         the Codex-style window (sidebar, projects, settings) — Preact
 *   chat/          one chat page per open conversation: the extension's own webview, unchanged
 */
import * as esbuild from 'esbuild';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');
const out = path.join(root, 'dist');

const common = { bundle: true, minify: production, sourcemap: !production, logLevel: 'info', legalComments: 'none' };
const define = { 'process.env.NODE_ENV': JSON.stringify(production ? 'production' : 'development') };

const node = {
  ...common,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  external: ['electron'],
  alias: { vscode: path.join(root, 'shim', 'vscode.ts') },
  loader: { '.json': 'json' },
};

const builds = [
  { ...node, entryPoints: ['main/main.ts'], outfile: 'dist/main.js' },
  { ...node, entryPoints: ['main/preload.ts'], outfile: 'dist/preload.js', sourcemap: false },
  {
    ...common, define, entryPoints: ['shell/main.tsx'], outfile: 'dist/shell/shell.js',
    platform: 'browser', format: 'iife', target: 'es2022', jsx: 'automatic', jsxImportSource: 'preact', loader: { '.svg': 'text' },
  },
  {
    ...common, define, entryPoints: ['webview/main.tsx'], outfile: 'dist/chat/webview.js',
    platform: 'browser', format: 'iife', target: 'es2020', jsx: 'automatic', jsxImportSource: 'preact', loader: { '.css': 'text' },
  },
  { ...common, entryPoints: ['chat/bridge.ts'], outfile: 'dist/chat/bridge.js', platform: 'browser', format: 'iife', target: 'es2020', sourcemap: false },
];

/** Static files: pages, styles, fonts and the extension's own chat assets. */
function copyStatic() {
  const copy = (from, to) => {
    const src = path.join(root, from);
    const dst = path.join(out, to);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.cpSync(src, dst, { recursive: true });
  };
  copy('shell/index.html', 'shell/index.html');
  copy('shell/shell.css', 'shell/shell.css');
  copy('chat/chat.html', 'chat/chat.html');
  copy('chat/theme.css', 'chat/theme.css');
  copy('chat/desktop.css', 'chat/desktop.css');
  copy('assets/chat', 'chat/media');
  copy('assets/brand', 'brand');
  const fonts = path.join(root, 'node_modules', 'vazirmatn', 'fonts', 'webfonts');
  fs.mkdirSync(path.join(out, 'fonts'), { recursive: true });
  for (const weight of ['Regular', 'Medium', 'SemiBold', 'Bold']) {
    fs.copyFileSync(path.join(fonts, `Vazirmatn-${weight}.woff2`), path.join(out, 'fonts', `Vazirmatn-${weight}.woff2`));
  }
  fs.copyFileSync(path.join(root, 'shell', 'fonts.css'), path.join(out, 'fonts', 'fonts.css'));
}

copyStatic();
if (watch) {
  const ctxs = await Promise.all(builds.map((b) => esbuild.context(b)));
  await Promise.all(ctxs.map((c) => c.watch()));
} else {
  await Promise.all(builds.map((b) => esbuild.build(b)));
}
