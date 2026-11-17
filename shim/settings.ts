/**
 * Settings: the extension's `gisoo.*` keys with their defaults (generated from the extension's
 * manifest), the user's own values in `settings.json` under the app's data folder, and a project's
 * values in `<project>/.gisoo/settings.json`. Like VS Code, the core reads anything that moves the API
 * key, the approval policy or what runs on the machine from the user's values only (`userSetting`).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import defaultsJson from '../src/settings.generated.json';

export interface SettingSchema {
  type?: string | string[];
  default?: unknown;
  enum?: string[];
  enumDescriptions?: { en?: string[]; fa?: string[] };
  description?: { en?: string; fa?: string };
  scope?: string;
  minimum?: number;
  maximum?: number;
}

export const SCHEMA = defaultsJson as unknown as Record<string, SettingSchema>;

/** Desktop defaults that differ from the extension's. */
const DESKTOP_DEFAULTS: Record<string, unknown> = {
  // Gisoo speaks Persian first; English stays one click away in settings.
  'gisoo.language': 'fa',
};

export function defaultValue(key: string): unknown {
  return key in DESKTOP_DEFAULTS ? DESKTOP_DEFAULTS[key] : SCHEMA[key]?.default;
}

type Values = Record<string, unknown>;

function readValues(file: string): Values {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Values) : {};
  } catch {
    return {};
  }
}

function writeValues(file: string, values: Values): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(values, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
}

export class SettingsStore {
  private user: Values;
  private readonly projects = new Map<string, { mtimeMs: number; values: Values }>();
  private readonly listeners = new Set<(keys: string[]) => void>();

  constructor(private readonly userFile: string) {
    this.user = readValues(userFile);
  }

  /** The user's own values. */
  userValue(key: string): unknown {
    return this.user[key];
  }

  /** A project's values (from `.gisoo/settings.json`), re-read when the file changes. */
  projectValue(root: string | undefined, key: string): unknown {
    if (!root) return undefined;
    const file = projectSettingsFile(root);
    let mtimeMs = 0;
    try {
      mtimeMs = fs.statSync(file).mtimeMs;
    } catch {
      this.projects.delete(root);
      return undefined;
    }
    let cached = this.projects.get(root);
    if (!cached || cached.mtimeMs !== mtimeMs) {
      cached = { mtimeMs, values: readValues(file) };
      this.projects.set(root, cached);
    }
    return cached.values[key];
  }

  setUser(key: string, value: unknown): void {
    if (value === undefined) delete this.user[key];
    else this.user[key] = value;
    writeValues(this.userFile, this.user);
    this.emit([key]);
  }

  setProject(root: string, key: string, value: unknown): void {
    const file = projectSettingsFile(root);
    const values = readValues(file);
    if (value === undefined) delete values[key];
    else values[key] = value;
    writeValues(file, values);
    this.projects.delete(root);
    this.emit([key]);
  }

  /** Every user value, for the settings page. */
  allUser(): Values {
    return { ...this.user };
  }

  onDidChange(listener: (keys: string[]) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(keys: string[]): void {
    for (const l of [...this.listeners]) l(keys);
  }
}

export function projectSettingsFile(root: string): string {
  return path.join(root, '.gisoo', 'settings.json');
}
