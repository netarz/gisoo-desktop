/**
 * MCP servers for the desktop app: the same servers Claude Code, Codex and the owner's own Gisoo config
 * declare, connected per project and offered to the agent as tools named `mcp__<server>__<tool>`.
 *
 * Where servers come from (first one with a name wins):
 *   project  `.gisoo/mcp.json`, `.mcp.json` (Claude Code), `.codex/config.toml` (Codex)
 *   user     `~/.gisoo/mcp.json`, `~/.claude.json` (this folder's entry, then the global list),
 *            `~/.codex/config.toml`
 *   AStack   a project with `astack.config.yaml` gets its shared brain (memory, context, graph,
 *            handoffs, journal, skills) even when no file declares it.
 *
 * Trust: nothing connects in a folder the owner has not trusted. A server a project file declares runs
 * code from that project, so it also waits for the owner's own yes, asked once per server and remembered
 * against the server's exact command; a changed command asks again. Servers from the owner's home folder
 * connect on their own. Any server can be switched off on the settings page.
 */
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
// smol-toml ships as an ES module only; esbuild bundles it, tsc just needs to be told its shape.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { parse: parseToml } = require('smol-toml') as { parse(text: string): Record<string, unknown> };
import * as tools from '../src/tools';
import type { Tool, ToolResult } from '../src/tools/types';
import { truncateResult } from '../src/tools/types';
import { currentProject } from '../shim/scope';

import type { McpServerView, McpSource, McpStatus } from './api';

export interface McpServerConfig {
  name: string;
  source: McpSource;
  transport: 'stdio' | 'http' | 'sse';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  /** Switched off in its own file (Codex `enabled = false`, Claude `disabled: true`). */
  off?: boolean;
}

interface Remote {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; title?: string };
}

interface Connection {
  config: McpServerConfig;
  hash: string;
  client?: Client;
  status: McpStatus;
  error?: string;
  /** Agent-facing name → the server's own tool. */
  tools: Map<string, Remote>;
  stderr: string;
  /** The server's own usage notes (MCP `instructions`), shown to the model with its first tool. */
  instructions?: string;
}

/** read: runs freely, plan mode too · write: runs freely, not in plan mode · normal: approval card · ask: always asked. */
type ToolClass = 'read' | 'write' | 'normal' | 'ask';

interface Saved {
  /** projectId → server name → config hash the owner said yes to. */
  approved: Record<string, Record<string, string>>;
  /** projectId → server name → config hash the owner said no to (so we do not ask at every chat). */
  denied: Record<string, Record<string, string>>;
  /** projectId → names switched off on the settings page. */
  off: Record<string, string[]>;
}

const CALL_TIMEOUT_MS = 10 * 60_000;
const CONNECT_TIMEOUT_MS = 60_000;

/**
 * AStack is the project's own shared brain, so its tools run without a card, like the built-in memory
 * tool. These leave the machine or hand work to another runtime, so each call is asked.
 */
const ASTACK_ASK = new Set(['astack_delegate', 'astack_skill_online_get', 'astack_skill_online_search', 'astack_skill_online_show']);
/** AStack tools that write (memory, blocks, handoffs, titles): not offered in plan mode. */
const ASTACK_WRITES = new Set([
  'astack_memory_remember',
  'astack_memory_supersede',
  'astack_memory_block',
  'astack_memory_reflect',
  'astack_handoff_write',
  'astack_session_title',
]);

export interface McpHubOptions {
  userData: string;
  /** The root of a project the hub may serve; undefined for unknown or untrusted ids. */
  project(projectId: string): { root: string; trusted: boolean } | undefined;
  /** Asks the owner (native dialog). Resolves true for yes. */
  confirm(text: { title: string; detail: string; yes: string; no: string }): Promise<boolean>;
  lang(): 'fa' | 'en';
  version: string;
  onChange(projectId: string): void;
}

export class McpHub {
  private readonly conns = new Map<string, Map<string, Connection>>();
  private readonly registered = new Map<string, { cls: ToolClass; unregister: () => void }>();
  private readonly asking = new Map<string, Promise<boolean>>();
  private readonly file: string;
  private saved: Saved;

