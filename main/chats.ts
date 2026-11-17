/**
 * Open chats and the sidebar's chat lists.
 *
 * Every open chat is the extension's own pair — a SessionController (the agent) and a ChatHost (the
 * webview's host side) — bound to a stand-in webview whose messages travel over IPC to an iframe in
 * the shell. Everything a chat does runs inside its project's scope, so files, instructions,
 * commands, settings and trust are the project's own.
 */
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type * as vscode from 'vscode';
import { SessionController } from '../src/agent/runner';
import type { SessionData } from '../src/agent/session';
import type { GisooClient } from '../src/api/client';
import type { AuthService } from '../src/auth/service';
import { getSettings, userSetting } from '../src/config';
import * as tools from '../src/tools';
import { ChatHost } from '../src/ui/chatViewProvider';
import { hostStr } from '../src/ui/strings';
import { ExternalChats, SOURCE_LABELS, transcriptToSession, originKey, type ExternalSource } from '../src/sessions/external';
import { EXTENSION_HOST_PRODUCTS, userDataDirs } from '../src/sessions/external/vscodeData';
import type { HostToWebview } from '../src/shared/protocol';
import { EventEmitter, Uri } from '../shim/vscode';
import { runInProject } from '../shim/scope';
import type { ChatItem, ChatMeta, OpenChatRequest, OpenedChat } from './api';
import type { DesktopContext } from './context';
import type { Projects } from './projects';

export interface ChatDeps {
  projects: Projects;
  context: DesktopContext;
  client: GisooClient;
  auth: AuthService;
  /** Sends an event to the shell window. */
  send: (channel: string, ...args: unknown[]) => void;
}

interface OpenChat {
  chatId: string;
  projectId: string;
  sessionId?: string;
  title?: string;
  running: boolean;
  received: EventEmitter<unknown>;
  controller: SessionController;
  host: ChatHost;
  dispose(): void;
}

/** A Gisoo chat saved by the VS Code extension (it lives in VS Code's own data folder). */
interface VscodeChat {
  id: string;
  file: string;
  title: string;
  updatedAt: number;
  turns: number;
  /** Lower-cased text of the file, for matching a project folder. */
  haystack: string;
  mtime: number;
  size: number;
}

const VSCODE_ORIGIN = 'gisoo-vscode';

export class ChatManager {
  private readonly chats = new Map<string, OpenChat>();
  private readonly external = new ExternalChats({ home: os.homedir(), limit: 40 });
  private readonly vscodeCache = new Map<string, VscodeChat>();
  private sidebarTimer: NodeJS.Timeout | undefined;
  private readonly sidebarDirty = new Set<string>();
  /** The chat the owner used last; commands without a chat of their own act on it. */
  lastActive: string | undefined;

  constructor(private readonly deps: ChatDeps) {}

  // ---------------------------------------------------------------------------
  // Opening and closing
  // ---------------------------------------------------------------------------

  async open(req: OpenChatRequest): Promise<OpenedChat> {
    const rt = this.deps.projects.runtime(req.projectId);
    if (!rt) throw new Error('project not found');
    // An already open chat of the same conversation is reused.
    if (req.sessionId) {
      for (const c of this.chats.values()) {
        if (c.projectId === req.projectId && c.sessionId === req.sessionId) return { chatId: c.chatId, projectId: c.projectId, sessionId: c.sessionId };
      }
    }
    let initial: string | null = req.sessionId ?? null;
    if (req.external) initial = await this.importExternal(req.projectId, req.external.source as ExternalSource, req.external.id);
    if (req.vscode) initial = await this.importVscode(req.projectId, req.vscode.id);

    const chatId = randomUUID();
    const chat = runInProject(rt.scope, () => this.create(chatId, req.projectId, initial));
    this.chats.set(chatId, chat);
    this.lastActive = chatId;
    return { chatId, projectId: req.projectId, sessionId: chat.sessionId };
  }

