/**
 * The contract between the main process and the shell window. Type-only: both sides import it.
 * Chat traffic (the extension's own webview protocol) passes through untouched as `unknown`.
 */

export type Lang = 'fa' | 'en';

export interface ProjectInfo {
  id: string;
  name: string;
  root: string;
  trusted: boolean;
  /** The folder no longer exists. */
  missing: boolean;
}

/** One row in the sidebar under a project. */
export interface ChatItem {
  /** `gisoo` rows open directly; the others are copied into a Gisoo chat the first time they are opened. */
  kind: 'gisoo' | 'external' | 'vscode';
  /** Gisoo session id, external tool session id, or VS Code Gisoo session id. */
  id: string;
  title: string;
  updatedAt: number;
  /** For external rows: `claude-code`, `codex`, … */
  source?: string;
  /** Short name of the source tool. */
  sourceLabel?: string;
  /** The Gisoo chat this row was already copied into. */
  importedId?: string;
}

export interface ProjectChats {
  projectId: string;
  chats: ChatItem[];
}

export interface AccountView {
  signedIn: boolean;
  /** Balance in Gisoo coins, formatted for the UI language. */
  balance?: string;
  /** The Gisoo project and key the app signs in with. */
  projectName?: string;
  keyName?: string;
  error?: string;
  /** A browser sign-in is waiting for the owner. */
  signInWaiting?: boolean;
  signInUrl?: string;
}

export interface AppState {
  lang: Lang;
  platform: string;
  version: string;
  projects: ProjectInfo[];
  account: AccountView;
  /** Gisoo chats from VS Code that could not be matched to an added project. */
  unassigned: ChatItem[];
}

export interface OpenChatRequest {
  projectId: string;
  /** Gisoo session id; null starts a new chat. */
  sessionId?: string | null;
  external?: { source: string; id: string };
  vscode?: { id: string };
}

export interface OpenedChat {
  chatId: string;
  projectId: string;
  sessionId?: string;
}

export interface ChatMeta {
  chatId: string;
  projectId: string;
  sessionId?: string;
  title?: string;
  running: boolean;
}

export interface SettingField {
  key: string;
  type: string;
  value: unknown;
  defaultValue: unknown;
  enum?: string[];
  enumLabels?: string[];
  label: string;
  description?: string;
  /** Lives in the project's `.gisoo/settings.json` when set there. */
  scope?: string;
}

export type McpSource = 'project:gisoo' | 'project:claude' | 'project:codex' | 'user:gisoo' | 'user:claude-local' | 'user:claude' | 'user:codex' | 'astack';
export type McpStatus = 'off' | 'needsApproval' | 'denied' | 'connecting' | 'connected' | 'failed' | 'idle';

/** One MCP server as the settings page shows it. Never carries env values or headers. */
export interface McpServerView {
  name: string;
  source: McpSource;
  transport: 'stdio' | 'http' | 'sse';
  target: string;
  status: McpStatus;
  tools: number;
  error?: string;
  projectLevel: boolean;
}

/** Requests the main process makes of the shell (dialogs drawn in the window). */
export type HostRequest =
  | { kind: 'message'; level: 'info' | 'warning' | 'error'; text: string; detail?: string; modal?: boolean; actions: string[] }
  | { kind: 'quickPick'; title?: string; placeHolder?: string; canPickMany?: boolean; items: Array<{ label: string; description?: string; detail?: string; separator?: boolean; picked?: boolean }> }
  | { kind: 'inputBox'; title?: string; prompt?: string; placeHolder?: string; value?: string; password?: boolean; error?: string };

/** One-way news from the main process. */
export type HostNotice =
  | { kind: 'document'; title: string; path?: string; content: string; language?: string; line?: number }
  | { kind: 'diff'; title: string; path: string; before: string; after: string }
  | { kind: 'progress'; id: string; title: string; done: boolean }
  | { kind: 'task'; id: string; title: string; chunk: string; exitCode?: number }
  | { kind: 'settings'; query?: string }
  | { kind: 'toast'; level: 'info' | 'warning' | 'error'; text: string };

/** What preload exposes as `window.gisoo`. */
export interface GisooBridge {
  invoke<T = unknown>(channel: string, ...args: unknown[]): Promise<T>;
  on(channel: string, listener: (...args: any[]) => void): () => void;
  platform: string;
}
