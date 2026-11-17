#!/usr/bin/env node
/**
 * Copies the agent core from the Gisoo for VS Code repository into this one.
 *
 * Gisoo Desktop runs the extension's agent unchanged: `src/` and `webview/` are copied as they are
 * from the extension, and the `vscode` module they import is answered by `shim/vscode.ts`. Keep core edits
 * upstream (in gisoo-vscode) and re-run this script, so the two products never drift apart.
 *
 *   node scripts/sync-core.mjs [path-to-gisoo-vscode]
 */
import { cpSync, existsSync, rmSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const upstream = resolve(process.argv[2] ?? join(root, '..', 'gisoo-vscode'));

if (!existsSync(join(upstream, 'src', 'agent', 'runner.ts'))) {
  console.error(`Not a gisoo-vscode checkout: ${upstream}`);
  process.exit(1);
}

/** Files of the extension shell that the desktop app replaces with its own. */
const SKIP = new Set(['extension.ts']);

for (const [from, to] of [['src', 'src'], ['webview', 'webview']]) {
  const target = join(root, to);
  rmSync(target, { recursive: true, force: true });
  cpSync(join(upstream, from), target, {
    recursive: true,
    filter: (p) => !SKIP.has(p.split(/[\\/]/).pop() ?? '') && !p.endsWith('.map'),
  });
}

// Assets the chat view loads: its stylesheet, icon font, codicons and the coin mark.
const assets = join(root, 'assets', 'chat');
rmSync(assets, { recursive: true, force: true });
mkdirSync(assets, { recursive: true });
for (const f of ['webview.css', 'gisoo-icons.woff', 'gisoo-coin.svg', 'gisoo.svg', 'icon.png']) cpSync(join(upstream, 'media', f), join(assets, f));
cpSync(join(upstream, 'media', 'codicons'), join(assets, 'codicons'), { recursive: true });
cpSync(join(upstream, 'l10n'), join(root, 'l10n'), { recursive: true });

// The extension's settings (type, default, choices, both languages' descriptions): the desktop
// answers `getConfiguration('gisoo')` from them and draws its settings page from them.
{
  const manifest = JSON.parse(readFileSync(join(upstream, 'package.json'), 'utf8'));
  const nls = { en: readJson(join(upstream, 'package.nls.json')), fa: readJson(join(upstream, 'package.nls.fa.json')) };
  const tr = (lang, v) => (typeof v === 'string' ? v.replace(/^%(.+)%$/, (_, k) => nls[lang][k] ?? nls.en[k] ?? k) : v);
  const blocks = Array.isArray(manifest.contributes.configuration) ? manifest.contributes.configuration : [manifest.contributes.configuration];
  const settings = {};
  for (const block of blocks) {
    for (const [key, p] of Object.entries(block.properties ?? {})) {
      const text = p.markdownDescription ?? p.description;
      settings[key] = {
        type: p.type,
        default: p.default,
        enum: p.enum,
        enumDescriptions: { en: p.enumDescriptions?.map((d) => tr('en', d)) ?? p.markdownEnumDescriptions?.map((d) => tr('en', d)), fa: p.enumDescriptions?.map((d) => tr('fa', d)) ?? p.markdownEnumDescriptions?.map((d) => tr('fa', d)) },
        description: { en: tr('en', text), fa: tr('fa', text) },
        scope: p.scope,
        minimum: p.minimum,
        maximum: p.maximum,
      };
    }
  }
  writeFileSync(join(root, 'src', 'settings.generated.json'), `${JSON.stringify(settings, null, 2)}\n`);
}

function readJson(file) {
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
}

let commit = 'unknown';
try {
  commit = execFileSync('git', ['-C', upstream, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
} catch {
  /* not a git checkout */
}
const pkg = JSON.parse(execFileSync('node', ['-p', 'JSON.stringify(require("./package.json"))'], { cwd: upstream, encoding: 'utf8' }));
writeFileSync(join(root, 'src', 'UPSTREAM.json'), `${JSON.stringify({ repository: 'https://github.com/netarz/gisoo-vscode', version: pkg.version, commit }, null, 2)}\n`);
console.log(`core synced from gisoo-vscode ${pkg.version} (${commit})`);