  constructor(private readonly opts: McpHubOptions) {
    this.file = path.join(opts.userData, 'mcp.json');
    this.saved = readJson<Saved>(this.file) ?? { approved: {}, denied: {}, off: {} };
    this.saved.approved ??= {};
    this.saved.denied ??= {};
    this.saved.off ??= {};
  }

  /** Every server this project can see, with its state. */
  list(projectId: string): McpServerView[] {
    const p = this.opts.project(projectId);
    if (!p) return [];
    const live = this.conns.get(projectId);
    return discover(p.root).map((config) => {
      const hash = hashConfig(config);
      const conn = live?.get(config.name);
      const status: McpStatus = !p.trusted
        ? 'off'
        : this.isOff(projectId, config)
          ? 'off'
          : conn && conn.hash === hash
            ? conn.status
            : this.needsApproval(projectId, config, hash)
              ? this.saved.denied[projectId]?.[config.name] === hash
                ? 'denied'
                : 'needsApproval'
              : 'idle';
      return {
        name: config.name,
        source: config.source,
        transport: config.transport,
        target: config.transport === 'stdio' ? [config.command, ...(config.args ?? [])].join(' ').slice(0, 240) : redactUrl(config.url ?? ''),
        status,
        tools: conn?.status === 'connected' ? conn.tools.size : 0,
        error: conn?.status === 'failed' ? conn.error : undefined,
        projectLevel: isProjectLevel(config),
      };
    });
  }

  /** Connects what this project may use; called when a chat opens. Never throws. */
  async ensure(projectId: string, askNow = true): Promise<void> {
    const p = this.opts.project(projectId);
    if (!p || !p.trusted) return this.closeProject(projectId);
    const configs = discover(p.root);
    const live = this.conns.get(projectId) ?? new Map<string, Connection>();
    this.conns.set(projectId, live);

    // Servers that disappeared, changed or were switched off go first.
    for (const [name, conn] of [...live]) {
      const now = configs.find((c) => c.name === name);
      if (!now || hashConfig(now) !== conn.hash || this.isOff(projectId, now)) {
        live.delete(name);
        void conn.client?.close().catch(() => undefined);
      }
    }
    this.syncTools();

    await Promise.all(
      configs.map(async (config) => {
        if (this.isOff(projectId, config) || live.has(config.name)) return;
        const hash = hashConfig(config);
        if (this.needsApproval(projectId, config, hash)) {
          if (!askNow || this.saved.denied[projectId]?.[config.name] === hash) return;
          if (!(await this.ask(projectId, config, hash))) return;
        }
        await this.connect(projectId, config, hash);
      }),
    );
  }

  /** The owner's yes from the settings page (or no, with `approve = false`). */
  async approve(projectId: string, name: string, approve: boolean): Promise<void> {
    const p = this.opts.project(projectId);
    const config = p ? discover(p.root).find((c) => c.name === name) : undefined;
    if (!p || !config) return;
    const hash = hashConfig(config);
    this.remember(projectId, name, hash, approve);
    if (approve) {
      this.setOffFlag(projectId, name, false);
      await this.ensure(projectId, false);
    } else {
      this.drop(projectId, name);
    }
    this.opts.onChange(projectId);
  }

  async setEnabled(projectId: string, name: string, enabled: boolean): Promise<void> {
    this.setOffFlag(projectId, name, !enabled);
    if (enabled) await this.ensure(projectId, true);
    else this.drop(projectId, name);
    this.opts.onChange(projectId);
  }

  /** Reconnect one server (after a failure) or all of a project's. */
  async reconnect(projectId: string, name?: string): Promise<void> {
    const live = this.conns.get(projectId);
    if (live) for (const [n, c] of [...live]) if (!name || n === name) {
      live.delete(n);
      void c.client?.close().catch(() => undefined);
    }
    this.syncTools();
    await this.ensure(projectId, true);
  }

  closeProject(projectId: string): void {
    const live = this.conns.get(projectId);
    if (!live) return;
    this.conns.delete(projectId);
    for (const c of live.values()) void c.client?.close().catch(() => undefined);
    this.syncTools();
  }

  dispose(): void {
    for (const id of [...this.conns.keys()]) this.closeProject(id);
    for (const r of this.registered.values()) r.unregister();
    this.registered.clear();
  }