  private create(chatId: string, projectId: string, initialSession: string | null): OpenChat {
    const rt = this.deps.projects.runtime(projectId)!;
    const { context, client, auth } = this.deps;
    const ctx = context as unknown as vscode.ExtensionContext;
    const received = new EventEmitter<unknown>();
    const ref: { host?: ChatHost; chat?: OpenChat } = {};
    const controller = new SessionController({
      client,
      tools,
      store: rt.store,
      post: (m) => {
        ref.host?.post(m);
      },
      getSettings,
      context: ctx,
      auth,
      workspaceContext: rt.context,
      initialSession,
    });
    const host = new ChatHost(ctx, auth, controller, async () => this.deps.send('chat:openRequest', { chatId }));
    ref.host = host;

    // The stand-in webview: the host writes html and options we never use; messages go over IPC.
    const webview = {
      options: {},
      html: '',
      cspSource: 'app:',
      asWebviewUri: (u: Uri) => u,
      postMessage: async (message: HostToWebview) => {
        this.outgoing(chatId, message);
        return true;
      },
      onDidReceiveMessage: received.event,
    };
    const binding = host.bind(webview as unknown as vscode.Webview);
    const interacted = host.onDidInteract(() => {
      this.lastActive = chatId;
    });

    const chat: OpenChat = {
      chatId,
      projectId,
      sessionId: initialSession ?? undefined,
      running: false,
      received,
      controller,
      host,
      dispose: () => {
        interacted.dispose();
        binding.dispose();
        host.dispose();
        controller.dispose();
        received.dispose();
      },
    };
    ref.chat = chat;
    return chat;
  }

  /** A message from the iframe. */
  post(chatId: string, message: unknown): void {
    const chat = this.chats.get(chatId);
    if (!chat) return;
    const rt = this.deps.projects.runtime(chat.projectId);
    if (!rt) return;
    runInProject(rt.scope, () => chat.received.fire(message));
  }

  close(chatId: string): void {
    const chat = this.chats.get(chatId);
    if (!chat) return;
    this.chats.delete(chatId);
    if (this.lastActive === chatId) this.lastActive = undefined;
    chat.dispose();
    this.touchSidebar(chat.projectId);
  }

  /** Closes every chat of a project (the project was removed). */
  closeProject(projectId: string): void {
    for (const c of [...this.chats.values()]) if (c.projectId === projectId) this.close(c.chatId);
  }

  /** Workspace news (instruction files, commands, skills) for every open chat of one project. */
  broadcast(projectId: string, message: HostToWebview): void {
    for (const c of this.chats.values()) if (c.projectId === projectId) c.host.post(message);
  }

  /** News for every open chat (sign-in, settings). */
  broadcastAll(message: HostToWebview): void {
    for (const c of this.chats.values()) c.host.post(message);
  }

  /** Runs `fn` in the scope of the chat the owner used last, or of the given project. */
  active(): { chatId: string; projectId: string } | undefined {
    const c = this.lastActive ? this.chats.get(this.lastActive) : undefined;
    return c ? { chatId: c.chatId, projectId: c.projectId } : undefined;
  }

  isBusy(): boolean {
    for (const c of this.chats.values()) if (c.controller.busy) return true;
    return false;
  }

  disposeAll(): void {
    for (const id of [...this.chats.keys()]) this.close(id);
  }

  private outgoing(chatId: string, message: HostToWebview): void {
    const chat = this.chats.get(chatId);
    if (message.type === 'init') {
      const lang = message.state.language === 'fa' ? 'fa' : 'en';
      const project = chat ? this.deps.projects.get(chat.projectId) : undefined;
      if (project) {
        message.state.strings['empty.title'] = lang === 'fa' ? `روی چه کاری در «${project.name}» کار کنیم؟` : `What should we work on in ${project.name}?`;
      }
    }
    this.deps.send('chat:msg', chatId, message);
    if (!chat) return;
    let changed = false;
    if (message.type === 'init' || message.type === 'session') {
      const s = message.type === 'init' ? message.state.session : message.session;
      if (chat.sessionId !== s.id || chat.title !== s.title || chat.running !== s.running) {
        chat.sessionId = s.id;
        chat.title = s.title;
        chat.running = s.running;
        changed = true;
      }
    } else if (message.type === 'running' && chat.running !== message.running) {
      chat.running = message.running;
      changed = true;
    }
    if (changed) {
      const meta: ChatMeta = { chatId, projectId: chat.projectId, sessionId: chat.sessionId, title: chat.title, running: chat.running };
      this.deps.send('chat:meta', meta);
    }
    if (changed || message.type === 'turn.end' || message.type === 'turn.add') this.touchSidebar(chat.projectId);
  }

