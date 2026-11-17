/** Small helpers shared by the shell's views: the bridge, strings in both languages, time and diffs. */
import type { GisooBridge, Lang } from '../main/api';

declare global {
  interface Window {
    gisoo: GisooBridge;
  }
}

export const bridge: GisooBridge = window.gisoo;
export const isMac = bridge.platform === 'darwin';

let lang: Lang = 'fa';
export function setLang(l: Lang): void {
  lang = l;
  document.documentElement.lang = l;
  document.documentElement.dir = l === 'fa' ? 'rtl' : 'ltr';
}
export function getLang(): Lang {
  return lang;
}

/** One string in the owner's language; `{name}` placeholders are filled from `vars`. */
export function t(fa: string, en: string, vars?: Record<string, string | number>): string {
  let s = lang === 'fa' ? fa : en;
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.split(`{${k}}`).join(typeof v === 'number' ? num(v) : v);
  return s;
}

export function num(n: number): string {
  return n.toLocaleString(lang === 'fa' ? 'fa-IR' : 'en-US');
}

/** "5 minutes", "3 hours"… short, like Codex's sidebar. */
export function ago(ts: number): string {
  const m = Math.max(0, (Date.now() - ts) / 60000);
  if (m < 1) return t('الان', 'now');
  if (m < 60) return t('{n} دقیقه', '{n}m', { n: Math.floor(m) });
  const h = m / 60;
  if (h < 24) return t('{n} ساعت', '{n}h', { n: Math.floor(h) });
  const d = h / 24;
  if (d < 7) return t('{n} روز', '{n}d', { n: Math.floor(d) });
  if (d < 35) return t('{n} هفته', '{n}w', { n: Math.floor(d / 7) });
  if (d < 365) return t('{n} ماه', '{n}mo', { n: Math.floor(d / 30) });
  return t('{n} سال', '{n}y', { n: Math.floor(d / 365) });
}

export function store<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(`gisoo-shell:${key}`);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}
export function save(key: string, value: unknown): void {
  try {
    localStorage.setItem(`gisoo-shell:${key}`, JSON.stringify(value));
  } catch {
    /* only a convenience */
  }
}

export type DiffLine = { kind: 'same' | 'add' | 'del'; text: string; a?: number; b?: number } | { kind: 'gap'; count: number };

/** A line diff with three lines of context around each change. Large middles fall back to "all removed, all added". */
export function lineDiff(before: string, after: string): DiffLine[] {
  const a = before.split('\n');
  const b = after.split('\n');
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  const ops: Array<{ kind: 'same' | 'add' | 'del'; text: string }> = [];
  if (midA.length * midB.length <= 4_000_000) {
    // Longest common subsequence over the changed middle.
    const n = midA.length;
    const m = midB.length;
    const w = m + 1;
    const dp = new Uint32Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        dp[i * w + j] = midA[i] === midB[j] ? dp[(i + 1) * w + j + 1] + 1 : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (midA[i] === midB[j]) {
        ops.push({ kind: 'same', text: midA[i] });
        i++;
        j++;
      } else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) ops.push({ kind: 'del', text: midA[i++] });
      else ops.push({ kind: 'add', text: midB[j++] });
    }
    while (i < n) ops.push({ kind: 'del', text: midA[i++] });
    while (j < m) ops.push({ kind: 'add', text: midB[j++] });
  } else {
    for (const l of midA) ops.push({ kind: 'del', text: l });
    for (const l of midB) ops.push({ kind: 'add', text: l });
  }
  const all = [...a.slice(0, start).map((text) => ({ kind: 'same' as const, text })), ...ops, ...a.slice(endA).map((text) => ({ kind: 'same' as const, text }))];

  // Number the lines, then keep only context around changes.
  const numbered: DiffLine[] = [];
  let la = 1;
  let lb = 1;
  for (const op of all) {
    if (op.kind === 'same') numbered.push({ ...op, a: la++, b: lb++ });
    else if (op.kind === 'del') numbered.push({ ...op, a: la++ });
    else numbered.push({ ...op, b: lb++ });
  }
  const keep = new Array(numbered.length).fill(false);
  numbered.forEach((l, idx) => {
    if (l.kind !== 'same') for (let k = Math.max(0, idx - 3); k <= Math.min(numbered.length - 1, idx + 3); k++) keep[k] = true;
  });
  const out: DiffLine[] = [];
  let skipped = 0;
  numbered.forEach((l, idx) => {
    if (keep[idx]) {
      if (skipped) out.push({ kind: 'gap', count: skipped });
      skipped = 0;
      out.push(l);
    } else skipped++;
  });
  if (skipped) out.push({ kind: 'gap', count: skipped });
  return out;
}
