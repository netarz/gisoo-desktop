/**
 * The `vscode.ExtensionContext` the core expects: secrets kept with the operating system's own
 * encryption (Electron safeStorage: DPAPI on Windows, the Keychain on macOS), the app's state as a
 * JSON file, the current project's state as `workspaceState`, and the app's storage folder.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { safeStorage } from 'electron';
import { EventEmitter, Uri } from '../shim/vscode';
import { currentProject, type Memento } from '../shim/scope';

/** A small JSON-file memento; writes are atomic and batched per tick. */
export class FileMemento implements Memento {
  private values: Record<string, unknown>;
  private timer: NodeJS.Timeout | undefined;

  constructor(private readonly file: string) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
      this.values = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
    } catch {
      this.values = {};
    }
  }

  keys(): readonly string[] {
    return Object.keys(this.values);
  }

  get<T>(key: string, defaultValue?: T): T | undefined {
    return key in this.values ? (this.values[key] as T) : defaultValue;
  }

  async update(key: string, value: unknown): Promise<void> {
    if (value === undefined) delete this.values[key];
    else this.values[key] = value;
    this.flushSoon();
  }

  setKeysForSync(): void {
    /* nothing syncs */
  }

  private flushSoon(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.flush();
    }, 50);
  }

  flush(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.values), 'utf8');
    fs.renameSync(tmp, this.file);
  }
}

/** Secrets: each value encrypted with safeStorage, stored in one file under the app's data folder. */
class SecretStore {
  private readonly changed = new EventEmitter<{ key: string }>();
  readonly onDidChange = this.changed.event;
  private values: Record<string, string>;

  constructor(private readonly file: string) {
    try {
      this.values = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, string>;
    } catch {
      this.values = {};
    }
  }

  async get(key: string): Promise<string | undefined> {
    const stored = this.values[key];
    if (stored === undefined) return undefined;
    try {
      const buf = Buffer.from(stored.slice(2), 'base64');
      return stored.startsWith('e:') ? safeStorage.decryptString(buf) : buf.toString('utf8');
    } catch {
      return undefined;
    }
  }

  async store(key: string, value: string): Promise<void> {
    // Without OS encryption (some Linux sessions) the value is kept as plain base64, marked `p:`, in a
    // file only the owner can read; the 'basic_text' backend is a fixed key, so it counts as none.
    this.values[key] = osEncryption()
      ? `e:${safeStorage.encryptString(value).toString('base64')}`
      : `p:${Buffer.from(value, 'utf8').toString('base64')}`;
    this.write();
    this.changed.fire({ key });
  }

  async delete(key: string): Promise<void> {
    if (!(key in this.values)) return;
    delete this.values[key];
    this.write();
    this.changed.fire({ key });
  }

  async keys(): Promise<string[]> {
    return Object.keys(this.values);
  }

  private write(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.values), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }
}

export interface DesktopContext {
  subscriptions: Array<{ dispose(): unknown }>;
  secrets: SecretStore;
  globalState: FileMemento;
  workspaceState: Memento;
  globalStorageUri: Uri;
  globalStoragePath: string;
  storageUri: Uri | undefined;
  logUri: Uri;
  extensionUri: Uri;
  extensionPath: string;
  extensionMode: number;
  extension: { id: string; packageJSON: Record<string, unknown>; extensionUri: Uri; extensionPath: string };
  environmentVariableCollection: Record<string, unknown>;
  asAbsolutePath(rel: string): string;
}

/** Used when code outside any project asks for workspace state. */
const noProjectState = new Map<string, unknown>();
const fallbackMemento: Memento = {
  keys: () => [...noProjectState.keys()],
  get: <T>(key: string, d?: T) => (noProjectState.has(key) ? (noProjectState.get(key) as T) : d),
  update: async (key: string, value: unknown) => {
    if (value === undefined) noProjectState.delete(key);
    else noProjectState.set(key, value);
  },
};

export function createContext(opts: { userData: string; appRoot: string; version: string }): DesktopContext {
  const storage = path.join(opts.userData, 'core');
  fs.mkdirSync(storage, { recursive: true });
  const appUri = Uri.file(opts.appRoot);
  const workspaceState: Memento = {
    keys: () => (currentProject()?.state ?? fallbackMemento).keys(),
    get: <T>(key: string, d?: T) => (currentProject()?.state ?? fallbackMemento).get<T>(key, d),
    update: (key: string, value: unknown) => (currentProject()?.state ?? fallbackMemento).update(key, value),
  };
  return {
    subscriptions: [],
    secrets: new SecretStore(path.join(opts.userData, 'secrets.json')),
    globalState: new FileMemento(path.join(opts.userData, 'state.json')),
    workspaceState,
    globalStorageUri: Uri.file(storage),
    globalStoragePath: storage,
    storageUri: undefined,
    logUri: Uri.file(path.join(opts.userData, 'logs')),
    extensionUri: appUri,
    extensionPath: opts.appRoot,
    extensionMode: 1,
    // The server knows the extension by this id; sign-in links name it.
    extension: {
      id: 'gisoo.gisoo-vscode',
      packageJSON: { name: 'gisoo-vscode', publisher: 'gisoo', version: opts.version, displayName: 'Gisoo' },
      extensionUri: appUri,
      extensionPath: opts.appRoot,
    },
    environmentVariableCollection: {},
    asAbsolutePath: (rel: string) => path.join(opts.appRoot, rel),
  };
}

function osEncryption(): boolean {
  if (!safeStorage.isEncryptionAvailable()) return false;
  if (process.platform !== 'linux') return true;
  try {
    return safeStorage.getSelectedStorageBackend() !== 'basic_text';
  } catch {
    return false;
  }
}
