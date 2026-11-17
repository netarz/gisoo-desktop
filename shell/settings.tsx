/** The settings page: appearance, the Gisoo account, and every setting of the extension — for all projects or one. */
import { useEffect, useState } from 'preact/hooks';
import type { AccountView, McpServerView, McpSource, ProjectInfo, SettingField } from '../main/api';
import { Links } from '../src/shared/protocol';
import { Icon } from './icons';
import { bridge, save, store, t } from './util';

export type Theme = 'system' | 'dark' | 'light';

export function applyTheme(theme: Theme): void {
  void bridge.invoke('window:control', `theme:${theme}`);
}

export function SettingsPage(props: {
  query?: string;
  project?: ProjectInfo;
  account: AccountView;
  onClose: () => void;
  onSignIn: (kind: 'browser' | 'key' | 'code') => void;
  barStyle: Record<string, string | number>;
}) {
  const { project, account } = props;
  const [scope, setScope] = useState<'user' | 'project'>('user');
  const [fields, setFields] = useState<SettingField[]>([]);
  const [q, setQ] = useState(props.query && props.query !== 'account' ? props.query : '');
  const [theme, setTheme] = useState<Theme>(() => store<Theme>('theme', 'system'));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const projectId = scope === 'project' ? project?.id : undefined;

  const load = () => void bridge.invoke<SettingField[]>('settings:get', projectId).then(setFields);
  useEffect(load, [projectId]);
  useEffect(() => {
    if (!project && scope === 'project') setScope('user');
  }, [project]);

  const set = async (key: string, value: unknown) => {
    try {
      await bridge.invoke('settings:set', key, value, projectId);
      setErrors((e) => ({ ...e, [key]: '' }));
    } catch {
      setErrors((e) => ({ ...e, [key]: t('ذخیره نشد.', 'Not saved.') }));
    }
    load();
  };

  const needle = q.trim().toLowerCase();
  const shown = fields.filter((f) => !needle || `${f.key} ${f.label} ${f.description ?? ''}`.toLowerCase().includes(needle));

  return (
    <div class="settings">
      <div class="dragbar" style={props.barStyle}>
        <button class="btn ghost" onClick={props.onClose}>
          <Icon name="chevronStart" />
          {t('بازگشت', 'Back')}
        </button>
        <span class="spacer" />
      </div>
      <div class="settings-body">
        <div class="settings-inner">
          <h1>{t('تنظیمات', 'Settings')}</h1>

          <h3>{t('حساب گیسو', 'Gisoo account')}</h3>
          <div class="panel">
            {account.signedIn ? (
              <>
                <div class="setting">
                  <span class="avatar">
                    <Icon name="user" />
                  </span>
                  <div class="txt">
                    <b>{account.projectName ?? t('حساب گیسو', 'Gisoo account')}</b>
                    <span>{account.keyName ? t('کلید: {k}', 'Key: {k}', { k: account.keyName }) : t('وارد شده‌اید.', 'Signed in.')}</span>
                  </div>
                  {account.balance && <span class="badge gold">{account.balance}</span>}
                </div>
                <div class="setting">
                  <div class="txt">
                    <b>{t('شارژ و صورت‌حساب', 'Top up and billing')}</b>
                    <span>{t('اعتبار گیسو را در سایت شارژ کنید؛ موجودی اینجا خودکار به‌روز می‌شود.', 'Top up on the website; the balance here updates by itself.')}</span>
                  </div>
                  <button class="btn" onClick={() => void bridge.invoke('link:open', Links.addCredit)}>{t('شارژ اعتبار', 'Top up')}</button>
                  <button class="btn ghost danger" onClick={() => void bridge.invoke('account:signOut')}>
                    <Icon name="logout" />
                    {t('خروج', 'Sign out')}
                  </button>
                </div>
              </>
            ) : (
              <div class="setting">
                <div class="txt">
                  <b>{t('وارد نشده‌اید', 'Not signed in')}</b>
                  <span>{account.error ?? t('برای گفت‌وگو با مدل‌ها با حساب گیسو وارد شوید.', 'Sign in with your Gisoo account to talk to the models.')}</span>
                </div>
                <button class="btn primary" onClick={() => props.onSignIn('browser')}>{t('ورود', 'Sign in')}</button>
              </div>
            )}
          </div>

          <h3>{t('ظاهر', 'Appearance')}</h3>
          <div class="panel">
            <div class="setting">
              <div class="txt">
                <b>{t('پوسته', 'Theme')}</b>
                <span>{t('روشن، تیره یا هم‌رنگ سیستم‌عامل.', 'Light, dark or the same as the system.')}</span>
              </div>
              <div class="seg">
                {(['system', 'light', 'dark'] as Theme[]).map((x) => (
                  <button
                    key={x}
                    class={theme === x ? 'on' : ''}
                    onClick={() => {
                      setTheme(x);
                      save('theme', x);
                      applyTheme(x);
                    }}
                  >
                    {x === 'system' ? t('سیستم', 'System') : x === 'light' ? t('روشن', 'Light') : t('تیره', 'Dark')}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {project && <McpSection project={project} />}

          <h3 style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ flex: 1 }}>{t('گیسو', 'Gisoo')}</span>
            {project && (
              <span class="seg">
                <button class={scope === 'user' ? 'on' : ''} onClick={() => setScope('user')}>{t('همهٔ پروژه‌ها', 'All projects')}</button>
                <button class={scope === 'project' ? 'on' : ''} onClick={() => setScope('project')}>{t('فقط', 'Only')} <bdi>{project.name}</bdi></button>
              </span>
            )}
          </h3>
          {scope === 'project' && project && (
            <p style={{ color: 'var(--g-muted)', fontSize: 12.5, lineHeight: 1.8, margin: '0 0 10px' }}>
              {t('این تنظیم‌ها در خود پوشهٔ پروژه، در فایل ‎.gisoo/settings.json‎ ذخیره می‌شوند و بر تنظیم همهٔ پروژه‌ها مقدم‌اند.', 'These are saved in the project folder, in .gisoo/settings.json, and win over the settings for all projects.')}
            </p>
          )}
          <input class="field" style={{ marginBottom: 10 }} value={q} placeholder={t('جست‌وجو در تنظیمات…', 'Search settings…')} onInput={(e) => setQ(e.currentTarget.value)} />
          <div class="panel">
            {shown.map((f) => (
              <FieldRow key={`${projectId ?? 'u'}:${f.key}`} f={f} projectScope={scope === 'project'} error={errors[f.key]} onSet={(v) => void set(f.key, v)} />
            ))}
            {!shown.length && (
              <div class="setting">
                <div class="txt">
                  <span>{t('تنظیمی با این عبارت نیست.', 'No setting matches.')}</span>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

const SOURCE_LABEL: Record<McpSource, [string, string]> = {
  'project:gisoo': ['پروژه · ‎.gisoo/mcp.json‎', 'Project · .gisoo/mcp.json'],
  'project:claude': ['پروژه · ‎.mcp.json‎', 'Project · .mcp.json'],
  'project:codex': ['پروژه · Codex', 'Project · Codex'],
  'user:gisoo': ['شما · گیسو', 'You · Gisoo'],
  'user:claude-local': ['شما · Claude Code (همین پوشه)', 'You · Claude Code (this folder)'],
  'user:claude': ['شما · Claude Code', 'You · Claude Code'],
  'user:codex': ['شما · Codex', 'You · Codex'],
  astack: ['AStack', 'AStack'],
};

/** The project's MCP servers: where each comes from, whether it is connected, and the owner's switch. */
function McpSection({ project }: { project: ProjectInfo }) {
  const [servers, setServers] = useState<McpServerView[] | undefined>();
  const load = () => void bridge.invoke<McpServerView[]>('mcp:list', project.id).then(setServers).catch(() => setServers([]));
  useEffect(() => {
    load();
    return bridge.on('mcp:changed', (id: string) => {
      if (id === project.id) load();
    });
  }, [project.id]);

  const status = (s: McpServerView): string => {
    switch (s.status) {
      case 'connected':
        return t('وصل · {n} ابزار', 'Connected · {n} tools', { n: s.tools });
      case 'connecting':
        return t('در حال وصل شدن…', 'Connecting…');
      case 'failed':
        return t('وصل نشد', 'Could not connect');
      case 'needsApproval':
        return t('منتظر اجازهٔ شما', 'Waiting for your OK');
      case 'denied':
        return t('اجازه ندادید', 'You said no');
      case 'off':
        return project.trusted ? t('خاموش', 'Off') : t('پوشه مورد اعتماد نیست', 'Folder not trusted');
      default:
        return t('با باز شدن گفت‌وگو وصل می‌شود', 'Connects when a chat opens');
    }
  };

  return (
    <>
      <h3>
        {t('سرورهای MCP پروژهٔ', 'MCP servers of')} <bdi>{project.name}</bdi>
      </h3>
      <p style={{ color: 'var(--g-muted)', fontSize: 12.5, lineHeight: 1.8, margin: '0 0 10px' }}>
        {t(
          'گیسو همان سرورهایی را می‌خواند که Claude Code و Codex برای این پوشه تعریف کرده‌اند. سروری که پروندهٔ خود پروژه تعریف کرده، فقط بعد از اجازهٔ شما اجرا می‌شود.',
          'Gisoo reads the same servers Claude Code and Codex declare for this folder. A server declared by a file inside the project runs only after you allow it.',
        )}
      </p>
      <div class="panel">
        {servers?.map((s) => {
          const enabled = s.status !== 'off' && s.status !== 'denied' && s.status !== 'needsApproval';
          return (
            <div class="setting" key={s.name}>
              <div class="txt">
                <b style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span dir="ltr">{s.name}</span>
                  <span class={`badge${s.status === 'connected' ? ' gold' : ''}`}>{status(s)}</span>
                </b>
                <span>{t(...SOURCE_LABEL[s.source])}</span>
                <span dir="ltr" style={{ fontFamily: 'var(--g-mono, monospace)', fontSize: 11.5, wordBreak: 'break-all', textAlign: t('right', 'left') as 'right' | 'left' }}>
                  {s.target}
                </span>
                {s.error && <span style={{ color: 'var(--g-danger, #d14343)' }} dir="auto">{s.error}</span>}
              </div>
              {project.trusted && (s.status === 'needsApproval' || s.status === 'denied') && (
                <button class="btn" onClick={() => void bridge.invoke('mcp:approve', project.id, s.name, true).then(load)}>
                  {t('اجازه بده', 'Allow')}
                </button>
              )}
              {project.trusted && s.status === 'failed' && (
                <button class="btn ghost" title={t('دوباره', 'Retry')} onClick={() => void bridge.invoke('mcp:reconnect', project.id, s.name).then(load)}>
                  <Icon name="refresh" />
                </button>
              )}
              {project.trusted && s.status !== 'needsApproval' && s.status !== 'denied' && (
                <button
                  class={`switch${enabled ? ' on' : ''}`}
                  role="switch"
                  aria-checked={enabled}
                  aria-label={s.name}
                  onClick={() => void bridge.invoke('mcp:set', project.id, s.name, !enabled).then(load)}
                />
              )}
            </div>
          );
        })}
        {servers && !servers.length && (
          <div class="setting">
            <div class="txt">
              <span>
                {t(
                  'این پروژه سرور MCP ندارد. سرورها را در ‎.mcp.json‎ (مثل Claude Code)، ‎.codex/config.toml‎ یا ‎.gisoo/mcp.json‎ تعریف کنید.',
                  'This project has no MCP server. Declare them in .mcp.json (as for Claude Code), .codex/config.toml or .gisoo/mcp.json.',
                )}
              </span>
            </div>
          </div>
        )}
      </div>
    </>
  );
}

/** The first sentence of a description is the setting's name; the rest, if any, explains it. */
function splitDescription(d: string | undefined): [string | undefined, string | undefined] {
  if (!d) return [undefined, undefined];
  const m = /^(.+?[.。؟?!])\s+(.+)$/s.exec(d.trim());
  return m ? [m[1].replace(/[.。]$/, ''), m[2]] : [d.trim().replace(/[.。]$/, ''), undefined];
}

/** `code` spans in a description become <code>; everything else stays text. */
function inline(text: string) {
  return text.split(/`([^`]+)`/g).map((part, i) => (i % 2 ? <code key={i} dir="ltr">{part}</code> : part));
}

function FieldRow({ f, projectScope, error, onSet }: { f: SettingField; projectScope: boolean; error?: string; onSet: (v: unknown) => void }) {
  const [name, rest] = splitDescription(f.description);
  const head = (
    <div class="txt">
      <b>
        {inline(name || f.label)}
        {projectScope && f.scope === 'project' && <span class="scope-tag"> · {t('این پروژه', 'this project')}</span>}
      </b>
      {rest && <span>{inline(rest)}</span>}
      <span class="key">{f.key}</span>
      {error && <span class="err">{error}</span>}
    </div>
  );
  if (f.type === 'boolean') {
    return (
      <div class="setting">
        {head}
        <button class={`switch${f.value ? ' on' : ''}`} role="switch" aria-checked={!!f.value} onClick={() => onSet(!f.value)} />
      </div>
    );
  }
  if (f.enum?.length) {
    return (
      <div class="setting">
        {head}
        <select class="field" value={String(f.value)} onChange={(e) => onSet(e.currentTarget.value)}>
          {f.enum.map((v, i) => (
            <option key={v} value={v}>
              {f.enumLabels?.[i] ? `${f.enumLabels[i]}` : v}
            </option>
          ))}
        </select>
      </div>
    );
  }
  if (f.type === 'number' || f.type === 'integer') {
    return (
      <div class="setting">
        {head}
        <input
          class="field ltr"
          type="number"
          defaultValue={String(f.value ?? '')}
          onChange={(e) => {
            const n = Number(e.currentTarget.value);
            if (Number.isFinite(n)) onSet(f.type === 'integer' ? Math.round(n) : n);
          }}
        />
      </div>
    );
  }
  if (f.type === 'string') {
    return (
      <div class="setting">
        {head}
        <input class="field" dir="auto" defaultValue={String(f.value ?? '')} onChange={(e) => onSet(e.currentTarget.value)} />
      </div>
    );
  }
  return <JsonRow f={f} head={head} onSet={onSet} />;
}

function JsonRow({ f, head, onSet }: { f: SettingField; head: preact.JSX.Element; onSet: (v: unknown) => void }) {
  const [bad, setBad] = useState(false);
  return (
    <div class="setting stack">
      {head}
      <textarea
        class="field ltr"
        defaultValue={JSON.stringify(f.value ?? null, null, 2)}
        spellcheck={false}
        onChange={(e) => {
          try {
            onSet(JSON.parse(e.currentTarget.value));
            setBad(false);
          } catch {
            setBad(true);
          }
        }}
      />
      {bad && <span class="err">{t('این متن JSON درستی نیست.', 'This is not valid JSON.')}</span>}
    </div>
  );
}
