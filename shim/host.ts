/**
 * What the `vscode` shim needs from the desktop shell: dialogs, the document viewer, the clipboard,
 * links. The Electron main process installs the real one with `setHost`; until then (and in unit
 * tests) a quiet headless host answers.
 */

export type MessageLevel = 'info' | 'warning' | 'error';

export interface PickItem {
  label: string;
  description?: string;
  detail?: string;
  separator?: boolean;
  picked?: boolean;
}

export interface ShownDocument {
  title: string;
  /** Absolute path when the document is a file on disk. */
  path?: string;
  content: string;
  language?: string;
  /** 1-based line to reveal. */
  line?: number;
}

export interface DesktopHost {
  /** A notification (or a modal question when `modal`); resolves with the index of the chosen action. */
  message(level: MessageLevel, text: string, options: { modal?: boolean; detail?: string }, actions: string[]): Promise<number | undefined>;
  quickPick(items: PickItem[], options: { title?: string; placeHolder?: string; canPickMany?: boolean }): Promise<number[] | undefined>;
  inputBox(options: { title?: string; prompt?: string; placeHolder?: string; value?: string; password?: boolean; error?: string }): Promise<string | undefined>;
  openDialog(options: { title?: string; folders?: boolean; many?: boolean; filters?: Record<string, string[]>; defaultPath?: string }): Promise<string[] | undefined>;
  showDocument(doc: ShownDocument): Promise<void>;
  showDiff(diff: { title: string; path: string; before: string; after: string }): Promise<void>;
  openExternal(url: string): Promise<boolean>;
  clipboardRead(): Promise<string>;
  clipboardWrite(text: string): Promise<void>;
  /** A long job started (`done` false) or ended. */
  progress(id: string, title: string, done: boolean): void;
  openSettings(query?: string): Promise<void>;
  /** Output of a task the core started (Graphify install); shown in the task drawer. */
  taskOutput(id: string, title: string, chunk: string, exitCode?: number): void;
}

const headless: DesktopHost = {
  message: async (level, text) => {
    (level === 'error' ? console.error : console.log)(`[${level}] ${text}`);
    return undefined;
  },
  quickPick: async () => undefined,
  inputBox: async () => undefined,
  openDialog: async () => undefined,
  showDocument: async () => undefined,
  showDiff: async () => undefined,
  openExternal: async () => false,
  clipboardRead: async () => '',
  clipboardWrite: async () => undefined,
  progress: () => undefined,
  openSettings: async () => undefined,
  taskOutput: () => undefined,
};

let current: DesktopHost = headless;

export function setHost(host: DesktopHost): void {
  current = host;
}

export function host(): DesktopHost {
  return current;
}
