/**
 * The projects in the sidebar. A project is a folder the owner added; its chats, instruction files,
 * commands, skills and settings all live with it. The registry (folder list and trust) is kept in
 * `<userData>/projects.json`; a project's chats in `<userData>/projects/<id>/sessions`.
 */
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ContextProvider } from '../src/context/provider';
import { getSettings } from '../src/config';
import { SessionStore } from '../src/sessions/store';
import type { HostToWebview } from '../src/shared/protocol';
import { runInProject, type ProjectScope } from '../shim/scope';
import { FileMemento } from './context';
import type { ProjectInfo } from './api';

interface Entry {
  id: string;
  root: string;
  name: string;
  trusted: boolean;
  addedAt: number;
}

export interface ProjectRuntime {
  readonly scope: ProjectScope;
  readonly store: SessionStore;
  readonly context: ContextProvider;
  dispose(): void;
}

export function projectId(root: string): string {
  const norm = path.resolve(root);
  const key = process.platform === 'win32' || process.platform === 'darwin' ? norm.toLowerCase() : norm;
  return createHash('sha256').update(key).digest('hex').slice(0, 16);
}

export class Projects {
  private entries: Entry[] = [];
  private readonly runtimes = new Map<string, ProjectRuntime>();
  private readonly file: string;

  constructor(
    private readonly userData: string,
    /** Workspace news for every chat of one project (instruction files, commands, skills). */
    private readonly broadcast: (projectId: string, message: HostToWebview) => void,
  ) {
    this.file = path.join(userData, 'projects.json');
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8')) as { projects?: Entry[] };
      this.entries = Array.isArray(raw.projects) ? raw.projects.filter((e) => e && typeof e.root === 'string') : [];
    } catch {
      this.entries = [];
    }
  }

  list(): ProjectInfo[] {
    return this.entries.map((e) => ({ id: e.id, name: e.name, root: e.root, trusted: e.trusted, missing: !isDir(e.root) }));
  }

  get(id: string): ProjectInfo | undefined {
    return this.list().find((p) => p.id === id);
  }

  /** Adds a folder (or returns the project it already is). */
  add(root: string): ProjectInfo {
    const abs = path.resolve(root);
    const id = projectId(abs);
    let entry = this.entries.find((e) => e.id === id);
    if (!entry) {
      entry = { id, root: abs, name: path.basename(abs) || abs, trusted: false, addedAt: Date.now() };
      this.entries.unshift(entry);
      this.save();
    }
    return { id: entry.id, name: entry.name, root: entry.root, trusted: entry.trusted, missing: !isDir(entry.root) };
  }

  /** Forgets the folder. Its chats stay on disk; adding the folder again brings them back. */
  remove(id: string): void {
    this.runtimes.get(id)?.dispose();
    this.runtimes.delete(id);
    this.entries = this.entries.filter((e) => e.id !== id);
    this.save();
  }

  rename(id: string, name: string): void {
    const e = this.entries.find((x) => x.id === id);
    if (!e || !name.trim()) return;
    e.name = name.trim().slice(0, 80);
    this.save();
  }

  setTrusted(id: string, trusted: boolean): void {
    const e = this.entries.find((x) => x.id === id);
    if (!e) return;
    e.trusted = trusted;
    this.save();
    const rt = this.runtimes.get(id);
    if (rt) rt.scope.trusted = trusted;
  }

  /** The live objects of one project, made on first use and kept while the app runs. */
  runtime(id: string): ProjectRuntime | undefined {
    const existing = this.runtimes.get(id);
    if (existing) return existing;
    const e = this.entries.find((x) => x.id === id);
    if (!e) return undefined;
    const dir = path.join(this.userData, 'projects', id);
    const scope: ProjectScope = {
      id,
      root: e.root,
      name: e.name,
      trusted: e.trusted,
      state: new FileMemento(path.join(dir, 'state.json')),
    };
    const store = new SessionStore(dir);
    // Created inside the project so its file watchers watch this folder.
    const context = runInProject(scope, () =>
      new ContextProvider({ post: (m) => this.broadcast(id, m), compatClaude: () => getSettings().compatClaude }),
    );
    const rt: ProjectRuntime = {
      scope,
      store,
      context,
      dispose: () => context.dispose(),
    };
    this.runtimes.set(id, rt);
    void runInProject(scope, () => context.reload()).catch(() => undefined);
    return rt;
  }

  /** Every project's store, for the sidebar. */
  storeOf(id: string): SessionStore {
    return this.runtime(id)?.store ?? new SessionStore(path.join(this.userData, 'projects', id));
  }

  disposeAll(): void {
    for (const rt of this.runtimes.values()) rt.dispose();
    this.runtimes.clear();
  }

  private save(): void {
    fs.mkdirSync(this.userData, { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ projects: this.entries }, null, 2), 'utf8');
    fs.renameSync(tmp, this.file);
  }
}

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}
