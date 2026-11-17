/**
 * The `vscode` module for the extension core running inside Gisoo Desktop.
 *
 * esbuild maps every `import * as vscode from 'vscode'` in `src/` to this file. It implements the part
 * of the VS Code API the core uses, on plain Node and the desktop shell:
 *  - the workspace is the project of the calling code (see scope.ts), so one process serves many projects;
 *  - files, globbing and watching use node:fs; edits are written straight to disk;
 *  - dialogs, documents, diffs, links and the clipboard go to the shell through `host()`;
 *  - language-server features (symbols, references, diagnostics) report "none", which the core already
 *    handles as "no language server for this file".
 * Types come from @types/vscode at type-check time; this file only has to behave the same.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { AsyncResource } from 'node:async_hooks';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { globToRegExp } from './glob';
import { host } from './host';
import { currentProject } from './scope';
import { defaultValue, SettingsStore } from './settings';

// -- Basics -------------------------------------------------------------------------------------------

export class Disposable {
  private done = false;
  constructor(private readonly callOnDispose: () => unknown) {}
  static from(...items: Array<{ dispose(): unknown }>): Disposable {
    return new Disposable(() => {
      for (const i of items) i?.dispose();
    });
  }
  dispose(): void {
    if (this.done) return;
    this.done = true;
    this.callOnDispose();
  }
}

export type Event<T> = (listener: (e: T) => unknown, thisArgs?: unknown, disposables?: Disposable[]) => Disposable;

/**
 * Listeners keep the project they were registered in: a context provider built for project A that
 * listens to a global event still runs as project A when the event fires.
 */
export class EventEmitter<T> {
  private readonly listeners = new Set<(e: T) => unknown>();
  private disposed = false;

  readonly event: Event<T> = (listener, thisArgs, disposables) => {
    const fn = AsyncResource.bind(thisArgs ? listener.bind(thisArgs) : listener);
    if (!this.disposed) this.listeners.add(fn);
    const d = new Disposable(() => this.listeners.delete(fn));
    disposables?.push(d);
    return d;
  };

  fire(e: T): void {
    for (const l of [...this.listeners]) {
      try {
        const r = l(e);
        if (r && typeof (r as Promise<unknown>).catch === 'function') (r as Promise<unknown>).catch((err) => console.error(err));
      } catch (err) {
        console.error(err);
      }
    }
  }

  dispose(): void {
    this.disposed = true;
    this.listeners.clear();
  }
}

export class CancellationTokenSource {
  private readonly emitter = new EventEmitter<void>();
  readonly token = {
    isCancellationRequested: false,
    onCancellationRequested: this.emitter.event,
  };
  cancel(): void {
    if (this.token.isCancellationRequested) return;
    this.token.isCancellationRequested = true;
    this.emitter.fire();
  }
  dispose(): void {
    this.emitter.dispose();
  }
}

// -- Uri ----------------------------------------------------------------------------------------------