  // ---------------------------------------------------------------------------------------------

  private isOff(projectId: string, config: McpServerConfig): boolean {
    return !!config.off || (this.saved.off[projectId] ?? []).includes(config.name);
  }

  private needsApproval(projectId: string, config: McpServerConfig, hash: string): boolean {
    return isProjectLevel(config) && this.saved.approved[projectId]?.[config.name] !== hash;
  }

  private ask(projectId: string, config: McpServerConfig, hash: string): Promise<boolean> {
    const key = `${projectId}\0${config.name}\0${hash}`;
    const running = this.asking.get(key);
    if (running) return running;
    const fa = this.opts.lang() === 'fa';
    const what = config.transport === 'stdio' ? [config.command, ...(config.args ?? [])].join(' ') : redactUrl(config.url ?? '');
    const astack = isAStack(config);
    const file = { 'project:gisoo': '.gisoo/mcp.json', 'project:claude': '.mcp.json', 'project:codex': '.codex/config.toml' }[config.source as string] ?? '';
    const asked = this.opts
      .confirm({
        title: fa ? `سرور MCP «${config.name}» وصل شود؟` : `Connect the MCP server "${config.name}"?`,
        detail: [
          astack
            ? fa
              ? 'این پروژه AStack دارد. با وصل شدنش، گیسو به حافظهٔ مشترک، نقشهٔ کد، ژورنال و تحویل کار همین پروژه دسترسی پیدا می‌کند؛ همان چیزی که Claude Code و Codex هم می‌بینند.'
              : 'This project uses AStack. Connected, Gisoo shares its memory, code graph, journal and handoffs with Claude Code and Codex.'
            : fa
              ? `پروندهٔ ${file} در این پروژه این سرور را تعریف کرده است. وصل شدن یعنی این برنامه روی رایانهٔ شما اجرا شود:`
              : `${file} in this project declares this server. Connecting runs this on your computer:`,
          '',
          what.slice(0, 400),
          '',
          fa ? 'فقط اگر این پروژه را می‌شناسید و به آن اعتماد دارید وصل کنید. پاسخ شما برای همین فرمان به خاطر می‌ماند.' : 'Connect only if you know and trust this project. Your answer is remembered for this exact command.',
        ].join('\n'),
        yes: fa ? 'وصل کن' : 'Connect',
        no: fa ? 'نه' : 'No',
      })
      .then((yes) => {
        this.remember(projectId, config.name, hash, yes);
        this.opts.onChange(projectId);
        return yes;
      })
      .catch(() => false)
      .finally(() => this.asking.delete(key));
    this.asking.set(key, asked);
    return asked;
  }

  private remember(projectId: string, name: string, hash: string, yes: boolean): void {
    const set = (bag: Record<string, Record<string, string>>, on: boolean) => {
      const m = (bag[projectId] ??= {});
      if (on) m[name] = hash;
      else delete m[name];
    };
    set(this.saved.approved, yes);
    set(this.saved.denied, !yes);
    this.save();
  }

  private setOffFlag(projectId: string, name: string, off: boolean): void {
    const list = new Set(this.saved.off[projectId] ?? []);
    if (off) list.add(name);
    else list.delete(name);
    this.saved.off[projectId] = [...list];
    this.save();
  }

