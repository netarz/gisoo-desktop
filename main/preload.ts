/**
 * The shell window's only door to the main process. Channels are listed; nothing else passes.
 */
import { contextBridge, ipcRenderer } from 'electron';

const INVOKE = new Set([
  'app:state',
  'projects:add',
  'projects:remove',
  'projects:trust',
  'projects:reveal',
  'chats:list',
  'chats:delete',
  'chats:rename',
  'chat:open',
  'chat:close',
  'chat:post',
  'host:reply',
  'settings:get',
  'settings:set',
  'account:signIn',
  'account:cancelSignIn',
  'account:signOut',
  'account:refresh',
  'link:open',
  'window:control',
  'mcp:list',
  'mcp:set',
  'mcp:approve',
  'mcp:reconnect',
]);

const EVENTS = new Set(['chat:msg', 'chat:meta', 'host:request', 'host:notice', 'sidebar:changed', 'state:changed', 'chat:openRequest', 'mcp:changed']);

contextBridge.exposeInMainWorld('gisoo', {
  platform: process.platform,
  invoke: (channel: string, ...args: unknown[]) => {
    if (!INVOKE.has(channel)) return Promise.reject(new Error(`blocked channel ${channel}`));
    return ipcRenderer.invoke(channel, ...args);
  },
  on: (channel: string, listener: (...args: unknown[]) => void) => {
    if (!EVENTS.has(channel)) return () => undefined;
    const wrapped = (_e: unknown, ...args: unknown[]) => listener(...args);
    ipcRenderer.on(channel, wrapped);
    return () => ipcRenderer.removeListener(channel, wrapped);
  },
});