const URI_RE = /^([a-zA-Z][\w+.-]*):(?:\/\/([^/?#]*))?([^?#]*)(?:\?([^#]*))?(?:#(.*))?$/;

function decode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

function encodePath(p: string): string {
  return p.split('/').map((seg) => encodeURIComponent(seg).replace(/%3A/gi, ':')).join('/');
}

export class Uri {
  private constructor(
    readonly scheme: string,
    readonly authority: string,
    readonly path: string,
    readonly query: string,
    readonly fragment: string,
    private readonly raw?: string,
  ) {}

  static file(fsPath: string): Uri {
    let p = fsPath.replace(/\\/g, '/');
    let authority = '';
    if (p.startsWith('//')) {
      const end = p.indexOf('/', 2);
      authority = end < 0 ? p.slice(2) : p.slice(2, end);
      p = end < 0 ? '/' : p.slice(end);
    }
    if (!p.startsWith('/')) p = `/${p}`;
    return new Uri('file', authority, p, '', '');
  }

  static parse(value: string, _strict?: boolean): Uri {
    const m = URI_RE.exec(value);
    if (!m) throw new Error(`Invalid URI: ${value}`);
    return new Uri(m[1].toLowerCase(), decode(m[2] ?? ''), decode(m[3] ?? ''), m[4] ?? '', decode(m[5] ?? ''), value);
  }

  static from(c: { scheme: string; authority?: string; path?: string; query?: string; fragment?: string }): Uri {
    return new Uri(c.scheme, c.authority ?? '', c.path ?? '', c.query ?? '', c.fragment ?? '');
  }

  static joinPath(base: Uri, ...segments: string[]): Uri {
    return base.with({ path: path.posix.join(base.path || '/', ...segments) });
  }

  get fsPath(): string {
    let p = this.path;
    if (this.authority && this.scheme === 'file') p = `//${this.authority}${p}`;
    else if (/^\/[a-zA-Z]:/.test(p)) p = p.slice(1);
    return process.platform === 'win32' ? p.replace(/\//g, '\\') : p;
  }

  with(change: { scheme?: string; authority?: string; path?: string; query?: string; fragment?: string }): Uri {
    return new Uri(change.scheme ?? this.scheme, change.authority ?? this.authority, change.path ?? this.path, change.query ?? this.query, change.fragment ?? this.fragment);
  }

  toString(skipEncoding = false): string {
    if (this.raw !== undefined) return this.raw;
    const p = skipEncoding ? this.path : encodePath(this.path);
    const auth = this.authority || this.scheme === 'file' ? `//${this.authority}` : '';
    return `${this.scheme}:${auth}${p}${this.query ? `?${this.query}` : ''}${this.fragment ? `#${skipEncoding ? this.fragment : encodeURIComponent(this.fragment)}` : ''}`;
  }

  toJSON(): unknown {
    return { scheme: this.scheme, authority: this.authority, path: this.path, query: this.query, fragment: this.fragment, fsPath: this.fsPath };
  }
}

// -- Positions, ranges, symbols, diagnostics -----------------------------------------------------------

export class Position {
  constructor(readonly line: number, readonly character: number) {}
  isBefore(o: Position): boolean {
    return this.line < o.line || (this.line === o.line && this.character < o.character);
  }
  isEqual(o: Position): boolean {
    return this.line === o.line && this.character === o.character;
  }
  translate(lineDelta = 0, charDelta = 0): Position {
    return new Position(this.line + lineDelta, this.character + charDelta);
  }
}

export class Range {
  readonly start: Position;
  readonly end: Position;
  constructor(a: Position | number, b: Position | number, c?: number, d?: number) {
    if (typeof a === 'number') {
      this.start = new Position(a, b as number);
      this.end = new Position(c ?? 0, d ?? 0);
    } else {
      this.start = a;
      this.end = b as Position;
    }
  }
  get isEmpty(): boolean {
    return this.start.isEqual(this.end);
  }
}

export class Selection extends Range {
  get anchor(): Position {
    return this.start;
  }
  get active(): Position {
    return this.end;
  }
}

export class Location {
  constructor(readonly uri: Uri, readonly range: Range) {}
}

export enum SymbolKind {
  File, Module, Namespace, Package, Class, Method, Property, Field, Constructor, Enum, Interface, Function, Variable, Constant, String, Number,
  Boolean, Array, Object, Key, Null, EnumMember, Struct, Event, Operator, TypeParameter,
}

export class DocumentSymbol {
  children: DocumentSymbol[] = [];
  constructor(readonly name: string, readonly detail: string, readonly kind: SymbolKind, readonly range: Range, readonly selectionRange: Range) {}
}

export class SymbolInformation {
  constructor(readonly name: string, readonly kind: SymbolKind, readonly containerName: string, readonly location: Location) {}
}

export enum DiagnosticSeverity { Error = 0, Warning = 1, Information = 2, Hint = 3 }

export class Diagnostic {
  source?: string;
  code?: string | number;
  constructor(readonly range: Range, readonly message: string, readonly severity: DiagnosticSeverity = DiagnosticSeverity.Error) {}
}

export class ThemeIcon {
  constructor(readonly id: string, readonly color?: ThemeColor) {}
}

export class ThemeColor {
  constructor(readonly id: string) {}
}

export enum TreeItemCollapsibleState { None = 0, Collapsed = 1, Expanded = 2 }

export class TreeItem {
  description?: string;
  tooltip?: string;
  iconPath?: unknown;
  command?: unknown;
  contextValue?: string;
  id?: string;
  constructor(readonly label: string, readonly collapsibleState: TreeItemCollapsibleState = TreeItemCollapsibleState.None) {}
}

export enum StatusBarAlignment { Left = 1, Right = 2 }
export enum ViewColumn { Active = -1, Beside = -2, One = 1, Two = 2, Three = 3 }
export enum ProgressLocation { SourceControl = 1, Window = 10, Notification = 15 }
export enum ConfigurationTarget { Global = 1, Workspace = 2, WorkspaceFolder = 3 }
export enum QuickPickItemKind { Separator = -1, Default = 0 }
export enum FileType { Unknown = 0, File = 1, Directory = 2, SymbolicLink = 64 }
export enum EndOfLine { LF = 1, CRLF = 2 }
export enum TaskScope { Global = 1, Workspace = 2 }
export enum TaskRevealKind { Always = 1, Silent = 2, Never = 3 }
export enum TaskPanelKind { Shared = 1, Dedicated = 2, New = 3 }
export enum UIKind { Desktop = 1, Web = 2 }

export class FileSystemError extends Error {
  constructor(message: string, readonly code: string = 'Unknown') {
    super(message);
  }
  static FileNotFound(what?: unknown): FileSystemError {
    return new FileSystemError(`File not found: ${String(what ?? '')}`, 'FileNotFound');
  }
  static FileExists(what?: unknown): FileSystemError {
    return new FileSystemError(`File exists: ${String(what ?? '')}`, 'FileExists');
  }
  static NoPermissions(what?: unknown): FileSystemError {
    return new FileSystemError(`No permissions: ${String(what ?? '')}`, 'NoPermissions');
  }
}

function fsError(err: unknown, uri: Uri): unknown {
  const code = (err as NodeJS.ErrnoException)?.code;
  if (code === 'ENOENT' || code === 'ENOTDIR') return FileSystemError.FileNotFound(uri.fsPath);
  if (code === 'EEXIST') return FileSystemError.FileExists(uri.fsPath);
  if (code === 'EACCES' || code === 'EPERM') return FileSystemError.NoPermissions(uri.fsPath);
  return err;
}

// -- Patterns ------------------------------------------------------------------------------------------

export interface WorkspaceFolder {
  readonly uri: Uri;
  readonly name: string;
  readonly index: number;
}

export class RelativePattern {
  readonly baseUri: Uri;
  readonly base: string;
  constructor(base: WorkspaceFolder | Uri | string, readonly pattern: string) {
    this.baseUri = typeof base === 'string' ? Uri.file(base) : base instanceof Uri ? base : base.uri;
    this.base = this.baseUri.fsPath;
  }
}

type GlobPattern = string | RelativePattern;

// -- Text documents --------------------------------------------------------------------------------------

const EXT_LANG: Record<string, string> = {
  ts: 'typescript', tsx: 'typescriptreact', js: 'javascript', jsx: 'javascriptreact', mjs: 'javascript', cjs: 'javascript', json: 'json', md: 'markdown',
  py: 'python', php: 'php', rb: 'ruby', go: 'go', rs: 'rust', java: 'java', kt: 'kotlin', cs: 'csharp', c: 'c', h: 'c', cpp: 'cpp', hpp: 'cpp',
  css: 'css', scss: 'scss', html: 'html', vue: 'vue', svelte: 'svelte', sh: 'shellscript', ps1: 'powershell', yml: 'yaml', yaml: 'yaml', sql: 'sql',
  xml: 'xml', swift: 'swift', dart: 'dart', toml: 'toml', ini: 'ini', diff: 'diff', txt: 'plaintext',
};

export function languageOf(file: string): string {
  if (/blade\.php$/i.test(file)) return 'blade';
  return EXT_LANG[path.extname(file).slice(1).toLowerCase()] ?? 'plaintext';
}

class TextLine {
  constructor(readonly lineNumber: number, readonly text: string) {}
  get isEmptyOrWhitespace(): boolean {
    return !this.text.trim();
  }
  get range(): Range {
    return new Range(this.lineNumber, 0, this.lineNumber, this.text.length);
  }
}

export class TextDocument {
  private lineStarts: number[] | undefined;
  readonly isDirty = false;
  readonly isUntitled: boolean;
  readonly version = 1;
  constructor(readonly uri: Uri, private text: string, readonly languageId: string) {
    this.isUntitled = uri.scheme === 'untitled';
  }
  get fileName(): string {
    return this.uri.fsPath;
  }
  get eol(): EndOfLine {
    return this.text.includes('\r\n') ? EndOfLine.CRLF : EndOfLine.LF;
  }
  getText(range?: Range): string {
    if (!range) return this.text;
    return this.text.slice(this.offsetAt(range.start), this.offsetAt(range.end));
  }
  private starts(): number[] {
    if (!this.lineStarts) {
      const s = [0];
      for (let i = 0; i < this.text.length; i++) if (this.text.charCodeAt(i) === 10) s.push(i + 1);
      this.lineStarts = s;
    }
    return this.lineStarts;
  }
  get lineCount(): number {
    return this.starts().length;
  }
  lineAt(lineOrPos: number | Position): TextLine {
    const line = typeof lineOrPos === 'number' ? lineOrPos : lineOrPos.line;
    const s = this.starts();
    const start = s[line] ?? this.text.length;
    const end = line + 1 < s.length ? s[line + 1] - 1 : this.text.length;
    return new TextLine(line, this.text.slice(start, end).replace(/\r$/, ''));
  }
  offsetAt(pos: Position): number {
    const s = this.starts();
    const line = Math.min(Math.max(pos.line, 0), s.length - 1);
    return Math.min(s[line] + pos.character, this.text.length);
  }
  positionAt(offset: number): Position {
    const s = this.starts();
    const o = Math.min(Math.max(offset, 0), this.text.length);
    let lo = 0;
    let hi = s.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (s[mid] <= o) lo = mid;
      else hi = mid - 1;
    }
    return new Position(lo, o - s[lo]);
  }
  async save(): Promise<boolean> {
    return true;
  }
}

export interface TextDocumentContentProvider {
  onDidChange?: Event<Uri>;
  provideTextDocumentContent(uri: Uri, token: unknown): string | undefined | null | Promise<string | undefined | null>;
}

const contentProviders = new Map<string, TextDocumentContentProvider>();

// -- Workspace edits ----------------------------------------------------------------------------------------

type EditOp =
  | { kind: 'create'; uri: Uri; overwrite?: boolean; ignoreIfExists?: boolean }
  | { kind: 'delete'; uri: Uri; recursive?: boolean; ignoreIfNotExists?: boolean }
  | { kind: 'rename'; from: Uri; to: Uri; overwrite?: boolean }
  | { kind: 'text'; uri: Uri; range: Range; text: string };

export class WorkspaceEdit {
  readonly ops: EditOp[] = [];
  createFile(uri: Uri, options: { overwrite?: boolean; ignoreIfExists?: boolean } = {}): void {
    this.ops.push({ kind: 'create', uri, ...options });
  }
  deleteFile(uri: Uri, options: { recursive?: boolean; ignoreIfNotExists?: boolean } = {}): void {
    this.ops.push({ kind: 'delete', uri, ...options });
  }
  renameFile(from: Uri, to: Uri, options: { overwrite?: boolean } = {}): void {
    this.ops.push({ kind: 'rename', from, to, ...options });
  }
  replace(uri: Uri, range: Range, text: string): void {
    this.ops.push({ kind: 'text', uri, range, text });
  }
  insert(uri: Uri, position: Position, text: string): void {
    this.ops.push({ kind: 'text', uri, range: new Range(position, position), text });
  }
  delete(uri: Uri, range: Range): void {
    this.ops.push({ kind: 'text', uri, range, text: '' });
  }
  get size(): number {
    return this.ops.length;
  }
}

async function readOrEmpty(file: string): Promise<string> {
  try {
    return await fsp.readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw err;
  }
}

async function applyEditOps(edit: WorkspaceEdit): Promise<boolean> {
  const pending = new Map<string, string>();
  const text = async (uri: Uri): Promise<string> => pending.get(uri.fsPath) ?? (await readOrEmpty(uri.fsPath));
  for (const op of edit.ops) {
    if (op.kind === 'create') {
      const exists = fs.existsSync(op.uri.fsPath) || pending.has(op.uri.fsPath);
      if (exists && op.ignoreIfExists) continue;
      if (exists && !op.overwrite && !op.ignoreIfExists) return false;
      pending.set(op.uri.fsPath, '');
    } else if (op.kind === 'delete') {
      pending.delete(op.uri.fsPath);
      try {
        await fsp.rm(op.uri.fsPath, { recursive: Boolean(op.recursive), force: Boolean(op.ignoreIfNotExists) });
      } catch (err) {
        if (!op.ignoreIfNotExists) throw fsError(err, op.uri);
      }
    } else if (op.kind === 'rename') {
      await fsp.mkdir(path.dirname(op.to.fsPath), { recursive: true });
      await fsp.rename(op.from.fsPath, op.to.fsPath);
    } else {
      const before = await text(op.uri);
      const doc = new TextDocument(op.uri, before, 'plaintext');
      const a = doc.offsetAt(op.range.start);
      const b = doc.offsetAt(op.range.end);
      pending.set(op.uri.fsPath, before.slice(0, a) + op.text + before.slice(b));
    }
  }
  for (const [file, content] of pending) {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(file, content, 'utf8');
    savedEmitter.fire(new TextDocument(Uri.file(file), content, languageOf(file)));
  }
  return true;
}

// -- Settings ---------------------------------------------------------------------------------------------

let settingsStore: SettingsStore | undefined;
const configEmitter = new EventEmitter<{ affectsConfiguration(section: string): boolean }>();

/** Called once by the main process before the core starts. */
export function installSettings(store: SettingsStore): void {
  settingsStore = store;
  store.onDidChange((keys) => {
    configEmitter.fire({ affectsConfiguration: (section: string) => keys.some((k) => k === section || k.startsWith(`${section}.`) || section.startsWith(`${k}.`)) });
  });
}

function settings(): SettingsStore {
  if (!settingsStore) settingsStore = new SettingsStore(path.join(os.tmpdir(), 'gisoo-desktop-settings.json'));
  return settingsStore;
}

function configuration(section?: string) {
  const full = (key: string): string => (section ? `${section}.${key}` : key);
  const inspect = <T>(key: string) => {
    const k = full(key);
    // A folder's own `.gisoo/settings.json` counts only once the folder is trusted: a cloned repository
    // must not pick the model (and so the bill) or anything else before the owner says yes.
    const project = currentProject();
    const root = project?.trusted ? project.root : undefined;
    return {
      key: k,
      defaultValue: defaultValue(k) as T | undefined,
      globalValue: settings().userValue(k) as T | undefined,
      workspaceValue: settings().projectValue(root, k) as T | undefined,
      workspaceFolderValue: undefined as T | undefined,
    };
  };
  return {
    get<T>(key: string, fallback?: T): T | undefined {
      const i = inspect<T>(key);
      const v = i.workspaceValue !== undefined ? i.workspaceValue : i.globalValue !== undefined ? i.globalValue : i.defaultValue;
      return v === undefined ? fallback : v;
    },
    has(key: string): boolean {
      const i = inspect(key);
      return i.defaultValue !== undefined || i.globalValue !== undefined || i.workspaceValue !== undefined;
    },
    inspect,
    async update(key: string, value: unknown, target?: ConfigurationTarget | boolean): Promise<void> {
      const k = full(key);
      const root = currentProject()?.root;
      const toWorkspace = target === ConfigurationTarget.Workspace || target === ConfigurationTarget.WorkspaceFolder || target === false;
      if (toWorkspace && root) settings().setProject(root, k, value);
      else settings().setUser(k, value);
    },
  };
}

// -- Files: find and watch -----------------------------------------------------------------------------------

/** Folders never walked: VS Code's default `files.exclude` plus the usual heavy dependency folders when excluded. */
const ALWAYS_SKIP = new Set(['.git', '.svn', '.hg', 'CVS', '.DS_Store']);

function patternParts(include: GlobPattern): { base: string[]; glob: string } {
  if (include instanceof RelativePattern) return { base: [include.base], glob: include.pattern };
  return { base: workspaceRootsNow(), glob: include };
}

async function findFiles(include: GlobPattern, exclude?: GlobPattern | null, maxResults?: number, token?: { isCancellationRequested: boolean }): Promise<Uri[]> {
  const { base, glob } = patternParts(include);
  const inc = globToRegExp(glob);
  const exc = exclude ? globToRegExp(exclude instanceof RelativePattern ? exclude.pattern : exclude) : undefined;
  const max = maxResults ?? Number.MAX_SAFE_INTEGER;
  const out: Uri[] = [];
  for (const root of base) {
    const queue: string[] = [''];
    while (queue.length && out.length < max) {
      if (token?.isCancellationRequested) return out;
      const rel = queue.shift() as string;
      let entries: fs.Dirent[];
      try {
        entries = await fsp.readdir(path.join(root, rel), { withFileTypes: true });
      } catch {
        continue;
      }
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const e of entries) {
        if (ALWAYS_SKIP.has(e.name)) continue;
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) {
          // `x/**` in the exclude prunes the folder without walking it.
          if (exc && (exc.test(`${r}/`) || exc.test(`${r}/x`))) continue;
          queue.push(r);
        } else if (e.isFile() || e.isSymbolicLink()) {
          if (exc?.test(r)) continue;
          if (inc.test(r)) {
            out.push(Uri.file(path.join(root, r)));
            if (out.length >= max) break;
          }
        }
      }
    }
  }
  return out;
}

interface RootWatch {
  watcher: fs.FSWatcher | undefined;
  subs: Set<(kind: 'change' | 'create' | 'delete', rel: string, abs: string) => void>;
}

const rootWatches = new Map<string, RootWatch>();

function watchRoot(root: string, fn: (kind: 'change' | 'create' | 'delete', rel: string, abs: string) => void): () => void {
  let w = rootWatches.get(root);
  if (!w) {
    const entry: RootWatch = { watcher: undefined, subs: new Set() };
    w = entry;
    try {
      entry.watcher = fs.watch(root, { recursive: true, persistent: false }, (event, name) => {
        if (!name) return;
        const rel = String(name).replace(/\\/g, '/');
        if (/(^|\/)(node_modules|\.git)(\/|$)/.test(rel)) return;
        const abs = path.join(root, rel);
        const kind = event === 'change' ? 'change' : fs.existsSync(abs) ? 'create' : 'delete';
        for (const s of [...entry.subs]) s(kind, rel, abs);
      });
      entry.watcher.on('error', () => undefined);
    } catch {
      /* the folder may be gone; nothing to watch */
    }
    rootWatches.set(root, entry);
  }
  const bound = AsyncResource.bind(fn);
  w.subs.add(bound);
  return () => {
    w.subs.delete(bound);
    if (!w.subs.size) {
      w.watcher?.close();
      rootWatches.delete(root);
    }
  };
}

function createFileSystemWatcher(pattern: GlobPattern) {
  const { base, glob } = patternParts(pattern);
  const re = globToRegExp(glob);
  const changed = new EventEmitter<Uri>();
  const created = new EventEmitter<Uri>();
  const deleted = new EventEmitter<Uri>();
  const stops = base.map((root) =>
    watchRoot(root, (kind, rel, abs) => {
      if (!re.test(rel)) return;
      (kind === 'change' ? changed : kind === 'create' ? created : deleted).fire(Uri.file(abs));
    }),
  );
  return {
    onDidChange: changed.event,
    onDidCreate: created.event,
    onDidDelete: deleted.event,
    ignoreChangeEvents: false,
    ignoreCreateEvents: false,
    ignoreDeleteEvents: false,
    dispose: () => {
      stops.forEach((s) => s());
      changed.dispose();
      created.dispose();
      deleted.dispose();
    },
  };
}

// -- Workspace -------------------------------------------------------------------------------------------------

function workspaceRootsNow(): string[] {
  const p = currentProject();
  return p ? [p.root] : [];
}

const savedEmitter = new EventEmitter<TextDocument>();
const foldersEmitter = new EventEmitter<{ added: WorkspaceFolder[]; removed: WorkspaceFolder[] }>();
const trustEmitter = new EventEmitter<void>();

/** The shell granted trust to the current project. */
export function fireTrustGranted(): void {
  trustEmitter.fire();
}

const folderCache = new Map<string, WorkspaceFolder>();

function folderOf(root: string, name: string): WorkspaceFolder {
  let f = folderCache.get(root);
  if (!f) {
    f = { uri: Uri.file(root), name, index: 0 };
    folderCache.set(root, f);
  }
  return f;
}

async function openTextDocument(arg: Uri | string | { content?: string; language?: string }): Promise<TextDocument> {
  if (typeof arg === 'string') arg = Uri.file(arg);
  if (arg instanceof Uri) {
    if (arg.scheme === 'file') {
      try {
        const text = await fsp.readFile(arg.fsPath, 'utf8');
        return new TextDocument(arg, text, languageOf(arg.fsPath));
      } catch (err) {
        throw fsError(err, arg);
      }
    }
    const provider = contentProviders.get(arg.scheme);
    if (!provider) throw new Error(`Cannot open ${arg.toString()}`);
    const text = (await provider.provideTextDocumentContent(arg, new CancellationTokenSource().token)) ?? '';
    return new TextDocument(arg, text, languageOf(arg.path));
  }
  return new TextDocument(Uri.from({ scheme: 'untitled', path: `Untitled-${randomUUID().slice(0, 4)}` }), arg.content ?? '', arg.language ?? 'plaintext');
}

const fsApi = {
  async readFile(uri: Uri): Promise<Uint8Array> {
    try {
      return new Uint8Array(await fsp.readFile(uri.fsPath));
    } catch (err) {
      throw fsError(err, uri);
    }
  },
  async writeFile(uri: Uri, content: Uint8Array): Promise<void> {
    await fsp.mkdir(path.dirname(uri.fsPath), { recursive: true });
    await fsp.writeFile(uri.fsPath, content);
  },
  async stat(uri: Uri): Promise<{ type: FileType; ctime: number; mtime: number; size: number }> {
    try {
      const s = await fsp.stat(uri.fsPath);
      return { type: s.isDirectory() ? FileType.Directory : s.isFile() ? FileType.File : FileType.Unknown, ctime: s.ctimeMs, mtime: s.mtimeMs, size: s.size };
    } catch (err) {
      throw fsError(err, uri);
    }
  },
  async readDirectory(uri: Uri): Promise<Array<[string, FileType]>> {
    try {
      const entries = await fsp.readdir(uri.fsPath, { withFileTypes: true });
      return entries.map((e) => [e.name, e.isDirectory() ? FileType.Directory : e.isFile() ? FileType.File : e.isSymbolicLink() ? FileType.SymbolicLink : FileType.Unknown]);
    } catch (err) {
      throw fsError(err, uri);
    }
  },
  async createDirectory(uri: Uri): Promise<void> {
    await fsp.mkdir(uri.fsPath, { recursive: true });
  },
  async delete(uri: Uri, options: { recursive?: boolean } = {}): Promise<void> {
    try {
      await fsp.rm(uri.fsPath, { recursive: Boolean(options.recursive) });
    } catch (err) {
      throw fsError(err, uri);
    }
  },
  async rename(from: Uri, to: Uri): Promise<void> {
    await fsp.rename(from.fsPath, to.fsPath);
  },
  async copy(from: Uri, to: Uri): Promise<void> {
    await fsp.cp(from.fsPath, to.fsPath, { recursive: true });
  },
};

export const workspace = {
  get workspaceFolders(): WorkspaceFolder[] | undefined {
    const p = currentProject();
    return p ? [folderOf(p.root, p.name)] : undefined;
  },
  get name(): string | undefined {
    return currentProject()?.name;
  },
  get rootPath(): string | undefined {
    return currentProject()?.root;
  },
  get isTrusted(): boolean {
    return currentProject()?.trusted ?? false;
  },
  get textDocuments(): TextDocument[] {
    return [];
  },
  getWorkspaceFolder(uri: Uri): WorkspaceFolder | undefined {
    const p = currentProject();
    if (!p) return undefined;
    const rel = path.relative(p.root, uri.fsPath);
    return !rel.startsWith('..') && !path.isAbsolute(rel) ? folderOf(p.root, p.name) : undefined;
  },
  asRelativePath(target: Uri | string): string {
    const abs = typeof target === 'string' ? target : target.fsPath;
    const root = currentProject()?.root;
    if (!root) return abs;
    const rel = path.relative(root, abs);
    return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel.replace(/\\/g, '/') : abs;
  },
  getConfiguration: configuration,
  onDidChangeConfiguration: configEmitter.event,
  onDidSaveTextDocument: savedEmitter.event,
  onDidOpenTextDocument: new EventEmitter<TextDocument>().event,
  onDidCloseTextDocument: new EventEmitter<TextDocument>().event,
  onDidChangeTextDocument: new EventEmitter<unknown>().event,
  onDidChangeWorkspaceFolders: foldersEmitter.event,
  onDidGrantWorkspaceTrust: trustEmitter.event,
  openTextDocument,
  applyEdit: applyEditOps,
  findFiles,
  createFileSystemWatcher,
  registerTextDocumentContentProvider(scheme: string, provider: TextDocumentContentProvider): Disposable {
    contentProviders.set(scheme, provider);
    return new Disposable(() => {
      if (contentProviders.get(scheme) === provider) contentProviders.delete(scheme);
    });
  },
  fs: fsApi,
};

// -- Window --------------------------------------------------------------------------------------------------------

type MessageItem = string | { title: string; isCloseAffordance?: boolean };

function message(level: 'info' | 'warning' | 'error') {
  return async (text: string, ...rest: unknown[]): Promise<MessageItem | undefined> => {
    let options: { modal?: boolean; detail?: string } = {};
    if (rest.length && rest[0] && typeof rest[0] === 'object' && !('title' in (rest[0] as object))) options = rest.shift() as typeof options;
    const items = rest.filter((r): r is MessageItem => typeof r === 'string' || (typeof r === 'object' && r !== null && 'title' in r));
    const labels = items.map((i) => (typeof i === 'string' ? i : i.title));
    const picked = await host().message(level, text, options, labels);
    return picked === undefined ? undefined : items[picked];
  };
}

interface QuickPickLike {
  label: string;
  description?: string;
  detail?: string;
  kind?: QuickPickItemKind;
  picked?: boolean;
}

/** `$(icon) label` → `label`; the desktop pickers draw no codicons inside text. */
const stripIcons = (s: string | undefined): string | undefined => s?.replace(/\$\([\w-]+(?:~[\w-]+)?\)\s*/g, '');

async function showQuickPick(source: Array<string | QuickPickLike> | Promise<Array<string | QuickPickLike>>, options: { title?: string; placeHolder?: string; canPickMany?: boolean } = {}): Promise<unknown> {
  const items = await source;
  const view = items.map((i) =>
    typeof i === 'string'
      ? { label: i }
      : { label: stripIcons(i.label) ?? '', description: stripIcons(i.description), detail: stripIcons(i.detail), separator: i.kind === QuickPickItemKind.Separator, picked: i.picked },
  );
  const picked = await host().quickPick(view, options);
  if (!picked) return undefined;
  return options.canPickMany ? picked.map((n) => items[n]) : items[picked[0]];
}

async function showInputBox(options: {
  title?: string;
  prompt?: string;
  placeHolder?: string;
  value?: string;
  password?: boolean;
  /** Accepted for compatibility; the desktop dialog never closes on blur. */
  ignoreFocusOut?: boolean;
  validateInput?: (value: string) => string | undefined | null | Promise<string | undefined | null> | { message: string };
} = {}): Promise<string | undefined> {
  let value = options.value;
  let error: string | undefined;
  for (;;) {
    const answer = await host().inputBox({ title: options.title, prompt: options.prompt, placeHolder: options.placeHolder, value, password: options.password, error });
    if (answer === undefined) return undefined;
    const problem = options.validateInput ? await options.validateInput(answer) : undefined;
    const text = typeof problem === 'string' ? problem : problem && typeof problem === 'object' ? problem.message : undefined;
    if (!text) return answer;
    value = answer;
    error = text;
  }
}

async function showOpenDialog(options: { title?: string; canSelectFiles?: boolean; canSelectFolders?: boolean; canSelectMany?: boolean; filters?: Record<string, string[]>; defaultUri?: Uri; openLabel?: string } = {}): Promise<Uri[] | undefined> {
  const picked = await host().openDialog({
    title: options.title,
    folders: Boolean(options.canSelectFolders) && !options.canSelectFiles,
    many: options.canSelectMany,
    filters: options.filters,
    defaultPath: options.defaultUri?.fsPath,
  });
  return picked?.map((p) => Uri.file(p));
}

async function showTextDocument(target: TextDocument | Uri, options: { selection?: Range } = {}): Promise<unknown> {
  const doc = target instanceof TextDocument ? target : await openTextDocument(target);
  const isFile = doc.uri.scheme === 'file';
  const title = isFile ? path.basename(doc.uri.fsPath) : doc.uri.scheme === 'untitled' ? (doc.languageId === 'diff' ? 'Diff' : 'Untitled') : path.posix.basename(doc.uri.path);
  await host().showDocument({ title, path: isFile ? doc.uri.fsPath : undefined, content: doc.getText(), language: doc.languageId, line: options.selection ? options.selection.start.line + 1 : undefined });
  return undefined;
}

async function withProgress<R>(options: { title?: string; cancellable?: boolean }, task: (progress: { report(v: { message?: string; increment?: number }): void }, token: CancellationTokenSource['token']) => Thenable<R>): Promise<R> {
  const id = randomUUID();
  const source = new CancellationTokenSource();
  host().progress(id, options.title ?? '', false);
  try {
    return await task({ report: () => undefined }, source.token);
  } finally {
    host().progress(id, options.title ?? '', true);
    source.dispose();
  }
}

type Thenable<T> = PromiseLike<T>;

/** A status-bar item: the desktop has no status bar; the shell reads the graph state elsewhere. */
function createStatusBarItem() {
  return { text: '', tooltip: '', name: '', command: undefined as unknown, backgroundColor: undefined as unknown, show: () => undefined, hide: () => undefined, dispose: () => undefined };
}

const noopDisposable = (): Disposable => new Disposable(() => undefined);

export const window = {
  get activeTextEditor(): undefined {
    return undefined;
  },
  get visibleTextEditors(): unknown[] {
    return [];
  },
  get state(): { focused: boolean } {
    return { focused: true };
  },
  onDidChangeActiveTextEditor: new EventEmitter<unknown>().event,
  onDidChangeTextEditorSelection: new EventEmitter<unknown>().event,
  onDidChangeWindowState: new EventEmitter<unknown>().event,
  showInformationMessage: message('info'),
  showWarningMessage: message('warning'),
  showErrorMessage: message('error'),
  showQuickPick,
  showInputBox,
  showOpenDialog,
  showTextDocument,
  withProgress,
  createStatusBarItem,
  createOutputChannel: (name: string) => ({ name, append: () => undefined, appendLine: (l: string) => console.log(`[${name}] ${l}`), clear: () => undefined, show: () => undefined, hide: () => undefined, dispose: () => undefined }),
  registerWebviewViewProvider: noopDisposable,
  registerWebviewPanelSerializer: noopDisposable,
  registerUriHandler: noopDisposable,
  createTreeView: () => ({ dispose: () => undefined, reveal: async () => undefined }),
  createWebviewPanel: () => {
    throw new Error('Editor tabs do not exist in Gisoo Desktop; open a new chat instead.');
  },
};

// -- Environment ------------------------------------------------------------------------------------------------------

let uiLanguage = 'fa';

/** The shell's own locale (Electron `app.getLocale()`), used when the language setting is "auto". */
export function setUiLanguage(lang: string): void {
  uiLanguage = lang;
}

export const env = {
  get language(): string {
    return uiLanguage;
  },
  appName: 'Gisoo',
  appHost: 'desktop',
  uriScheme: 'gisoo-desktop',
  uiKind: UIKind.Desktop,
  machineId: 'gisoo-desktop',
  sessionId: randomUUID(),
  get shell(): string {
    return process.platform === 'win32' ? process.env.ComSpec || 'cmd.exe' : process.env.SHELL || '/bin/sh';
  },
  clipboard: {
    readText: () => host().clipboardRead(),
    writeText: (text: string) => host().clipboardWrite(text),
  },
  openExternal: (uri: Uri) => host().openExternal(uri.toString(true)),
  asExternalUri: async (uri: Uri) => uri,
};

export const version = '1.99.0-gisoo-desktop';

// -- Commands --------------------------------------------------------------------------------------------------------------

const commandHandlers = new Map<string, (...args: any[]) => unknown>();

async function builtinCommand(id: string, args: unknown[]): Promise<unknown> {
  switch (id) {
    case 'setContext':
      return undefined;
    case 'vscode.diff': {
      const [left, right, title] = args as [Uri, Uri, string | undefined];
      const [a, b] = await Promise.all([openTextDocument(left), openTextDocument(right)]);
      const file = right.scheme === 'file' ? right.fsPath : right.path.replace(/^\/[^/]+\/(?:before|after)\//, '');
      await host().showDiff({ title: title ?? path.basename(file), path: file, before: a.getText(), after: b.getText() });
      return undefined;
    }
    case 'vscode.open':
      return showTextDocument(args[0] as Uri);
    case 'workbench.action.openSettings':
      return host().openSettings(typeof args[0] === 'string' ? args[0] : undefined);
    // Language-server answers: the desktop has no language servers; the core reports "none".
    case 'vscode.executeDocumentSymbolProvider':
    case 'vscode.executeWorkspaceSymbolProvider':
    case 'vscode.executeDefinitionProvider':
    case 'vscode.executeReferenceProvider':
    case 'vscode.executeHoverProvider':
      return [];
    case 'simpleBrowser.api.open':
      // No built-in browser pane: the core falls back to the system browser.
      throw new Error('simple browser not available');
    default:
      if (id.endsWith('.focus')) return undefined;
      throw new Error(`command '${id}' not found`);
  }
}

export const commands = {
  registerCommand(id: string, handler: (...args: any[]) => unknown, thisArg?: unknown): Disposable {
    const bound = AsyncResource.bind(thisArg ? handler.bind(thisArg) : handler);
    commandHandlers.set(id, bound);
    return new Disposable(() => {
      if (commandHandlers.get(id) === bound) commandHandlers.delete(id);
    });
  },
  async executeCommand<T = unknown>(id: string, ...args: unknown[]): Promise<T> {
    const handler = commandHandlers.get(id);
    if (handler) return (await handler(...args)) as T;
    return (await builtinCommand(id, args)) as T;
  },
  async getCommands(): Promise<string[]> {
    return [...commandHandlers.keys()];
  },
};

// -- Languages, extensions -------------------------------------------------------------------------------------------------

export const languages = {
  getDiagnostics(uri?: Uri): any {
    return uri ? [] : [];
  },
  onDidChangeDiagnostics: new EventEmitter<unknown>().event,
};

/** The branch of the current project, read from .git/HEAD (the prompt mentions it, as VS Code's git extension would). */
function gitBranch(): string | undefined {
  const root = currentProject()?.root;
  if (!root) return undefined;
  try {
    let gitDir = path.join(root, '.git');
    const st = fs.statSync(gitDir);
    if (st.isFile()) {
      const m = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(gitDir, 'utf8'));
      if (!m) return undefined;
      gitDir = path.resolve(root, m[1].trim());
    }
    const head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim();
    const ref = /^ref:\s*refs\/heads\/(.+)$/.exec(head);
    return ref ? ref[1] : head.slice(0, 7);
  } catch {
    return undefined;
  }
}

const gitExtension = {
  id: 'vscode.git',
  isActive: true,
  exports: {
    getAPI: () => ({
      get repositories() {
        const name = gitBranch();
        return name ? [{ state: { HEAD: { name } } }] : [];
      },
    }),
  },
  activate: async () => gitExtension.exports,
};

export const extensions = {
  getExtension(id: string): unknown {
    return id === 'vscode.git' ? gitExtension : undefined;
  },
  get all(): unknown[] {
    return [];
  },
  onDidChange: new EventEmitter<void>().event,
};

// -- Tasks (the Graphify installer runs as one) -------------------------------------------------------------------------------

export class ProcessExecution {
  constructor(readonly process: string, readonly args: string[] = [], readonly options: { cwd?: string; env?: Record<string, string> } = {}) {}
}

export class ShellExecution {
  constructor(readonly commandLine: string, readonly options: { cwd?: string; env?: Record<string, string> } = {}) {}
}

export class Task {
  presentationOptions: unknown = {};
  isBackground = false;
  constructor(readonly definition: unknown, readonly scope: unknown, readonly name: string, readonly source: string, readonly execution?: ProcessExecution | ShellExecution) {}
}

const taskEnd = new EventEmitter<{ execution: unknown; exitCode: number | undefined }>();

export const tasks = {
  onDidEndTaskProcess: taskEnd.event,
  onDidEndTask: new EventEmitter<unknown>().event,
  async executeTask(task: Task): Promise<{ task: Task; terminate(): void }> {
    const id = randomUUID();
    const exec = task.execution;
    let child: ReturnType<typeof spawn> | undefined;
    const execution = { task, terminate: () => child?.kill() };
    const finish = (code: number | undefined) => {
      host().taskOutput(id, task.name, '', code ?? -1);
      taskEnd.fire({ execution, exitCode: code });
    };
    try {
      if (exec instanceof ProcessExecution) {
        child = spawn(exec.process, exec.args, { cwd: exec.options.cwd, env: { ...process.env, ...exec.options.env }, windowsHide: true });
      } else if (exec instanceof ShellExecution) {
        child = spawn(exec.commandLine, { cwd: exec.options.cwd, env: { ...process.env, ...exec.options.env }, shell: true, windowsHide: true });
      }
    } catch (err) {
      setImmediate(() => {
        host().taskOutput(id, task.name, `${err instanceof Error ? err.message : String(err)}\n`);
        finish(1);
      });
      return execution;
    }
    if (!child) {
      setImmediate(() => finish(1));
      return execution;
    }
    host().taskOutput(id, task.name, `> ${exec instanceof ProcessExecution ? [exec.process, ...exec.args].join(' ') : (exec as ShellExecution).commandLine}\n`);
    child.stdout?.on('data', (d: Buffer) => host().taskOutput(id, task.name, d.toString('utf8')));
    child.stderr?.on('data', (d: Buffer) => host().taskOutput(id, task.name, d.toString('utf8')));
    child.on('error', (err) => {
      host().taskOutput(id, task.name, `${err.message}\n`);
      finish(1);
    });
    child.on('close', (code) => finish(code ?? undefined));
    return execution;
  },
};

// -- l10n ----------------------------------------------------------------------------------------------------------------------------

export const l10n = {
  t(message: string | { message: string; args?: unknown[] }, ...args: unknown[]): string {
    const text = typeof message === 'string' ? message : message.message;
    const values = typeof message === 'string' ? args : (message.args ?? []);
    return text.replace(/\{(\d+)\}/g, (_, n) => String(values[Number(n)] ?? ''));
  },
  bundle: undefined,
  uri: undefined,
};