  private save(): void {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.saved, null, 2), { encoding: 'utf8', mode: 0o600 });
    } catch {
      /* the choice holds for this run */
    }
  }

  private drop(projectId: string, name: string): void {
    const live = this.conns.get(projectId);
    const c = live?.get(name);
    if (!c) return;
    live!.delete(name);
    void c.client?.close().catch(() => undefined);
    this.syncTools();
  }

  private async connect(projectId: string, config: McpServerConfig, hash: string): Promise<void> {
    const live = this.conns.get(projectId);
    if (!live) return;
    const conn: Connection = { config, hash, status: 'connecting', tools: new Map(), stderr: '' };
    live.set(config.name, conn);
    this.opts.onChange(projectId);
    try {
      const client = new Client({ name: 'gisoo-desktop', version: this.opts.version }, { capabilities: {} });
      conn.client = client;
      const transport = this.transport(config, conn);
      await withTimeout(client.connect(transport), CONNECT_TIMEOUT_MS, 'connect');
      if (live.get(config.name) !== conn) return void client.close().catch(() => undefined);
      const notes = client.getInstructions();
      conn.instructions = typeof notes === 'string' && notes.trim() ? notes.trim().slice(0, 2000) : undefined;
      await this.loadTools(conn);
      if (client.getServerCapabilities()?.tools?.listChanged) {
        client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
          await this.loadTools(conn).catch(() => undefined);
          this.syncTools();
          this.opts.onChange(projectId);
        });
      }
      client.onclose = () => {
        if (live.get(config.name) !== conn || conn.status === 'failed') return;
        conn.status = 'failed';
        conn.error = lastLine(conn.stderr) || 'closed';
        conn.tools.clear();
        this.syncTools();
        this.opts.onChange(projectId);
      };
      conn.status = 'connected';
    } catch (error) {
      conn.status = 'failed';
      conn.error = `${error instanceof Error ? error.message : String(error)}${conn.stderr ? ` — ${lastLine(conn.stderr)}` : ''}`.slice(0, 400);
      conn.tools.clear();
      void conn.client?.close().catch(() => undefined);
    }
    this.syncTools();
    this.opts.onChange(projectId);
  }

  private transport(config: McpServerConfig, conn: Connection): Transport {
    if (config.transport === 'stdio') {
      const env: Record<string, string> = {};
      for (const [k, v] of Object.entries(process.env)) {
        if (v !== undefined && !/^ELECTRON_|^GISOO_SNAPSHOT|^GISOO_USER_DATA|^GISOO_DEVTOOLS/.test(k)) env[k] = v;
      }
      Object.assign(env, config.env ?? {});
      const t = new StdioClientTransport({ command: config.command!, args: config.args ?? [], env, cwd: config.cwd, stderr: 'pipe' });
      t.stderr?.on('data', (chunk: Buffer) => {
        conn.stderr = (conn.stderr + chunk.toString('utf8')).slice(-4000);
      });
      return t;
    }
    const url = new URL(config.url!);
    const requestInit = config.headers && Object.keys(config.headers).length ? { headers: config.headers } : undefined;
    return config.transport === 'sse' ? new SSEClientTransport(url, { requestInit }) : new StreamableHTTPClientTransport(url, { requestInit });
  }

  private async loadTools(conn: Connection): Promise<void> {
    const client = conn.client!;
    const found: Remote[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 20; page++) {
      const res = await withTimeout(client.listTools(cursor ? { cursor } : {}), CONNECT_TIMEOUT_MS, 'tools/list');
      found.push(...(res.tools as unknown as Remote[]));
      cursor = res.nextCursor;
      if (!cursor) break;
    }
    conn.tools.clear();
    for (const t of found) {
      if (!t || typeof t.name !== 'string') continue;
      const name = agentName(conn.config.name, t.name);
      if (!conn.tools.has(name)) conn.tools.set(name, t);
    }
  }

  /** One registry entry per agent-facing name, as strict as the strictest project that offers it. */
  private syncTools(): void {
    const want = new Map<string, ToolClass>();
    for (const live of this.conns.values()) {
      for (const conn of live.values()) {
        if (conn.status !== 'connected' && conn.status !== 'connecting') continue;
        for (const [name, t] of conn.tools) {
          const cls = classify(conn.config, t);
          const had = want.get(name);
          want.set(name, had ? stricter(had, cls) : cls);
        }
      }
    }
    for (const [name, reg] of [...this.registered]) {
      if (want.get(name) !== reg.cls) {
        reg.unregister();
        this.registered.delete(name);
      }
    }
    for (const [name, cls] of want) {
      if (this.registered.has(name)) continue;
      const tool = this.dispatcher(name, cls);
      const unregister = tools.registerTool(tool, {
        readOnly: cls === 'read',
        needsApproval: cls === 'ask',
        available: () => !!this.current(name),
      });
      this.registered.set(name, { cls, unregister });
    }
  }

  /** The current chat's project connection that offers this tool. */
  private current(name: string): { conn: Connection; remote: Remote } | undefined {
    const p = currentProject();
    if (!p || !p.trusted) return undefined;
    for (const conn of this.conns.get(p.id)?.values() ?? []) {
      if (conn.status !== 'connected') continue;
      const remote = conn.tools.get(name);
      if (remote) return { conn, remote };
    }
    return undefined;
  }

  private dispatcher(name: string, cls: ToolClass): Tool {
    const hub = this;
    return {
      name,
      // The definition the model sees comes from the server of the chat's own project.
      get description(): string {
        const c = hub.current(name);
        const d = c?.remote.description?.trim() || c?.remote.annotations?.title || name;
        if (!c) return d.slice(0, 2000);
        // The server's own usage notes travel once, with its first tool, as Claude Code shows them.
        const first = c.conn.tools.keys().next().value === name && c.conn.instructions;
        return `${d.slice(0, 2000)}\n(MCP server: ${c.conn.config.name})${first ? `\n\nAbout the ${c.conn.config.name} server: ${c.conn.instructions}` : ''}`;
      },
      get parameters(): Record<string, unknown> {
        const schema = hub.current(name)?.remote.inputSchema;
        return schema && typeof schema === 'object' ? schema : { type: 'object', properties: {} };
      },
      permission: cls === 'normal' ? 'edit' : 'read',
      readOnly: cls === 'read',
      title(input: Record<string, unknown>): string {
        const c = hub.current(name);
        const label = c ? `${c.conn.config.name} › ${c.remote.annotations?.title || c.remote.name}` : name;
        const brief = summarize(input);
        return brief ? `${label}: ${brief}` : label;
      },
      async run(input, ctx): Promise<ToolResult> {
        const c = hub.current(name);
        if (!c || !c.conn.client) return { content: `The MCP tool ${name} is not connected in this project.`, isError: true };
        try {
          const res = await c.conn.client.callTool({ name: c.remote.name, arguments: input ?? {} }, undefined, {
            signal: ctx.signal,
            timeout: CALL_TIMEOUT_MS,
            resetTimeoutOnProgress: true,
            onprogress: (p) => ctx.onProgress?.(p.message ?? `${p.progress}${p.total ? `/${p.total}` : ''}`),
          });
          return { content: truncateResult(resultText(res)), isError: res.isError === true };
        } catch (error) {
          return { content: `MCP error (${c.conn.config.name}): ${error instanceof Error ? error.message : String(error)}`, isError: true };
        }
      },
    };
  }
}

