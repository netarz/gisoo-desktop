/**
 * Which project the current code runs for.
 *
 * The extension core asks `vscode.workspace.workspaceFolders` and `isTrusted` for "the workspace".
 * In the desktop app several projects are open at once, so the answer depends on who is asking:
 * every chat, every context provider and every timer they start runs inside `runInProject(project, …)`,
 * and AsyncLocalStorage carries the project through awaits, timers and child-process callbacks.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

export interface Memento {
  keys(): readonly string[];
  get<T>(key: string, defaultValue?: T): T | undefined;
  update(key: string, value: unknown): Promise<void>;
}

export interface ProjectScope {
  /** Stable id of the project (a hash of its path). */
  readonly id: string;
  /** Absolute path of the project folder. */
  readonly root: string;
  readonly name: string;
  /** The owner said they trust this folder: instruction files, agents and hooks may load from it. */
  trusted: boolean;
  /** The project's own state (`context.workspaceState`). */
  readonly state: Memento;
}

const storage = new AsyncLocalStorage<ProjectScope>();

export function runInProject<T>(project: ProjectScope, fn: () => T): T {
  return storage.run(project, fn);
}

export function currentProject(): ProjectScope | undefined {
  return storage.getStore();
}
