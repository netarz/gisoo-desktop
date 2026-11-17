/**
 * Gisoo Desktop, main process. The Gisoo VS Code extension's core runs here unchanged (its `vscode`
 * import is the shim in ../shim); this file does what the extension's `activate()` does, plus the
 * window, the projects and the IPC the shell needs.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, net, protocol, shell } from 'electron';
import type * as vscodeTypes from 'vscode';
import { GisooClient } from '../src/api/client';
import { AuthService, SECRET_KEY } from '../src/auth/service';
import { baseUrlFromSettings, getSettings } from '../src/config';
import { createMemoryTool } from '../src/context/memory';
import { activateGraph } from '../src/graph';
import { previewManager } from '../src/preview/manager';
import { formatCoins } from '../src/shared/coins';
import { Links, type AccountInfo } from '../src/shared/protocol';
import { createSkillTool } from '../src/skills/catalog';
import { installSkillCommand } from '../src/skills/installCommand';
import * as tools from '../src/tools';
import { hostStr, type HostStringKey } from '../src/ui/strings';
import { setVoiceInput, VoiceInput } from '../src/voice/service';
import { setHost } from '../shim/host';
import { currentProject, runInProject } from '../shim/scope';
import { defaultValue, SCHEMA, SettingsStore } from '../shim/settings';
import { commands, env, fireTrustGranted, installSettings, setUiLanguage, Uri, window as vsWindow, workspace } from '../shim/vscode';
import type { AccountView, AppState, Lang, OpenChatRequest, SettingField } from './api';
import { ChatManager } from './chats';
import { createContext } from './context';
import { HostBridge } from './hostBridge';
import { McpHub } from './mcp';
import { Projects } from './projects';

const SCHEME = 'gisoo-desktop';
const APP_ORIGIN = 'app://gisoo';
/**
 * Chat pages load from an origin of their own. The chat renders model output, so it is the page most
 * exposed to injected content; a different origin means it cannot reach the shell's `window.gisoo`
 * bridge and can only talk through postMessage, which the shell checks.
 */
const CHAT_ORIGIN = 'app://chat';
const dist = __dirname;
const appRoot = path.resolve(dist, '..');
const version = app.getVersion();
/** Development hooks (separate profile, snapshots, devtools) exist only when running from source. */
const dev = !app.isPackaged;

protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, codeCache: true } }]);

// A separate profile for trying the app without touching the real one (projects, sign-in, chats).
if (dev && process.env.GISOO_USER_DATA) app.setPath('userData', path.resolve(process.env.GISOO_USER_DATA));

// Started from the Dock or Finder, a macOS app gets a bare PATH (no Homebrew, nvm, npx…), so commands and
// MCP servers would not be found. Take the PATH the owner's login shell builds, once, at startup.
if (app.isPackaged && process.platform !== 'win32') loginShellPath();

function loginShellPath(): void {
  try {
    const shellBin = process.env.SHELL || (process.platform === 'darwin' ? '/bin/zsh' : '/bin/sh');
    const mark = '__GISOO_PATH__';
    const out = execFileSync(shellBin, ['-ilc', `printf '${mark}%s${mark}' "$PATH"`], {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env, DISABLE_AUTO_UPDATE: 'true' },
    });
    const found = out.split(mark)[1];
    if (found && found.includes('/')) process.env.PATH = found;
  } catch {
    /* keep the PATH we were given */
  }
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  main();
}