// -------------------------------------------------------------------------------------------------
// Discovery
// -------------------------------------------------------------------------------------------------

export function discover(root: string): McpServerConfig[] {
  const home = os.homedir();
  const out: McpServerConfig[] = [];
  const seen = new Set<string>();
  const add = (list: McpServerConfig[]) => {
    for (const c of list) {
      if (!c.name || seen.has(c.name)) continue;
      seen.add(c.name);
      out.push(c);
    }
  };

  add(fromJson(path.join(root, '.gisoo', 'mcp.json'), 'project:gisoo', root));
  add(fromJson(path.join(root, '.mcp.json'), 'project:claude', root));
  add(fromToml(path.join(root, '.codex', 'config.toml'), 'project:codex', root));
  add(fromJson(path.join(home, '.gisoo', 'mcp.json'), 'user:gisoo', root));
  const claude = readJson<{ mcpServers?: unknown; projects?: Record<string, { mcpServers?: unknown }> }>(path.join(home, '.claude.json'));
  if (claude) {
    const mine = Object.entries(claude.projects ?? {}).find(([k]) => samePath(k, root))?.[1];
    add(parseServers(mine?.mcpServers, 'user:claude-local', root));
    add(parseServers(claude.mcpServers, 'user:claude', root));
  }
  add(fromToml(path.join(home, '.codex', 'config.toml'), 'user:codex', root));

  // AStack's shared brain, when the project uses AStack and nothing above declared it.
  if (!out.some(isAStack) && fs.existsSync(path.join(root, 'astack.config.yaml'))) {
    const local = path.join(root, 'bin', 'astack.mjs');
    const core = path.join(home, '.astack', 'core', 'bin', 'astack.mjs');
    if (fs.existsSync(local)) add([{ name: 'astack', source: 'project:claude', transport: 'stdio', command: 'node', args: ['bin/astack.mjs', 'mcp', 'serve'], cwd: root }]);
    else if (fs.existsSync(core)) add([{ name: 'astack', source: 'astack', transport: 'stdio', command: 'node', args: [core, 'mcp', 'serve'], cwd: root }]);
  }
  return out;
}