  /** The sidebar re-reads one project's chats, at most every half second. */
  touchSidebar(projectId: string): void {
    this.sidebarDirty.add(projectId);
    if (this.sidebarTimer) return;
    this.sidebarTimer = setTimeout(() => {
      this.sidebarTimer = undefined;
      const ids = [...this.sidebarDirty];
      this.sidebarDirty.clear();
      for (const id of ids) this.deps.send('sidebar:changed', id);
    }, 500);
  }

  // ---------------------------------------------------------------------------
  // Lists
  // ---------------------------------------------------------------------------

  /** One project's chats: Gisoo's own, then chats from other tools and VS Code not yet copied in. */
  async list(projectId: string): Promise<ChatItem[]> {
    const project = this.deps.projects.get(projectId);
    if (!project) return [];
    const store = this.deps.projects.storeOf(projectId);
    const own = await store.list(200);
    const imported = new Map<string, string>();
    for (const s of own) if (s.origin) imported.set(s.origin, s.id);

    const items: ChatItem[] = own.map((s) => ({ kind: 'gisoo', id: s.id, title: s.title || untitled(), updatedAt: s.updatedAt, source: s.origin?.split(':')[0], sourceLabel: labelOfOrigin(s.origin) }));

    if (!project.missing && userSetting<boolean>('importExternalChats') !== false) {
      const found = await this.external.list([project.root]).catch(() => []);
      for (const e of found) {
        if (imported.has(originKey(e.source, e.id))) continue;
        items.push({ kind: 'external', id: e.id, title: e.title || untitled(), updatedAt: e.updatedAt, source: e.source, sourceLabel: SOURCE_LABELS[e.source] });
      }
    }
    for (const v of this.vscodeChats()) {
      if (imported.has(`${VSCODE_ORIGIN}:${v.id}`)) continue;
      if (this.matchProject(v) !== projectId) continue;
      items.push({ kind: 'vscode', id: v.id, title: v.title || untitled(), updatedAt: v.updatedAt, source: VSCODE_ORIGIN, sourceLabel: 'VS Code' });
    }
    return items.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /** VS Code Gisoo chats that belong to no added project. */
  unassigned(): ChatItem[] {
    const out: ChatItem[] = [];
    for (const v of this.vscodeChats()) {
      if (this.matchProject(v)) continue;
      out.push({ kind: 'vscode', id: v.id, title: v.title || untitled(), updatedAt: v.updatedAt, source: VSCODE_ORIGIN, sourceLabel: 'VS Code' });
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 50);
  }

  async rename(projectId: string, sessionId: string, title: string): Promise<void> {
    const store = this.deps.projects.storeOf(projectId);
    const data = await store.load(sessionId);
    if (!data || !title.trim()) return;
    data.title = title.trim().slice(0, 120);
    await store.save(data);
    // An open, idle chat reloads the session from disk so it shows (and later saves) the new title.
    for (const c of this.chats.values()) {
      if (c.projectId !== projectId || c.sessionId !== sessionId || c.controller.busy) continue;
      const rt = this.deps.projects.runtime(projectId);
      if (rt) runInProject(rt.scope, () => void c.controller.handle({ type: 'session.open', id: sessionId }));
    }
    this.touchSidebar(projectId);
  }

  async delete(projectId: string, sessionId: string): Promise<void> {
    for (const c of [...this.chats.values()]) if (c.projectId === projectId && c.sessionId === sessionId) this.close(c.chatId);
    await this.deps.projects.storeOf(projectId).delete(sessionId);
    this.touchSidebar(projectId);
  }

  // ---------------------------------------------------------------------------
  // Importing
  // ---------------------------------------------------------------------------

  private async importExternal(projectId: string, source: ExternalSource, id: string): Promise<string> {
    const store = this.deps.projects.storeOf(projectId);
    const existing = await store.findByOrigin(originKey(source, id));
    if (existing) return existing;
    const project = this.deps.projects.get(projectId)!;
    // `read` only accepts ids from a listing of this folder.
    await this.external.list([project.root]);
    const transcript = await this.external.read(source, id);
    if (!transcript) throw new Error('chat not found');
    const s = getSettings();
    const label = SOURCE_LABELS[source];
    const notice = transcript.omitted
      ? hostStr(s.language, 'host.external.importedPartly', label, transcript.omitted)
      : hostStr(s.language, 'host.external.imported', label);
    const session = transcriptToSession(transcript, s.model, s.permissionMode, notice);
    await store.save(session);
    this.touchSidebar(projectId);
    return session.id;
  }

  private async importVscode(projectId: string, id: string): Promise<string> {
    const store = this.deps.projects.storeOf(projectId);
    const origin = `${VSCODE_ORIGIN}:${id}`;
    const existing = await store.findByOrigin(origin);
    if (existing) return existing;
    const v = this.vscodeChats().find((c) => c.id === id);
    if (!v) throw new Error('chat not found');
    const data = JSON.parse(fs.readFileSync(v.file, 'utf8')) as SessionData;
    data.origin = origin;
    await store.save(data);
    this.touchSidebar(projectId);
    return data.id;
  }

  /** Gisoo chats kept by the VS Code extension, read once per file change. */
  private vscodeChats(): VscodeChat[] {
    const dirs = userDataDirs(os.homedir(), process.env, process.platform, EXTENSION_HOST_PRODUCTS).map((d) =>
      path.join(d, 'globalStorage', 'gisoo.gisoo-vscode', 'sessions'),
    );
    const out: VscodeChat[] = [];
    for (const dir of dirs) {
      let names: string[];
      try {
        names = fs.readdirSync(dir).filter((n) => n.endsWith('.json'));
      } catch {
        continue;
      }
      for (const name of names) {
        const file = path.join(dir, name);
        try {
          const st = fs.statSync(file);
          const hit = this.vscodeCache.get(file);
          if (hit && hit.mtime === st.mtimeMs && hit.size === st.size) {
            out.push(hit);
            continue;
          }
          if (st.size > 30 * 1024 * 1024) continue;
          const text = fs.readFileSync(file, 'utf8');
          const data = JSON.parse(text) as Partial<SessionData>;
          if (typeof data.id !== 'string' || !/^[A-Za-z0-9_-]+$/.test(data.id) || !Array.isArray(data.turns) || !data.turns.length) continue;
          const item: VscodeChat = {
            id: data.id,
            file,
            title: typeof data.title === 'string' ? data.title : '',
            updatedAt: typeof data.updatedAt === 'number' ? data.updatedAt : st.mtimeMs,
            turns: data.turns.length,
            haystack: text.toLowerCase(),
            mtime: st.mtimeMs,
            size: st.size,
          };
          this.vscodeCache.set(file, item);
          out.push(item);
        } catch {
          /* unreadable or half written: skip */
        }
      }
    }
    return out;
  }

  /** The project whose folder the chat mentions most (the chat records no folder of its own). */
  private matchProject(v: VscodeChat): string | undefined {
    let best: { id: string; hits: number; len: number } | undefined;
    for (const p of this.deps.projects.list()) {
      const forms = pathForms(p.root);
      let hits = 0;
      for (const f of forms) hits += count(v.haystack, f);
      if (!hits) continue;
      // A deeper folder that matches wins over its parent.
      if (!best || p.root.length > best.len || (p.root.length === best.len && hits > best.hits)) best = { id: p.id, hits, len: p.root.length };
    }
    return best?.id;
  }
}

function untitled(): string {
  return getSettings().language === 'fa' ? 'گفت‌وگوی بی‌نام' : 'Untitled chat';
}

function labelOfOrigin(origin: string | undefined): string | undefined {
  if (!origin) return undefined;
  const source = origin.split(':')[0];
  if (source === VSCODE_ORIGIN) return 'VS Code';
  return (SOURCE_LABELS as Record<string, string>)[source];
}

/** The ways a folder path can appear inside a JSON file, lower-cased. */
function pathForms(root: string): string[] {
  const norm = path.resolve(root).toLowerCase();
  const slash = norm.replace(/\\/g, '/');
  const forms = new Set([slash, JSON.stringify(norm).slice(1, -1), norm]);
  // `file:///c%3A/Projects/x` in VS Code URIs.
  if (/^[a-z]:/.test(slash)) forms.add(`file:///${slash[0]}%3a${slash.slice(2)}`);
  return [...forms].filter((f) => f.length > 3);
}

function count(haystack: string, needle: string): number {
  let n = 0;
  let i = haystack.indexOf(needle);
  while (i !== -1 && n < 50) {
    // Only whole folder names: the next character must end the path segment.
    const next = haystack[i + needle.length];
    if (next === undefined || /[\\/"'`\s,)\]:]/.test(next)) n++;
    i = haystack.indexOf(needle, i + needle.length);
  }
  return n;
}
