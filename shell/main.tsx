/**
 * Gisoo Desktop's window, Codex style: a quiet sidebar of project folders with each project's chats
 * (Gisoo's own, plus Claude Code, Codex and VS Code chats of the same folder), Recents, the account,
 * and on the other side the open chat — the extension's own chat page in an iframe, one per chat.
 */
import { render } from 'preact';
import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { AccountView, AppState, ChatItem, ChatMeta, HostNotice, HostRequest, OpenChatRequest, OpenedChat, ProjectInfo } from '../main/api';
import { Icon } from './icons';
import { AskView, DiffView, DocumentView, Menu, TaskDrawer, Toasts, type Ask, type MenuItem, type Task, type Toast } from './overlays';
import { applyTheme, SettingsPage, type Theme } from './settings';
import { ago, bridge, isMac, save, setLang, store, t } from './util';
import markSvg from '../assets/chat/gisoo.svg';

/** Open chats kept alive at once; older idle ones are closed (their history stays on disk). */
const MAX_OPEN = 8;
/** Width of the native window controls: macOS traffic lights on the left, the Windows/Linux overlay on the right. */
const CONTROLS = isMac ? { side: 'left' as const, px: 78 } : { side: 'right' as const, px: 140 };
const PREVIEW_COUNT = 5;

interface OpenChat extends OpenedChat {
  title?: string;
  running: boolean;
  /** The page inside the iframe has spoken (it posts `ready` first); before that messages wait. */
  ready: boolean;
}

type Overlay = { kind: 'document'; doc: Extract<HostNotice, { kind: 'document' }> } | { kind: 'diff'; diff: Extract<HostNotice, { kind: 'diff' }> };
type MenuState = { x: number; y: number; items: Array<MenuItem | 'sep'>; key: string };

function Mark({ size = 20 }: { size?: number }) {
  return <span class="mark-svg" style={{ display: 'inline-flex', width: size, height: size }} dangerouslySetInnerHTML={{ __html: markSvg.replace(/width="\d+" height="\d+"/, `width="${size}" height="${size}"`) }} />;
}