function fromJson(file: string, source: McpSource, root: string): McpServerConfig[] {
  const j = readJson<{ mcpServers?: unknown; servers?: unknown }>(file);
  return j ? parseServers(j.mcpServers ?? j.servers, source, root) : [];
}

function fromToml(file: string, source: McpSource, root: string): McpServerConfig[] {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  try {
    const t = parseToml(text) as { mcp_servers?: Record<string, Record<string, unknown>> };
    const out: McpServerConfig[] = [];
    for (const [name, s] of Object.entries(t.mcp_servers ?? {})) {
      if (!s || typeof s !== 'object') continue;
      const headers: Record<string, string> = { ...strMap(s.http_headers) };
      const bearerVar = typeof s.bearer_token_env_var === 'string' ? s.bearer_token_env_var : undefined;
      if (bearerVar && process.env[bearerVar]) headers.Authorization = `Bearer ${process.env[bearerVar]}`;
      for (const [h, v] of Object.entries(strMap(s.env_http_headers))) if (process.env[v]) headers[h] = process.env[v]!;
      const c = normalize(
        name,
        source,
        {
          command: s.command,
          args: s.args,
          env: s.env,
          cwd: s.cwd,
          url: s.url,
          headers,
          disabled: s.enabled === false,
        },
        root,
      );
      if (c) out.push(c);
    }
    return out;
  } catch {
    return [];
  }
}

function parseServers(raw: unknown, source: McpSource, root: string): McpServerConfig[] {
  if (!raw || typeof raw !== 'object') return [];
  const out: McpServerConfig[] = [];
  for (const [name, s] of Object.entries(raw as Record<string, unknown>)) {
    const c = normalize(name, source, s as Record<string, unknown>, root);
    if (c) out.push(c);
  }
  return out;
}

function normalize(name: string, source: McpSource, s: Record<string, unknown> | undefined, root: string): McpServerConfig | undefined {
  if (!s || typeof s !== 'object' || !/^[\w.-]{1,64}$/.test(name)) return undefined;
  const type = typeof s.type === 'string' ? s.type.toLowerCase() : undefined;
  const off = s.disabled === true || s.enabled === false;
  if (typeof s.url === 'string' && s.url) {
    const url = expand(s.url);
    if (!/^https?:\/\//i.test(url)) return undefined;
    return { name, source, transport: type === 'sse' ? 'sse' : 'http', url, headers: expandMap(strMap(s.headers)), off };
  }
  if (typeof s.command !== 'string' || !s.command.trim()) return undefined;
  const args = Array.isArray(s.args) ? s.args.filter((a): a is string => typeof a === 'string').map(expand) : [];
  const cwd = typeof s.cwd === 'string' && s.cwd ? path.resolve(root, expand(s.cwd)) : root;
  return { name, source, transport: 'stdio', command: expand(s.command), args, env: expandMap(strMap(s.env)), cwd, off };
}

function strMap(v: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (v && typeof v === 'object') for (const [k, x] of Object.entries(v as Record<string, unknown>)) if (typeof x === 'string') out[k] = x;
  return out;
}

/** `${VAR}` and `${VAR:-default}`, as Claude Code expands them. */
function expand(s: string): string {
  return s.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_m, v: string, d?: string) => process.env[v] ?? d ?? '');
}

function expandMap(m: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(m)) out[k] = expand(v);
  return out;
}

function isProjectLevel(c: McpServerConfig): boolean {
  return c.source.startsWith('project:');
}

function isAStack(c: McpServerConfig): boolean {
  if (c.transport !== 'stdio') return false;
  const args = c.args ?? [];
  return args.some((a) => /(^|[\\/])astack\.mjs$/.test(a)) && args.includes('mcp') && args.includes('serve');
}

