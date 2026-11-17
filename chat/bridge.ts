/**
 * Runs before the extension's chat page in each chat iframe. Stands in for VS Code's
 * `acquireVsCodeApi()`: messages go up to the shell window, which relays them to the main process;
 * the page's saved state lives in sessionStorage, one key per chat.
 */
(() => {
  const params = new URLSearchParams(location.search);
  const chatId = params.get('chat') ?? '';
  const lang = params.get('lang') === 'en' ? 'en' : 'fa';
  const theme = params.get('theme');
  document.documentElement.lang = lang;
  document.documentElement.dir = lang === 'fa' ? 'rtl' : 'ltr';
  if (theme === 'dark' || theme === 'light') document.documentElement.dataset.theme = theme;

  // The shell window; this page runs on an origin of its own (app://chat) and talks to it only by message.
  const SHELL = 'app://gisoo';
  const stateKey = `gisoo-chat:${chatId}`;
  const api = {
    postMessage(message: unknown): void {
      window.parent.postMessage({ gisooChat: chatId, msg: message }, SHELL);
    },
    getState(): unknown {
      try {
        const raw = sessionStorage.getItem(stateKey);
        return raw ? JSON.parse(raw) : undefined;
      } catch {
        return undefined;
      }
    },
    setState(state: unknown): unknown {
      try {
        sessionStorage.setItem(stateKey, JSON.stringify(state));
      } catch {
        /* storage full or blocked: the chat still works */
      }
      return state;
    },
  };
  (window as unknown as { acquireVsCodeApi: () => typeof api }).acquireVsCodeApi = () => api;

  // The shell changes the theme without reloading the chat.
  window.addEventListener('message', (event) => {
    if (event.source !== window.parent || event.origin !== SHELL) return;
    const data = event.data as { gisooTheme?: string; gisooReserve?: { left: number; right: number } } | null;
    if (!data) return;
    if (data.gisooTheme === 'dark' || data.gisooTheme === 'light') document.documentElement.dataset.theme = data.gisooTheme;
    else if (data.gisooTheme === 'system') delete document.documentElement.dataset.theme;
    if (data.gisooReserve) {
      // Room for the window controls when this chat touches that edge of the window.
      document.documentElement.style.setProperty('--reserve-left', `${Math.max(0, data.gisooReserve.left | 0)}px`);
      document.documentElement.style.setProperty('--reserve-right', `${Math.max(0, data.gisooReserve.right | 0)}px`);
    }
  });

  // The header is the window's title bar, but a frame cannot mark parts of the window as draggable.
  // Tell the shell where the header is and where its controls are; the shell lays a drag region over
  // the header with holes for the controls.
  type Box = [number, number, number, number];
  const box = (r: DOMRect): Box => [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)];
  const TOP_STRIP = 40;
  let last = '';
  let queued = false;
  const report = (): void => {
    queued = false;
    const header = document.querySelector('.header');
    const rect = header?.getBoundingClientRect();
    const visible = (r: DOMRect): boolean => r.width > 0 && r.height > 0;
    const drag =
      header && rect && visible(rect)
        ? { header: box(rect), holes: [...header.children].map((c) => c.getBoundingClientRect()).filter(visible).map(box) }
        : // Pages without a header (sign-in, errors) still need a title bar: the top strip, around
          // anything clickable that reaches into it.
          {
            header: [0, 0, Math.round(window.innerWidth), TOP_STRIP] as Box,
            holes: [...document.querySelectorAll('button, a, input, select, textarea, [role="button"], [tabindex]')]
              .map((c) => c.getBoundingClientRect())
              .filter((r) => visible(r) && r.top < TOP_STRIP)
              .map(box),
          };
    const key = JSON.stringify(drag);
    if (key === last) return;
    last = key;
    window.parent.postMessage({ gisooChat: chatId, gisooDrag: drag }, SHELL);
  };
  const schedule = (): void => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(report);
  };
  const start = (): void => {
    new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true, attributes: true, characterData: true });
    window.addEventListener('resize', schedule);
    schedule();
  };
  if (document.body) start();
  else document.addEventListener('DOMContentLoaded', start, { once: true });
})();