function App() {
  const [app, setApp] = useState<AppState>();
  const [lists, setLists] = useState<Record<string, ChatItem[]>>({});
  const [expanded, setExpanded] = useState<Record<string, boolean>>(() => store('expanded', {}));
  const [showAll, setShowAll] = useState<Record<string, boolean>>({});
  const [chats, setChats] = useState<OpenChat[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [currentProject, setCurrentProject] = useState<string | undefined>(() => store<string | undefined>('project', undefined));
  const [sideOpen, setSideOpen] = useState<boolean>(() => store('side', true));
  const [query, setQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [settings, setSettings] = useState<{ query?: string } | null>(null);
  const [asks, setAsks] = useState<Ask[]>([]);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [overlay, setOverlay] = useState<Overlay | null>(null);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [tasksOpen, setTasksOpen] = useState(false);
  const [progress, setProgress] = useState<Record<string, string>>({});
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [trustDismissed, setTrustDismissed] = useState<Record<string, boolean>>({});
  const [busyOpen, setBusyOpen] = useState(false);

  const frames = useRef(new Map<string, HTMLIFrameElement>());
  const pending = useRef(new Map<string, unknown[]>());
  const order = useRef<string[]>([]);
  const chatsRef = useRef(chats);
  chatsRef.current = chats;
  const searchRef = useRef<HTMLInputElement>(null);
  const toastSeq = useRef(0);
  const autoOpened = useRef(false);

  const projects = app?.projects ?? [];
  const project = (id?: string) => projects.find((p) => p.id === id);
  const activeChat = chats.find((c) => c.chatId === active);
  const focusProject = project(activeChat?.projectId) ?? project(currentProject) ?? projects[0];

  // ----------------------------------------------------------------------------- loading

  const loadList = useCallback(async (projectId: string) => {
    try {
      const items = await bridge.invoke<ChatItem[]>('chats:list', projectId);
      setLists((l) => ({ ...l, [projectId]: items }));
    } catch {
      /* the project was removed meanwhile */
    }
  }, []);

  useEffect(() => {
    void bridge.invoke<AppState>('app:state').then((s) => {
      setLang(s.lang);
      setApp(s);
      for (const p of s.projects) void loadList(p.id);
    });
    applyTheme(store<Theme>('theme', 'system'));
  }, []);

  // ----------------------------------------------------------------------------- chats

  const toFrame = (chatId: string, msg: unknown) => {
    const f = frames.current.get(chatId);
    f?.contentWindow?.postMessage(msg, location.origin);
  };

  const touch = (chatId: string) => {
    order.current = [chatId, ...order.current.filter((x) => x !== chatId)];
  };

  /** Closes the oldest idle chats beyond the limit. */
  const trim = (keep: string) => {
    const open = chatsRef.current;
    if (open.length <= MAX_OPEN) return;
    const idle = order.current.filter((id) => id !== keep && !open.find((c) => c.chatId === id)?.running);
    const drop = idle.slice(-(open.length - MAX_OPEN));
    for (const id of drop) void closeChat(id);
  };

  const closeChat = async (chatId: string) => {
    await bridge.invoke('chat:close', chatId).catch(() => undefined);
    frames.current.delete(chatId);
    pending.current.delete(chatId);
    order.current = order.current.filter((x) => x !== chatId);
    setChats((cs) => cs.filter((c) => c.chatId !== chatId));
    setActive((a) => (a === chatId ? null : a));
  };

  const show = (chatId: string, projectId: string) => {
    setActive(chatId);
    setSettings(null);
    setCurrentProject(projectId);
    save('project', projectId);
    touch(chatId);
    setTimeout(() => frames.current.get(chatId)?.focus(), 0);
  };

  const openChat = async (req: OpenChatRequest) => {
    // The same conversation already open: just show it.
    if (req.sessionId) {
      const same = chatsRef.current.find((c) => c.projectId === req.projectId && c.sessionId === req.sessionId);
      if (same) return show(same.chatId, same.projectId);
    }
    setBusyOpen(true);
    try {
      const opened = await bridge.invoke<OpenedChat>('chat:open', req);
      if (!chatsRef.current.some((c) => c.chatId === opened.chatId)) {
        setChats((cs) => [...cs, { ...opened, running: false, ready: false }]);
      }
      show(opened.chatId, opened.projectId);
      setTimeout(() => trim(opened.chatId), 0);
      if (req.external || req.vscode) void loadList(req.projectId);
    } catch (e) {
      pushToast('error', t('گفت‌وگو باز نشد: {e}', 'Could not open the chat: {e}', { e: (e as Error).message }));
    } finally {
      setBusyOpen(false);
    }
  };

  const newChat = (projectId?: string) => {
    const pid = projectId ?? focusProject?.id;
    if (!pid) return void addProject();
    // A fresh, still empty chat of that project is reused instead of piling up empty ones.
    const fresh = chatsRef.current.find((c) => c.projectId === pid && !c.title && !c.running);
    if (fresh) return show(fresh.chatId, pid);
    void openChat({ projectId: pid, sessionId: null });
  };

  const openItem = (projectId: string, item: ChatItem) => {
    if (item.kind === 'gisoo') return void openChat({ projectId, sessionId: item.id });
    if (item.importedId) return void openChat({ projectId, sessionId: item.importedId });
    if (item.kind === 'external' && item.source) return void openChat({ projectId, external: { source: item.source, id: item.id } });
    return void openChat({ projectId, vscode: { id: item.id } });
  };

  // Messages from the chat pages go to the main process.
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== location.origin) return;
      const data = event.data as { gisooChat?: string; msg?: unknown } | null;
      if (!data || typeof data.gisooChat !== 'string') return;
      const chatId = data.gisooChat;
      const frame = frames.current.get(chatId);
      if (!frame || event.source !== frame.contentWindow) return;
      const waiting = pending.current.get(chatId);
      if (waiting) {
        pending.current.delete(chatId);
        setChats((cs) => cs.map((c) => (c.chatId === chatId ? { ...c, ready: true } : c)));
        for (const m of waiting) toFrame(chatId, m);
      }
      void bridge.invoke('chat:post', chatId, data.msg);
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  // Everything the main process says.
  useEffect(() => {
    const offs = [
      bridge.on('chat:msg', (chatId: string, msg: unknown) => {
        const waiting = pending.current.get(chatId);
        if (waiting) waiting.push(msg);
        else toFrame(chatId, msg);
      }),
      bridge.on('chat:meta', (meta: ChatMeta) => {
        setChats((cs) => cs.map((c) => (c.chatId === meta.chatId ? { ...c, sessionId: meta.sessionId, title: meta.title, running: meta.running } : c)));
      }),
      bridge.on('sidebar:changed', (projectId: string) => void loadList(projectId)),
      bridge.on('state:changed', (s: AppState) => {
        setLang(s.lang);
        setApp((old) => {
          for (const p of s.projects) if (!old?.projects.some((o) => o.id === p.id)) void loadList(p.id);
          return s;
        });
      }),
      bridge.on('chat:openRequest', (req: { chatId?: string; projectId?: string; sessionId?: string | null }) => {
        if (req.chatId) {
          const c = chatsRef.current.find((x) => x.chatId === req.chatId);
          if (c) show(c.chatId, c.projectId);
        } else if (req.projectId) {
          if (req.sessionId) void openChat({ projectId: req.projectId, sessionId: req.sessionId });
          else newChat(req.projectId);
        }
      }),
      bridge.on('host:request', (id: number, req: HostRequest) => {
        const answer = (value: unknown) => {
          setAsks((a) => a.filter((x) => x.id !== id));
          void bridge.invoke('host:reply', id, value);
        };
        // A non-modal message is a toast; its buttons answer the question.
        if (req.kind === 'message' && !req.modal && req.actions.length <= 3) {
          pushToast(req.level, req.detail ? `${req.text}\n${req.detail}` : req.text, req.actions, (i) => void bridge.invoke('host:reply', id, i));
          return;
        }
        setAsks((a) => [...a, { id, req, answer }]);
      }),
      bridge.on('host:notice', (n: HostNotice) => {
        if (n.kind === 'toast') pushToast(n.level, n.text);
        else if (n.kind === 'document') setOverlay({ kind: 'document', doc: n });
        else if (n.kind === 'diff') setOverlay({ kind: 'diff', diff: n });
        else if (n.kind === 'settings') setSettings({ query: n.query });
        else if (n.kind === 'progress') {
          setProgress((p) => {
            const next = { ...p };
            if (n.done) delete next[n.id];
            else next[n.id] = n.title;
            return next;
          });
        } else if (n.kind === 'task') {
          setTasks((ts) => {
            const found = ts.find((x) => x.id === n.id);
            const output = ((found?.output ?? '') + n.chunk).slice(-200_000);
            const next = found ? ts.map((x) => (x.id === n.id ? { ...x, output, exitCode: n.exitCode } : x)) : [...ts, { id: n.id, title: n.title, output, exitCode: n.exitCode }];
            return next.slice(-6);
          });
          if (!n.chunk && n.exitCode === undefined) setTasksOpen(true);
          if (n.exitCode === undefined) setTasksOpen(true);
        }
      }),
    ];
    return () => offs.forEach((off) => off());
  }, []);

  // ----------------------------------------------------------------------------- toasts

  const pushToast = (level: Toast['level'], text: string, actions?: string[], answer?: (i: number | undefined) => void) => {
    const id = ++toastSeq.current;
    setToasts((ts) => [...ts.slice(-3), { id, level, text, actions, answer }]);
    if (!actions?.length) setTimeout(() => setToasts((ts) => ts.filter((x) => x.id !== id)), level === 'error' ? 9000 : 5000);
  };
  const dismissToast = (id: number, choice?: number) => {
    setToasts((ts) => {
      ts.find((x) => x.id === id)?.answer?.(choice);
      return ts.filter((x) => x.id !== id);
    });
  };

  // ----------------------------------------------------------------------------- projects

  const addProject = async () => {
    const info = await bridge.invoke<ProjectInfo | undefined>('projects:add');
    if (!info) return;
    setExpanded((e) => {
      const next = { ...e, [info.id]: true };
      save('expanded', next);
      return next;
    });
    void loadList(info.id);
    void openChat({ projectId: info.id, sessionId: null });
  };

  const toggleProject = (id: string) => {
    setExpanded((e) => {
      const next = { ...e, [id]: !(e[id] ?? true) };
      save('expanded', next);
      return next;
    });
  };

  const localAsk = (req: HostRequest) =>
    new Promise<unknown>((resolve) => {
      const id = -Date.now();
      setAsks((a) => [...a, { id, req, answer: (v) => (setAsks((x) => x.filter((y) => y.id !== id)), resolve(v)) }]);
    });

  const projectMenu = (p: ProjectInfo, e: MouseEvent) => {
    e.stopPropagation();
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setMenu({
      key: `p:${p.id}`,
      x: r.left,
      y: r.bottom + 4,
      items: [
        { label: t('گفت‌وگوی تازه', 'New chat'), icon: 'newChat', run: () => newChat(p.id) },
        { label: t('باز کردن پوشه', 'Open folder'), icon: 'reveal', run: () => void bridge.invoke('projects:reveal', p.id) },
        p.trusted
          ? { label: t('لغو اعتماد به این پوشه', 'Stop trusting this folder'), icon: 'shield', run: () => void bridge.invoke('projects:trust', p.id, false) }
          : { label: t('اعتماد به این پوشه', 'Trust this folder'), icon: 'shield', run: () => void bridge.invoke('projects:trust', p.id, true) },
        {
          label: t('تنظیمات این پروژه', 'Project settings'),
          icon: 'settings',
          run: () => {
            setCurrentProject(p.id);
            setSettings({});
          },
        },
        'sep',
        {
          label: t('حذف از فهرست', 'Remove from list'),
          icon: 'trash',
          danger: true,
          run: async () => {
            const ok = await localAsk({
              kind: 'message',
              level: 'warning',
              modal: true,
              text: t('«{p}» از فهرست برداشته شود؟', 'Remove {p} from the list?', { p: p.name }),
              detail: t('پوشه و گفت‌وگوهایش پاک نمی‌شوند؛ هر وقت دوباره اضافه‌اش کنید برمی‌گردند.', 'The folder and its chats are not deleted; add it again and they come back.'),
              actions: [t('برداشتن', 'Remove')],
            });
            if (ok === 0) {
              for (const c of chatsRef.current.filter((x) => x.projectId === p.id)) frames.current.delete(c.chatId);
              setChats((cs) => cs.filter((c) => c.projectId !== p.id));
              setActive((a) => (chatsRef.current.find((c) => c.chatId === a)?.projectId === p.id ? null : a));
              await bridge.invoke('projects:remove', p.id);
            }
          },
        },
      ],
    });
  };

  const chatMenu = (projectId: string, item: ChatItem, e: MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const sessionId = item.kind === 'gisoo' ? item.id : item.importedId;
    const items: Array<MenuItem | 'sep'> = [{ label: t('باز کردن', 'Open'), icon: 'chat', run: () => openItem(projectId, item) }];
    if (sessionId) {
      items.push({
        label: t('تغییر نام', 'Rename'),
        icon: 'pencil',
        run: async () => {
          const title = await localAsk({ kind: 'inputBox', title: t('نام تازهٔ گفت‌وگو', 'New chat name'), value: item.title });
          if (typeof title === 'string' && title.trim()) {
            await bridge.invoke('chats:rename', projectId, sessionId, title.trim());
            void loadList(projectId);
          }
        },
      });
      items.push('sep', {
        label: t('حذف گفت‌وگو', 'Delete chat'),
        icon: 'trash',
        danger: true,
        run: async () => {
          const ok = await localAsk({
            kind: 'message',
            level: 'warning',
            modal: true,
            text: t('«{c}» پاک شود؟', 'Delete “{c}”?', { c: item.title }),
            detail: t('این گفت‌وگو از گیسو پاک می‌شود و برنمی‌گردد.', 'This chat is deleted from Gisoo for good.'),
            actions: [t('پاک کن', 'Delete')],
          });
          if (ok !== 0) return;
          const open = chatsRef.current.find((c) => c.projectId === projectId && c.sessionId === sessionId);
          if (open) await closeChat(open.chatId);
          await bridge.invoke('chats:delete', projectId, sessionId);
          void loadList(projectId);
        },
      });
    }
    setMenu({ key: `c:${item.kind}:${item.id}`, x: r.left, y: r.bottom + 4, items });
  };

  // ----------------------------------------------------------------------------- account

  const account: AccountView = app?.account ?? { signedIn: false };
  const signIn = (kind: 'browser' | 'key' | 'code') => void bridge.invoke('account:signIn', kind).catch(() => undefined);

  // First launch with a project and an account: start where Codex starts, on a fresh chat.
  useEffect(() => {
    if (autoOpened.current || !app || !account.signedIn || !projects.length || chats.length) return;
    autoOpened.current = true;
    newChat((project(currentProject) ?? projects[0]).id);
  }, [app, account.signedIn]);

  // ----------------------------------------------------------------------------- keyboard

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = isMac ? e.metaKey : e.ctrlKey;
      if (!mod) return;
      const k = e.key.toLowerCase();
      if (k === 'n') {
        e.preventDefault();
        newChat();
      } else if (k === 'b') {
        e.preventDefault();
        toggleSide();
      } else if (k === ',') {
        e.preventDefault();
        setSettings({});
      } else if (k === 'k') {
        e.preventDefault();
        setSideOpen(true);
        setSearching(true);
        setTimeout(() => searchRef.current?.focus(), 0);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const toggleSide = () =>
    setSideOpen((s) => {
      save('side', !s);
      return !s;
    });

  // ----------------------------------------------------------------------------- window controls

  /** The edge of the main pane that the native controls sit on, and the room they need there. */
  const reserve = useMemo(() => {
    const r = { left: 0, right: 0 };
    // The sidebar is on the inline-start side: right in Persian, left in English.
    const rtl = app?.lang !== 'en';
    const sideEdge = rtl ? 'right' : 'left';
    if (!sideOpen || CONTROLS.side !== sideEdge) r[CONTROLS.side] += CONTROLS.px;
    // With the sidebar hidden, its toggle floats on that edge too.
    if (!sideOpen) r[sideEdge] += 40;
    return r;
  }, [sideOpen, app?.lang]);

  useEffect(() => {
    for (const f of frames.current.values()) f.contentWindow?.postMessage({ gisooReserve: reserve }, location.origin);
  }, [reserve, chats.length]);

  const sideBar = useMemo(() => {
    const rtl = app?.lang !== 'en';
    const sideEdge = rtl ? 'right' : 'left';
    const pad = { left: 10, right: 10 };
    if (CONTROLS.side === sideEdge) pad[CONTROLS.side] += CONTROLS.px;
    return { paddingLeft: pad.left, paddingRight: pad.right };
  }, [app?.lang]);
  const mainBar = { paddingLeft: 10 + reserve.left, paddingRight: 10 + reserve.right };

  // ----------------------------------------------------------------------------- views

  if (!app) {
    return (
      <div class="app" style={{ alignItems: 'center', justifyContent: 'center', WebkitAppRegion: 'drag' } as any}>
        <span class="spinner" />
      </div>
    );
  }

  const needle = query.trim().toLowerCase();
  const runningSessions = new Set(chats.filter((c) => c.running && c.sessionId).map((c) => `${c.projectId}:${c.sessionId}`));
  const activeKey = activeChat?.sessionId ? `${activeChat.projectId}:${activeChat.sessionId}` : '';
  const itemKey = (pid: string, it: ChatItem) => `${pid}:${it.kind === 'gisoo' ? it.id : (it.importedId ?? `${it.kind}:${it.id}`)}`;

  const recents = projects
    .flatMap((p) => (lists[p.id] ?? []).map((it) => ({ p, it })))
    .filter(({ it }) => it.kind === 'gisoo' || it.importedId)
    .sort((a, b) => b.it.updatedAt - a.it.updatedAt)
    .slice(0, 6);

  const chatRow = (p: ProjectInfo, it: ChatItem, recent = false) => {
    const key = itemKey(p.id, it);
    const running = runningSessions.has(key);
    const source = it.kind === 'vscode' ? 'VS Code' : it.kind === 'external' ? it.sourceLabel ?? it.source : undefined;
    return (
      <div
        key={`${recent ? 'r' : 'p'}:${key}`}
        class={`row chat-row${recent ? ' recent' : ''}${key === activeKey && !settings ? ' active' : ''}${menu?.key === `c:${it.kind}:${it.id}` ? ' menu-open' : ''}${it.kind !== 'gisoo' && !it.importedId ? ' muted' : ''}`}
        role="button"
        tabIndex={0}
        title={it.title}
        onClick={() => openItem(p.id, it)}
        onKeyDown={(e) => e.key === 'Enter' && openItem(p.id, it)}
        onContextMenu={(e) => chatMenu(p.id, it, e)}
      >
        {running && <span class="dot" />}
        <span class="title" dir="auto">{it.title || t('گفت‌وگوی بی‌نام', 'Untitled chat')}</span>
        {recent && <span class="proj">{p.name}</span>}
        {source && !recent && <span class="src">{source.replace(/ Code$/, '') === 'VS' ? 'VS Code' : source.replace(/ Code$/, '')}</span>}
        <span class="meta hide-on-hover">{ago(it.updatedAt)}</span>
        <span class="tools">
          <button class="icon-btn sm" onClick={(e) => chatMenu(p.id, it, e)} aria-label={t('بیشتر', 'More')}>
            <Icon name="more" size={14} />
          </button>
        </span>
      </div>
    );
  };

  const projectBlock = (p: ProjectInfo) => {
    const open = expanded[p.id] ?? true;
    const all = (lists[p.id] ?? []).filter((it) => !needle || it.title.toLowerCase().includes(needle));
    if (needle && !all.length && !p.name.toLowerCase().includes(needle)) return null;
    const items = showAll[p.id] || needle ? all : all.slice(0, PREVIEW_COUNT);
    return (
      <div key={p.id}>
        <div
          class={`row${menu?.key === `p:${p.id}` ? ' menu-open' : ''}`}
          role="button"
          tabIndex={0}
          title={p.root}
          onClick={() => toggleProject(p.id)}
          onKeyDown={(e) => e.key === 'Enter' && toggleProject(p.id)}
          onContextMenu={(e) => projectMenu(p, e)}
        >
          <span class="ic">
            <Icon name={open ? 'folderOpen' : 'folder'} />
          </span>
          <span class="grow" style={{ fontWeight: 500 }}>{p.name}</span>
          {p.missing && <span class="badge">{t('پیدا نشد', 'missing')}</span>}
          {!p.trusted && !p.missing && (
            <span class="ic" title={t('هنوز مورد اعتماد نیست', 'Not trusted yet')}>
              <Icon name="shield" size={13} />
            </span>
          )}
          <span class="tools">
            <button class="icon-btn sm" onClick={(e) => (e.stopPropagation(), newChat(p.id))} title={t('گفت‌وگوی تازه در این پروژه', 'New chat in this project')}>
              <Icon name="newChat" size={14} />
            </button>
            <button class="icon-btn sm" onClick={(e) => projectMenu(p, e)} aria-label={t('بیشتر', 'More')}>
              <Icon name="more" size={14} />
            </button>
          </span>
        </div>
        {(open || needle) && (
          <>
            {items.map((it) => chatRow(p, it))}
            {!all.length && !needle && <div class="empty-note">{t('هنوز گفت‌وگویی نیست', 'No chats yet')}</div>}
            {!needle && all.length > PREVIEW_COUNT && (
              <button class="row more" onClick={() => setShowAll((s) => ({ ...s, [p.id]: !s[p.id] }))}>
                {showAll[p.id] ? t('نمایش کمتر', 'Show less') : t('نمایش همه ({n})', 'Show all ({n})', { n: all.length })}
              </button>
            )}
          </>
        )}
      </div>
    );
  };

  const progressTitles = Object.values(progress);
  const trustProject = activeChat ? project(activeChat.projectId) : undefined;
  const showTrust = !!trustProject && !trustProject.trusted && !trustProject.missing && !trustDismissed[trustProject.id] && !settings;

  return (
    <div class="app">
      <aside class={`side${sideOpen ? '' : ' collapsed'}`}>
        <div class="dragbar" style={sideBar}>
          <span class="spacer" />
          <button class="icon-btn" onClick={toggleSide} title={t('بستن نوار کناری', 'Hide sidebar')}>
            <Icon name="sidebar" />
          </button>
        </div>
        <div class="side-actions">
          <button class="row" onClick={() => newChat()} disabled={busyOpen}>
            <span class="ic">
              <Icon name="newChat" />
            </span>
            <span class="grow">{t('گفت‌وگوی تازه', 'New chat')}</span>
          </button>
          {searching ? (
            <div class="search">
              <Icon name="search" />
              <input
                ref={searchRef}
                autoFocus
                value={query}
                placeholder={t('جست‌وجو در گفت‌وگوها', 'Search chats')}
                onInput={(e) => setQuery(e.currentTarget.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') {
                    setQuery('');
                    setSearching(false);
                  }
                }}
              />
              <button
                class="icon-btn sm"
                onClick={() => {
                  setQuery('');
                  setSearching(false);
                }}
              >
                <Icon name="x" size={14} />
              </button>
            </div>
          ) : (
            <button class="row" onClick={() => setSearching(true)}>
              <span class="ic">
                <Icon name="search" />
              </span>
              <span class="grow">{t('جست‌وجو', 'Search')}</span>
            </button>
          )}
        </div>
        <div class="side-scroll">
          <div class="section-head">
            <span class="grow">{t('پروژه‌ها', 'Projects')}</span>
            <button class="icon-btn sm" onClick={() => void addProject()} title={t('افزودن پوشهٔ پروژه', 'Add a project folder')}>
              <Icon name="folderPlus" size={14} />
            </button>
          </div>
          {projects.map(projectBlock)}
          {!projects.length && (
            <button class="row" onClick={() => void addProject()}>
              <span class="ic">
                <Icon name="plus" />
              </span>
              <span class="grow">{t('افزودن پوشهٔ پروژه', 'Add a project folder')}</span>
            </button>
          )}
          {!needle && recents.length > 0 && (
            <>
              <div class="section-head">
                <span class="grow">{t('اخیر', 'Recents')}</span>
              </div>
              {recents.map(({ p, it }) => chatRow(p, it, true))}
            </>
          )}
        </div>
        {progressTitles.length > 0 && (
          <div class="progress">
            <span class="spinner" style={{ width: 12, height: 12 }} />
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{progressTitles[progressTitles.length - 1]}</span>
          </div>
        )}
        <div class="side-foot">
          <button class="account" onClick={() => (account.signedIn ? setSettings({ query: 'account' }) : signIn('browser'))}>
            <span class="avatar">
              <Mark size={15} />
            </span>
            <span class="lines">
              <span>{account.signedIn ? account.projectName ?? t('حساب گیسو', 'Gisoo account') : t('ورود به گیسو', 'Sign in to Gisoo')}</span>
              <span class="sub">{account.signedIn ? account.balance ?? '' : account.signInWaiting ? t('منتظر تأیید در مرورگر…', 'Waiting for the browser…') : t('با حساب گیسو', 'with your Gisoo account')}</span>
            </span>
          </button>
          {tasks.length > 0 && (
            <button class="icon-btn" onClick={() => setTasksOpen((o) => !o)} title={t('خروجی فرمان‌ها', 'Command output')}>
              <Icon name="terminal" />
            </button>
          )}
          <button class="icon-btn" onClick={() => setSettings({})} title={t('تنظیمات', 'Settings')}>
            <Icon name="settings" />
          </button>
        </div>
      </aside>

      <main class="main">
        {!sideOpen && (
          <button class="icon-btn floating-toggle" style={{ [app.lang === 'en' ? 'left' : 'right']: 10 + (CONTROLS.side === (app.lang === 'en' ? 'left' : 'right') ? CONTROLS.px : 0), insetInlineStart: 'auto' } as any} onClick={toggleSide} title={t('نمایش نوار کناری', 'Show sidebar')}>
            <Icon name="sidebar" />
          </button>
        )}

        <div class="frames">
          {chats.map((c) => (
            <iframe
              key={c.chatId}
              class={c.chatId === active && !settings ? 'on' : ''}
              title={c.title ?? t('گفت‌وگو', 'Chat')}
              src={`../chat/chat.html?chat=${encodeURIComponent(c.chatId)}&lang=${app.lang}`}
              allow="clipboard-write; microphone"
              ref={(el) => {
                if (el && !frames.current.has(c.chatId)) {
                  frames.current.set(c.chatId, el);
                  if (!c.ready && !pending.current.has(c.chatId)) pending.current.set(c.chatId, []);
                }
              }}
              onLoad={(e) => e.currentTarget.contentWindow?.postMessage({ gisooReserve: reserve }, location.origin)}
            />
          ))}
        </div>

        {!activeChat && !settings && (
          <>
            <div class="dragbar" style={mainBar}>
              <span class="spacer" />
            </div>
            <Home
              account={account}
              projects={projects}
              focus={focusProject}
              busy={busyOpen}
              onSignIn={signIn}
              onAdd={() => void addProject()}
              onNew={(id) => newChat(id)}
            />
          </>
        )}

        {showTrust && trustProject && (
          <div class="trust">
            <span class="ic">
              <Icon name="shield" size={18} />
            </span>
            <p>
              {t('به پوشهٔ «', 'Do you trust ')}
              <b>{trustProject.name}</b>
              {t(
                '» اعتماد دارید؟ تا وقتی اعتماد نکنید، گیسو دستورها و راهنماهای خود پروژه را نمی‌خواند و پیش از هر ویرایش فایل اجازه می‌گیرد.',
                '? Until you do, Gisoo does not read the project’s own commands and instructions, and asks before every file edit.',
              )}
            </p>
            <button class="btn ghost" onClick={() => setTrustDismissed((d) => ({ ...d, [trustProject.id]: true }))}>{t('بعداً', 'Later')}</button>
            <button class="btn primary" onClick={() => void bridge.invoke('projects:trust', trustProject.id, true)}>{t('اعتماد دارم', 'Trust')}</button>
          </div>
        )}

        {tasksOpen && tasks.length > 0 && !settings && <TaskDrawer tasks={tasks} onClose={() => setTasksOpen(false)} />}

        {settings && <SettingsPage query={settings.query} project={focusProject} account={account} onClose={() => setSettings(null)} onSignIn={signIn} barStyle={mainBar} />}
      </main>

      {overlay?.kind === 'document' && <DocumentView doc={overlay.doc} onClose={() => setOverlay(null)} />}
      {overlay?.kind === 'diff' && <DiffView diff={overlay.diff} onClose={() => setOverlay(null)} />}
      {asks[0] && <AskView key={asks[0].id} ask={asks[0]} />}
      {menu && <Menu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
      <Toasts toasts={toasts} dismiss={dismissToast} />
    </div>
  );
}

function Home(props: {
  account: AccountView;
  projects: ProjectInfo[];
  focus?: ProjectInfo;
  busy: boolean;
  onSignIn: (kind: 'browser' | 'key' | 'code') => void;
  onAdd: () => void;
  onNew: (projectId: string) => void;
}) {
  const { account, projects, focus } = props;
  if (!account.signedIn) {
    return (
      <div class="screen">
        <span class="mark">
          <Mark size={52} />
        </span>
        <h1>{t('به گیسو خوش آمدید', 'Welcome to Gisoo')}</h1>
        <p>
          {t(
            'دستیار برنامه‌نویسی گیسو روی پوشه‌های پروژهٔ خودتان کار می‌کند: کد می‌خواند، تغییر می‌دهد، فرمان اجرا می‌کند و گفت‌وگوهای هر پروژه را جدا نگه می‌دارد.',
            'Gisoo’s coding agent works on your own project folders: it reads and changes code, runs commands, and keeps every project’s chats apart.',
          )}
        </p>
        {account.signInWaiting ? (
          <>
            <div class="actions" style={{ alignItems: 'center', color: 'var(--g-muted)' }}>
              <span class="spinner" />
              {t('ورود را در مرورگر تأیید کنید…', 'Confirm the sign-in in your browser…')}
            </div>
            <div class="actions">
              {account.signInUrl && (
                <button class="btn" onClick={() => void bridge.invoke('link:open', account.signInUrl)}>
                  <Icon name="globe" />
                  {t('باز کردن دوبارهٔ مرورگر', 'Open the browser again')}
                </button>
              )}
              <button class="btn" onClick={() => props.onSignIn('code')}>
                <Icon name="hash" />
                {t('وارد کردن کد', 'Enter the code')}
              </button>
              <button class="btn ghost" onClick={() => void bridge.invoke('account:cancelSignIn')}>{t('انصراف', 'Cancel')}</button>
            </div>
          </>
        ) : (
          <div class="actions">
            <button class="btn primary" onClick={() => props.onSignIn('browser')}>
              <Icon name="globe" />
              {t('ورود با حساب گیسو', 'Sign in with Gisoo')}
            </button>
            <button class="btn" onClick={() => props.onSignIn('key')}>
              <Icon name="key" />
              {t('ورود با کلید API', 'Use an API key')}
            </button>
          </div>
        )}
        {account.error && <p style={{ color: 'var(--g-bad)' }}>{account.error}</p>}
        <p style={{ fontSize: 12.5, color: 'var(--g-faint)' }}>
          {t('حساب ندارید؟ ', 'No account? ')}
          <a href="#" style={{ color: 'var(--g-link)' }} onClick={(e) => (e.preventDefault(), void bridge.invoke('link:open', 'https://gisoo.pro/login'))}>
            {t('در gisoo.pro بسازید', 'Create one at gisoo.pro')}
          </a>
        </p>
      </div>
    );
  }
  if (!projects.length) {
    return (
      <div class="screen">
        <span class="mark">
          <Mark size={52} />
        </span>
        <h1>{t('اولین پروژه را اضافه کنید', 'Add your first project')}</h1>
        <p>{t('یک پوشه را انتخاب کنید. دستورها، تنظیم‌ها و گفت‌وگوهای هر پروژه در مسیر خود همان پروژه می‌ماند.', 'Pick a folder. Each project’s commands, settings and chats stay with that project.')}</p>
        <div class="actions">
          <button class="btn primary" onClick={props.onAdd}>
            <Icon name="folderPlus" />
            {t('انتخاب پوشه', 'Choose a folder')}
          </button>
        </div>
      </div>
    );
  }
  return (
    <div class="screen">
      <span class="mark">
        <Mark size={44} />
      </span>
      <h1>{focus ? t('روی چه کاری در «{p}» کار کنیم؟', 'What should we work on in {p}?', { p: focus.name }) : t('روی چه کاری کار کنیم؟', 'What should we work on?')}</h1>
      <div class="actions">
        {focus && (
          <button class="btn primary" disabled={props.busy} onClick={() => props.onNew(focus.id)}>
            {props.busy ? <span class="spinner" /> : <Icon name="newChat" />}
            {t('گفت‌وگوی تازه', 'New chat')}
          </button>
        )}
      </div>
      {projects.length > 1 && (
        <div class="cards">
          {projects.slice(0, 6).map((p) => (
            <button key={p.id} class="card" onClick={() => props.onNew(p.id)}>
              <b style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <Icon name="folder" />
                {p.name}
              </b>
              <span class="ltr" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.root}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

render(<App />, document.getElementById('app')!);