function hashConfig(c: McpServerConfig): string {
  const { name, transport, command, args, env, cwd, url } = c;
  // Header and env values count (a changed token is a changed server) but are never stored in clear.
  return createHash('sha256')
    .update(JSON.stringify({ name, transport, command, args, env, cwd, url, headers: c.headers }))
    .digest('hex')
    .slice(0, 32);
}

function samePath(a: string, b: string): boolean {
  const n = (p: string) => path.resolve(p).replace(/[\\/]+$/, '').replace(/\\/g, '/');
  return process.platform === 'win32' || process.platform === 'darwin' ? n(a).toLowerCase() === n(b).toLowerCase() : n(a) === n(b);
}

// -------------------------------------------------------------------------------------------------
// Tools
// -------------------------------------------------------------------------------------------------

/** `mcp__<server>__<tool>`, in the characters and length every model API accepts. */
export function agentName(server: string, tool: string): string {
  const clean = (s: string) => s.replace(/[^A-Za-z0-9_-]/g, '_');
  const full = `mcp__${clean(server)}__${clean(tool)}`;
  if (full.length <= 64) return full;
  const tag = createHash('sha256').update(full).digest('hex').slice(0, 6);
  return `${full.slice(0, 57)}_${tag}`;
}

/**
 * How a call is approved. A server's own annotations are claims, not proof (a REPL tool can call
 * itself read-only), so only AStack's tools run without asking; every other tool goes through the
 * approval card like an edit (asked by default, allowed in the auto-edit and bypass modes), and one the
 * server itself calls destructive is asked every time.
 */
function classify(config: McpServerConfig, t: Remote): ToolClass {
  if (isAStack(config)) return ASTACK_ASK.has(t.name) ? 'ask' : ASTACK_WRITES.has(t.name) ? 'write' : 'read';
  if (t.annotations?.destructiveHint === true) return 'ask';
  return 'normal';
}

function stricter(a: ToolClass, b: ToolClass): ToolClass {
  const rank = { read: 0, write: 1, normal: 2, ask: 3 } as const;
  return rank[a] >= rank[b] ? a : b;
}

function summarize(input: Record<string, unknown> | undefined): string {
  if (!input) return '';
  for (const k of ['query', 'url', 'path', 'name', 'title', 'question', 'command', 'symbol']) {
    const v = input[k];
    if (typeof v === 'string' && v.trim()) return v.trim().slice(0, 80);
  }
  return '';
}

function resultText(res: unknown): string {
  const r = res as { content?: Array<Record<string, unknown>>; structuredContent?: unknown; toolResult?: unknown };
  const parts: string[] = [];
  for (const c of r.content ?? []) {
    if (c.type === 'text' && typeof c.text === 'string') parts.push(c.text);
    else if (c.type === 'image') parts.push(`[image ${String(c.mimeType ?? '')}]`);
    else if (c.type === 'audio') parts.push(`[audio ${String(c.mimeType ?? '')}]`);
    else if (c.type === 'resource_link') parts.push(`[resource ${String(c.uri ?? '')}${c.name ? ` ${String(c.name)}` : ''}]`);
    else if (c.type === 'resource') {
      const res2 = c.resource as { text?: string; uri?: string } | undefined;
      parts.push(res2?.text ?? `[resource ${res2?.uri ?? ''}]`);
    }
  }
  if (!parts.length && r.structuredContent !== undefined) parts.push(JSON.stringify(r.structuredContent, null, 2));
  if (!parts.length && r.toolResult !== undefined) parts.push(typeof r.toolResult === 'string' ? r.toolResult : JSON.stringify(r.toolResult, null, 2));
  return parts.join('\n\n') || '(no output)';
}

// -------------------------------------------------------------------------------------------------

function readJson<T>(file: string): T | undefined {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return undefined;
  }
}

function redactUrl(u: string): string {
  try {
    const url = new URL(u);
    url.username = '';
    url.password = '';
    url.search = url.search ? '?…' : '';
    return url.toString();
  } catch {
    return '';
  }
}

function lastLine(s: string): string {
  return s.trim().split(/\r?\n/).filter(Boolean).pop()?.slice(0, 300) ?? '';
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout;
  return Promise.race([
    p,
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${what} timed out`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}
