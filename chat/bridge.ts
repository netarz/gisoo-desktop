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

  const stateKey = `gisoo-chat:${chatId}`;
  const api = {
    postMessage(message: unknown): void {
      window.parent.postMessage({ gisooChat: chatId, msg: message }, location.origin);
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
    if (event.source !== window.parent || event.origin !== location.origin) return;
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
})();
