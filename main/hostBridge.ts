/**
 * The DesktopHost the `vscode` shim calls: questions and pickers are drawn by the shell window and
 * answered over IPC; native file dialogs, the clipboard and links use Electron directly.
 */
import { clipboard, dialog, shell, type BrowserWindow } from 'electron';
import type { DesktopHost, PickItem } from '../shim/host';
import type { HostNotice, HostRequest } from './api';

/** Only these leave the app through the system browser or mail client. */
const SAFE_LINK = /^(https?:|mailto:)/i;

export class HostBridge implements DesktopHost {
  private seq = 0;
  private readonly pending = new Map<number, (answer: unknown) => void>();

  constructor(private readonly window: () => BrowserWindow | undefined) {}

  /** The shell answered request `id`. */
  reply(id: number, answer: unknown): void {
    const resolve = this.pending.get(id);
    if (!resolve) return;
    this.pending.delete(id);
    resolve(answer);
  }

  /** Every open question is answered "cancelled" (the window is closing). */
  cancelAll(): void {
    for (const resolve of this.pending.values()) resolve(undefined);
    this.pending.clear();
  }

  private ask<T>(request: HostRequest): Promise<T | undefined> {
    const win = this.window();
    if (!win || win.isDestroyed()) return Promise.resolve(undefined);
    const id = ++this.seq;
    return new Promise<T | undefined>((resolve) => {
      this.pending.set(id, (a) => resolve(a as T | undefined));
      win.webContents.send('host:request', id, request);
      if (win.isMinimized()) win.restore();
    });
  }

  notice(n: HostNotice): void {
    const win = this.window();
    if (win && !win.isDestroyed()) win.webContents.send('host:notice', n);
  }

  async message(level: 'info' | 'warning' | 'error', text: string, options: { modal?: boolean; detail?: string }, actions: string[]): Promise<number | undefined> {
    const win = this.window();
    if (options.modal && win && !win.isDestroyed()) {
      // VS Code adds its own "Cancel" to a modal; the last button here plays that part.
      const fa = /[؀-ۿ]/.test(text);
      const buttons = [...actions, fa ? 'انصراف' : 'Cancel'];
      const r = await dialog.showMessageBox(win, {
        type: level === 'error' ? 'error' : level === 'warning' ? 'warning' : 'info',
        message: text,
        detail: options.detail,
        buttons,
        cancelId: buttons.length - 1,
        defaultId: 0,
        noLink: true,
      });
      return r.response < actions.length ? r.response : undefined;
    }
    if (!actions.length) {
      this.notice({ kind: 'toast', level, text });
      return undefined;
    }
    return this.ask<number>({ kind: 'message', level, text, detail: options.detail, modal: false, actions });
  }

  async quickPick(items: PickItem[], options: { title?: string; placeHolder?: string; canPickMany?: boolean }): Promise<number[] | undefined> {
    return this.ask<number[]>({ kind: 'quickPick', ...options, items });
  }

  async inputBox(options: { title?: string; prompt?: string; placeHolder?: string; value?: string; password?: boolean; error?: string }): Promise<string | undefined> {
    return this.ask<string>({ kind: 'inputBox', ...options });
  }

  async openDialog(options: { title?: string; folders?: boolean; many?: boolean; filters?: Record<string, string[]>; defaultPath?: string }): Promise<string[] | undefined> {
    const win = this.window();
    const props: Array<'openFile' | 'openDirectory' | 'multiSelections'> = [options.folders ? 'openDirectory' : 'openFile'];
    if (options.many) props.push('multiSelections');
    const opts = {
      title: options.title,
      defaultPath: options.defaultPath,
      properties: props,
      filters: options.filters ? Object.entries(options.filters).map(([name, extensions]) => ({ name, extensions })) : undefined,
    };
    const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
    return r.canceled || !r.filePaths.length ? undefined : r.filePaths;
  }

  async showDocument(doc: { title: string; path?: string; content: string; language?: string; line?: number }): Promise<void> {
    this.notice({ kind: 'document', ...doc });
  }

  async showDiff(diff: { title: string; path: string; before: string; after: string }): Promise<void> {
    this.notice({ kind: 'diff', ...diff });
  }

  async openExternal(url: string): Promise<boolean> {
    if (!SAFE_LINK.test(url)) return false;
    await shell.openExternal(url);
    return true;
  }

  async clipboardRead(): Promise<string> {
    return clipboard.readText();
  }

  async clipboardWrite(text: string): Promise<void> {
    clipboard.writeText(text);
  }

  progress(id: string, title: string, done: boolean): void {
    this.notice({ kind: 'progress', id, title, done });
  }

  async openSettings(query?: string): Promise<void> {
    this.notice({ kind: 'settings', query });
  }

  taskOutput(id: string, title: string, chunk: string, exitCode?: number): void {
    this.notice({ kind: 'task', id, title, chunk, exitCode });
  }
}