function main(): void {
  let win: BrowserWindow | undefined;
  /** A sign-in link that arrived before the core was ready. */
  let pendingUri: string | undefined;
  let core: Core | undefined;

  if (process.defaultApp && process.argv[1]) app.setAsDefaultProtocolClient(SCHEME, process.execPath, [path.resolve(process.argv[1])]);
  else app.setAsDefaultProtocolClient(SCHEME);

  const takeUri = (url: string | undefined): void => {
    if (!url || !url.toLowerCase().startsWith(`${SCHEME}:`)) return;
    if (core) void core.auth.handleUri(Uri.parse(url) as unknown as vscodeTypes.Uri);
    else pendingUri = url;
  };
  app.on('open-url', (event, url) => {
    event.preventDefault();
    takeUri(url);
  });
  app.on('second-instance', (_e, argv) => {
    takeUri(argv.find((a) => a.toLowerCase().startsWith(`${SCHEME}:`)));
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
  takeUri(process.argv.find((a) => a.toLowerCase().startsWith(`${SCHEME}:`)));

  app.whenReady().then(() => {
    Menu.setApplicationMenu(process.platform === 'darwin' ? macMenu() : null);
    serveApp();
    const userData = app.getPath('userData');
    const settings = new SettingsStore(path.join(userData, 'settings.json'));
    installSettings(settings);
    setUiLanguage(app.getLocale());

    const bridge = new HostBridge(() => win);
    setHost(bridge);
    core = startCore(userData, settings, bridge, () => win);
    win = createWindow();
    core.attach(() => win);
    if (pendingUri) takeUri(pendingUri);

    app.on('activate', () => {
      if (!BrowserWindow.getAllWindows().length) win = createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
  app.on('before-quit', () => core?.dispose());
}

// -----------------------------------------------------------------------------------------------
// The core: what the extension's activate() builds
// -----------------------------------------------------------------------------------------------

interface Core {
  auth: AuthService;
  attach(win: () => BrowserWindow | undefined): void;
  dispose(): void;
}

function startCore(userData: string, settings: SettingsStore, bridge: HostBridge, getWin: () => BrowserWindow | undefined): Core {
  const send = (channel: string, ...args: unknown[]): void => {
    const w = getWin();
    if (w && !w.isDestroyed()) w.webContents.send(channel, ...args);
  };
  const t = (key: HostStringKey, ...args: Array<string | number>): string => hostStr(getSettings().language, key, ...args);
  const context = createContext({ userData, appRoot, version });
  const ctx = context as unknown as vscodeTypes.ExtensionContext;

  const client = new GisooClient({
    baseUrl: baseUrlFromSettings(),
    getApiKey: () => Promise.resolve(context.secrets.get(SECRET_KEY)),
    userAgent: `gisoo-desktop/${version}`,
  });
  const auth = new AuthService(ctx, client);
  const voice = new VoiceInput({
    transcribe: (audio, opts) => client.transcribe(audio, opts),
    message: (problem, detail) => hostStr(getSettings().language, `host.voice.${problem}` as HostStringKey, detail ?? ''),
  });
  setVoiceInput(voice);

  // eslint-disable-next-line prefer-const -- the chats need the projects and the projects post to the chats
  let chats: ChatManager;
  const projects = new Projects(userData, (projectId, message) => chats?.broadcast(projectId, message));
  chats = new ChatManager({ projects, context, client, auth, send });

  // Memory and skills belong to the project of the chat that calls them.
  const projectContext = () => {
    const p = currentProject();
    const rt = p ? projects.runtime(p.id) : undefined;
    if (!rt) throw new Error('No project is open.');
    return rt.context;
  };
  // Memory writes into the project folder without asking, so only a folder the owner trusts offers it.
  const unregisterMemory = tools.registerTool(createMemoryTool({ stores: () => projectContext().stores(), onChanged: () => projectContext().markDirty() }), {
    readOnly: false,
    needsApproval: false,
    available: () => !!currentProject()?.trusted,
  });
  const unregisterSkill = tools.registerTool(createSkillTool({ skills: () => projectContext().skillList(), onLoaded: (skill) => projectContext().allowSkillReads(skill) }), {
    readOnly: true,
    needsApproval: false,
  });

  // The code graph: one manager, started for a project when a chat opens in it (one at a time).
  const graph = activateGraph(ctx);
  const graphStarted = new Set<string>();
  let graphQueue: Promise<void> = Promise.resolve();
  const startGraph = (projectId: string, force = false): void => {
    if (graphStarted.has(projectId) && !force) return;
    const rt = projects.runtime(projectId);
    if (!rt || !rt.scope.trusted) return;
    graphStarted.add(projectId);
    graphQueue = graphQueue.then(() => runInProject(rt.scope, () => graph.start())).catch(() => undefined);
  };
  const preview = previewManager();

  // MCP servers (Claude Code, Codex and Gisoo configs, plus AStack's shared brain), per trusted project.
  const mcp = new McpHub({
    userData,
    version,
    lang: () => getSettings().language,
    project: (id) => {
      const p = projects.get(id);
      return p && !p.missing ? { root: p.root, trusted: p.trusted } : undefined;
    },
    confirm: async ({ title, detail, yes, no }) => {
      const w = getWin();
      const opts = { type: 'question' as const, buttons: [yes, no], defaultId: 1, cancelId: 1, title: 'Gisoo', message: title, detail, noLink: true };
      const { response } = w && !w.isDestroyed() ? await dialog.showMessageBox(w, opts) : await dialog.showMessageBox(opts);
      return response === 0;
    },
    onChange: (projectId) => send('mcp:changed', projectId),
  });

  const accountView = (a: AccountInfo): AccountView => {
    const lang = getSettings().language;
    return {
      signedIn: a.signedIn,
      balance: a.balanceCoins === undefined ? undefined : formatCoins(a.balanceCoins, lang),
      projectName: a.projectName,
      keyName: a.keyName,
      error: a.error,
      signInWaiting: a.signInWaiting,
      signInUrl: a.signInUrl,
    };
  };
  const lang = (): Lang => getSettings().language;
  const appState = (): AppState => ({
    lang: lang(),
    platform: process.platform,
    version,
    projects: projects.list(),
    account: accountView(auth.getAccount()),
    unassigned: chats.unassigned(),
  });
  const pushState = (): void => send('state:changed', appState());

  const subs: Array<{ dispose(): unknown }> = [
    auth,
    { dispose: unregisterMemory },
    { dispose: unregisterSkill },
    graph,
    preview,
    mcp,
    { dispose: () => setVoiceInput(undefined) },
    auth.onDidChange(() => pushState()),
    workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('gisoo.region') || e.affectsConfiguration('gisoo.baseUrl')) {
        auth.applyBase();
        void auth.refresh();
      }
      if (e.affectsConfiguration('gisoo.language')) pushState();
    }),
  ];

  // -- Commands the core calls ------------------------------------------------------------------
  const showSignedIn = (info: AccountInfo): void => {
    void vsWindow.showInformationMessage(info.balanceCoins !== undefined ? t('host.signedInWithBalance', formatCoins(info.balanceCoins, lang())) : t('host.signedIn'));
  };
  const signInWithBrowser = async (): Promise<void> => {
    const pending = auth.signInWithBrowser();
    pushState();
    try {
      showSignedIn(await pending);
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      if (text === t('host.auth.cancelled') || text === t('host.auth.superseded')) return;
      void vsWindow.showErrorMessage(text);
    } finally {
      pushState();
    }
  };
  const signInWithKey = async (): Promise<void> => {
    const key = await vsWindow.showInputBox({
      title: t('host.apiKey.title'),
      prompt: t('host.apiKey.prompt'),
      placeHolder: 'sk-gisoo-v1-',
      password: true,
      ignoreFocusOut: true,
      validateInput: (value: string) => (value.trim() && !value.trim().startsWith('sk-') ? t('host.apiKey.invalid') : undefined),
    });
    if (!key) return;
    showSignedIn(await auth.signInWithKey(key));
  };
  const enterCode = async (): Promise<void> => {
    const code = await vsWindow.showInputBox({ title: t('host.code.title'), prompt: t('host.code.prompt'), ignoreFocusOut: true });
    if (!code) return;
    showSignedIn(await auth.completeWithCode(code));
  };
  const signOut = async (): Promise<void> => {
    await auth.signOut();
    const choice = await vsWindow.showInformationMessage(t('host.signOut.done'), t('host.manageKeys'));
    if (choice) await env.openExternal(Uri.parse(Links.keys));
  };
  const reg = (id: string, run: (...args: unknown[]) => unknown) =>
    subs.push(
      commands.registerCommand(id, async (...args: unknown[]) => {
        try {
          await run(...args);
        } catch (error) {
          void vsWindow.showErrorMessage(`${error instanceof Error ? error.message : String(error)}`);
        }
      }),
    );
  reg('gisoo.signIn', signInWithBrowser);
  reg('gisoo.signInWithKey', signInWithKey);
  reg('gisoo.enterCode', enterCode);
  reg('gisoo.signOut', signOut);
  reg('gisoo.showAccount', () => send('host:notice', { kind: 'settings', query: 'account' }));
  reg('gisoo.openSettings', () => send('host:notice', { kind: 'settings' }));
  // "Open in a new tab" / "Move chat": in the desktop app every chat already is a tab of its own.
  reg('gisoo.openInTab', () => {
    const a = chats.active();
    if (a) send('chat:openRequest', { projectId: a.projectId, sessionId: null });
  });
  reg('gisoo.moveChat', () => undefined);
  reg('gisoo.newChat', () => {
    const a = chats.active();
    if (a) send('chat:openRequest', { projectId: a.projectId, sessionId: null });
  });
  reg('gisoo.installSkill', async (source?: unknown) => {
    const installed = await installSkillCommand(typeof source === 'string' ? source : undefined);
    const p = currentProject();
    if (installed && p) await projects.runtime(p.id)?.context.reload();
  });
  reg('gisoo.rebuildGraph', () => {
    const p = currentProject();
    const rt = p ? projects.runtime(p.id) : undefined;
    return rt ? runInProject(rt.scope, () => graph.rebuild()) : undefined;
  });

  // -- IPC ----------------------------------------------------------------------------------------
  const handle = (channel: string, fn: (...args: any[]) => unknown): void => {
    ipcMain.handle(channel, async (event, ...args) => {
      if (!isAppFrame(event.senderFrame?.url)) throw new Error('blocked');
      return fn(...args);
    });
  };

  handle('app:state', () => appState());
  handle('projects:add', async (root?: string) => {
    let folder = typeof root === 'string' ? root : undefined;
    if (!folder) {
      const picked = await bridge.openDialog({ title: lang() === 'fa' ? 'پوشهٔ پروژه را انتخاب کنید' : 'Choose a project folder', folders: true });
      folder = picked?.[0];
    }
    if (!folder) return undefined;
    const info = projects.add(folder);
    pushState();
    return info;
  });
  handle('projects:remove', (id: string) => {
    chats.closeProject(id);
    mcp.closeProject(id);
    projects.remove(id);
    pushState();
  });
  handle('projects:trust', (id: string, trusted: boolean) => {
    projects.setTrusted(id, !!trusted);
    const rt = projects.runtime(id);
    if (rt && trusted) {
      // Instruction files, commands and the graph now load for this folder.
      runInProject(rt.scope, () => fireTrustGranted());
      startGraph(id, true);
      void mcp.ensure(id);
    } else if (!trusted) {
      mcp.closeProject(id);
    }
    pushState();
  });
  handle('projects:reveal', (id: string) => {
    const p = projects.get(id);
    if (p && !p.missing) void shell.openPath(p.root);
  });
  handle('chats:list', (projectId: string) => chats.list(projectId));
  handle('chats:delete', (projectId: string, sessionId: string) => chats.delete(projectId, sessionId));
  handle('chats:rename', (projectId: string, sessionId: string, title: string) => chats.rename(projectId, sessionId, String(title ?? '')));
  handle('chat:open', async (req: OpenChatRequest) => {
    const opened = await chats.open(req);
    startGraph(req.projectId);
    // Connected in the background; a server that is still starting simply offers its tools a moment later.
    void mcp.ensure(req.projectId);
    return opened;
  });
  handle('mcp:list', (projectId: string) => mcp.list(String(projectId)));
  handle('mcp:set', (projectId: string, name: string, enabled: boolean) => mcp.setEnabled(String(projectId), String(name), !!enabled));
  handle('mcp:approve', (projectId: string, name: string, approve: boolean) => mcp.approve(String(projectId), String(name), !!approve));
  handle('mcp:reconnect', (projectId: string, name?: string) => mcp.reconnect(String(projectId), typeof name === 'string' ? name : undefined));
  handle('chat:close', (chatId: string) => chats.close(chatId));
  handle('chat:post', (chatId: string, message: unknown) => chats.post(chatId, message));
  handle('host:reply', (id: number, answer: unknown) => bridge.reply(id, answer));
  handle('settings:get', (projectId?: string) => settingFields(settings, projectId ? projects.get(projectId)?.root : undefined));
  handle('settings:set', async (key: string, value: unknown, projectId?: string) => {
    if (typeof key !== 'string' || !(key in SCHEMA)) throw new Error('unknown setting');
    if (projectId && USER_ONLY.has(key)) throw new Error('user setting');
    const loosens = key !== 'gisoo.permissionMode' || value === 'autoEdit' || value === 'bypass';
    if (SENSITIVE.has(key) && loosens && JSON.stringify(value) !== JSON.stringify(settings.userValue(key))) {
      const fa = lang() === 'fa';
      const shown = typeof value === 'string' ? value : JSON.stringify(value);
      const w = getWin();
      const opts = {
        type: 'warning' as const,
        buttons: fa ? ['تغییر بده', 'انصراف'] : ['Change', 'Cancel'],
        defaultId: 1,
        cancelId: 1,
        title: 'Gisoo',
        message: fa ? `تنظیم «${key}» تغییر کند؟` : `Change ${key}?`,
        detail: `${fa ? 'مقدار تازه' : 'New value'}: ${shown.slice(0, 300)}\n\n${
          fa
            ? 'این تنظیم تعیین می‌کند کلید شما به کدام نشانی فرستاده شود یا دستیار بدون پرسیدن چه کاری بکند.'
            : 'This setting decides where your key is sent or what the agent may do without asking.'
        }`,
      };
      const { response } = w ? await dialog.showMessageBox(w, opts) : await dialog.showMessageBox(opts);
      if (response !== 0) throw new Error('cancelled');
    }
    const root = projectId ? projects.get(projectId)?.root : undefined;
    if (root) settings.setProject(root, key, value);
    else settings.setUser(key, value);
  });
  handle('account:signIn', (kind: 'browser' | 'key' | 'code') =>
    commands.executeCommand(kind === 'key' ? 'gisoo.signInWithKey' : kind === 'code' ? 'gisoo.enterCode' : 'gisoo.signIn'),
  );
  handle('account:cancelSignIn', () => auth.cancelSignIn());
  handle('account:signOut', () => commands.executeCommand('gisoo.signOut'));
  handle('account:refresh', async () => {
    await auth.refresh();
    return accountView(auth.getAccount());
  });
  handle('link:open', (url: string) => bridge.openExternal(String(url)));
  handle('window:control', (action: string) => {
    const w = getWin();
    if (!w) return;
    if (action === 'minimize') w.minimize();
    else if (action === 'maximize') (w.isMaximized() ? w.unmaximize() : w.maximize());
    else if (action === 'close') w.close();
    // The theme: every frame's prefers-color-scheme follows nativeTheme, and so does the title bar.
    else if (action === 'theme:dark' || action === 'theme:light' || action === 'theme:system') nativeTheme.themeSource = action.slice(6) as 'dark' | 'light' | 'system';
  });

  void auth.refresh();

  return {
    auth,
    attach: (w) => {
      const current = w();
      current?.on('closed', () => {
        bridge.cancelAll();
        chats.disposeAll();
      });
    },
    dispose: () => {
      bridge.cancelAll();
      chats.disposeAll();
      projects.disposeAll();
      for (const s of subs.reverse()) {
        try {
          s.dispose();
        } catch {
          /* closing anyway */
        }
      }
      context.globalState.flush();
    },
  };
}

/**
 * Keys the core reads from the user's own settings only (`userSetting` in src/config.ts): they move the API
 * key, the approval policy, the bill or what runs on the machine, so a project file never sets them and the
 * project tab of the settings page does not offer them.
 */
const USER_ONLY = new Set(
  [
    'agents.maxParallel', 'agents.maxTurns', 'allowedCommands', 'baseUrl', 'browserPath', 'customInstructions',
    'graphify.autoInstall', 'importExternalChats', 'maxCostPerTask', 'maxSteps', 'permissionMode', 'region', 'webFetch.enabled',
  ].map((k) => `gisoo.${k}`),
);

/** Changing one of these asks the owner in a native dialog first, whoever asked for it. */
const SENSITIVE = new Set(['gisoo.baseUrl', 'gisoo.allowedCommands', 'gisoo.permissionMode']);

/** Settings for the settings page: every `gisoo.*` key the extension declares, in the UI language. */
function settingFields(store: SettingsStore, projectRoot: string | undefined): SettingField[] {
  const lang = getSettings().language;
  const out: SettingField[] = [];
  for (const [key, s] of Object.entries(SCHEMA)) {
    if (!key.startsWith('gisoo.')) continue;
    if (projectRoot && USER_ONLY.has(key)) continue;
    const projectValue = projectRoot ? store.projectValue(projectRoot, key) : undefined;
    const value = projectValue !== undefined ? projectValue : store.userValue(key);
    const desc = s.description?.[lang] ?? s.description?.en ?? '';
    out.push({
      key,
      type: Array.isArray(s.type) ? s.type[0] : (s.type ?? 'string'),
      value: value === undefined ? defaultValue(key) : value,
      defaultValue: defaultValue(key),
      enum: s.enum,
      enumLabels: s.enumDescriptions?.[lang] ?? s.enumDescriptions?.en,
      label: key.replace(/^gisoo\./, ''),
      description: desc,
      scope: projectValue !== undefined ? 'project' : s.scope,
    });
  }
  return out;
}

// -----------------------------------------------------------------------------------------------
// Window and pages
// -----------------------------------------------------------------------------------------------

function isAppFrame(url: string | undefined): boolean {
  return !!url && url.startsWith(`${APP_ORIGIN}/`);
}

function isChatFrame(url: string | undefined): boolean {
  return !!url && url.startsWith(`${CHAT_ORIGIN}/chat/chat.html`);
}

const BASE_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; " +
  "connect-src 'self'; media-src 'self' blob:; object-src 'none'; base-uri 'none'; form-action 'none'";

/**
 * Serves dist/ as app://gisoo/… (the shell) and the chat page, its scripts and fonts as app://chat/…;
 * nothing outside dist/ is reachable, and the chat origin reaches only what the chat page needs.
 */
function serveApp(): void {
  protocol.handle('app', async (request) => {
    const url = new URL(request.url);
    if (url.host !== 'gisoo' && url.host !== 'chat') return new Response('not found', { status: 404 });
    const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '');
    if (url.host === 'chat' && !/^(chat|fonts)\//.test(rel)) return new Response('not found', { status: 404 });
    const file = path.resolve(dist, rel);
    if (!file.startsWith(dist + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return new Response('not found', { status: 404 });
    const res = await net.fetch(`file://${file.replace(/\\/g, '/').replace(/^([A-Za-z]):/, '/$1:')}`);
    const headers = new Headers(res.headers);
    headers.set('X-Content-Type-Options', 'nosniff');
    if (file.endsWith('.html')) {
      headers.set(
        'Content-Security-Policy',
        url.host === 'chat'
          ? `${BASE_CSP}; frame-src 'none'; frame-ancestors ${APP_ORIGIN}`
          : `${BASE_CSP}; frame-src ${CHAT_ORIGIN}; frame-ancestors 'none'`,
      );
    }
    return new Response(res.body, { status: res.status, headers });
  });
}

function createWindow(): BrowserWindow {
  const dark = nativeTheme.shouldUseDarkColors;
  const mac = process.platform === 'darwin';
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 760,
    minHeight: 520,
    show: false,
    title: 'Gisoo',
    backgroundColor: dark ? '#17171a' : '#fbfbfa',
    titleBarStyle: 'hidden',
    ...(mac
      ? { trafficLightPosition: { x: 14, y: 14 } }
      : { titleBarOverlay: { color: dark ? '#17171a' : '#fbfbfa', symbolColor: dark ? '#e8e8ea' : '#2b2b30', height: 40 } }),
    icon: path.join(appRoot, 'build', process.platform === 'win32' ? 'icon.ico' : 'icon.png'),
    webPreferences: {
      preload: path.join(dist, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });
  nativeTheme.on('updated', () => {
    if (win.isDestroyed() || mac) return;
    const d = nativeTheme.shouldUseDarkColors;
    win.setTitleBarOverlay({ color: d ? '#17171a' : '#fbfbfa', symbolColor: d ? '#e8e8ea' : '#2b2b30' });
    win.setBackgroundColor(d ? '#17171a' : '#fbfbfa');
  });
  win.once('ready-to-show', () => win.show());
  // Links leave the app through the system browser; the window itself never navigates away.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^(https?:|mailto:)/i.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!isAppFrame(url)) {
      e.preventDefault();
      if (/^(https?:|mailto:)/i.test(url)) void shell.openExternal(url);
    }
  });
  // The shell stays the shell; a frame may only ever be a chat page.
  win.webContents.on('will-frame-navigate', (e) => {
    if (e.isMainFrame ? !isAppFrame(e.url) : !isChatFrame(e.url)) e.preventDefault();
  });
  win.webContents.on('will-attach-webview', (e) => e.preventDefault());
  // The composer's mic needs audio; nothing else (camera, location, notifications…) is granted.
  const ours = (origin: string | undefined) => !!origin && (origin.startsWith(APP_ORIGIN) || origin.startsWith(CHAT_ORIGIN));
  const ses = win.webContents.session;
  ses.setPermissionRequestHandler((_wc, permission, cb, details) => {
    if (!ours(details.requestingUrl)) return cb(false);
    if (permission === 'clipboard-sanitized-write') return cb(true);
    if (permission === 'media') {
      const types = (details as { mediaTypes?: string[] }).mediaTypes ?? [];
      return cb(types.length > 0 && types.every((t) => t === 'audio'));
    }
    cb(false);
  });
  ses.setPermissionCheckHandler((_wc, permission, origin, details) => {
    if (!ours(origin)) return false;
    if (permission === 'clipboard-sanitized-write') return true;
    if (permission === 'media') return (details as { mediaType?: string }).mediaType === 'audio';
    return false;
  });
  void win.loadURL(`${APP_ORIGIN}/shell/index.html`);
  if (dev && process.env.GISOO_DEVTOOLS === '1') win.webContents.openDevTools({ mode: 'detach' });
  if (dev && process.env.GISOO_SNAPSHOT) snapshot(win, process.env.GISOO_SNAPSHOT);
  return win;
}

/**
 * Development aid: `GISOO_SNAPSHOT=out.png` prints every page's console errors, saves a picture of the
 * window after a few seconds and quits. `GISOO_SNAPSHOT_JS` is run in the shell first (e.g. to click a row).
 */
function snapshot(win: BrowserWindow, file: string): void {
  const log = (where: string) => (_e: unknown, level: number, message: string, line: number, source: string) => {
    if (level >= 2) console.log(`[${where}] ${message} (${source}:${line})`);
  };
  win.webContents.on('console-message', log('shell') as never);
  win.webContents.on('did-frame-finish-load', () => {
    for (const f of win.webContents.mainFrame.framesInSubtree) {
      if (f !== win.webContents.mainFrame) f.on('console-message' as never, log('chat') as never);
    }
  });
  win.webContents.once('did-finish-load', async () => {
    const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
    await wait(Number(process.env.GISOO_SNAPSHOT_WAIT ?? 4000));
    if (process.env.GISOO_SNAPSHOT_JS) {
      await win.webContents.executeJavaScript(process.env.GISOO_SNAPSHOT_JS).catch((e) => console.log('[snapshot js]', e));
      await wait(2500);
    }
    const img = await win.webContents.capturePage();
    fs.writeFileSync(file, img.toPNG());
    console.log(`[snapshot] ${file}`);
    app.exit(0);
  });
}

function macMenu(): Menu {
  return Menu.buildFromTemplate([
    { role: 'appMenu' },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
  ]);
}
