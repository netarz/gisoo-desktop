/** Everything drawn over the window: questions from the agent, file and diff viewers, toasts, task output, menus. */
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { HostNotice, HostRequest } from '../main/api';
import { Icon, type IconName } from './icons';
import { lineDiff, num, t } from './util';

// ------------------------------------------------------------------------------------------- questions

export interface Ask {
  id: number;
  req: HostRequest;
  answer: (value: unknown) => void;
}

function useEscape(fn: () => void): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        fn();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [fn]);
}

const levelIcon: Record<string, IconName> = { info: 'info', warning: 'warning', error: 'error' };

export function AskView({ ask }: { ask: Ask }) {
  const { req } = ask;
  if (req.kind === 'message') return <MessageAsk ask={ask} req={req} />;
  if (req.kind === 'quickPick') return <PickAsk ask={ask} req={req} />;
  return <InputAsk ask={ask} req={req} />;
}

function MessageAsk({ ask, req }: { ask: Ask; req: Extract<HostRequest, { kind: 'message' }> }) {
  useEscape(() => ask.answer(undefined));
  return (
    <div class="veil center" onMouseDown={(e) => e.target === e.currentTarget && ask.answer(undefined)}>
      <div class="dialog" role="alertdialog">
        <div class="dialog-head">
          <span class={`toast-ic ${req.level}`} style={{ color: req.level === 'error' ? 'var(--g-bad)' : req.level === 'warning' ? 'var(--g-warn)' : 'var(--g-gold)', display: 'inline-flex' }}>
            <Icon name={levelIcon[req.level]} size={18} />
          </span>
          <h2 style={{ whiteSpace: 'normal' }}>{req.text}</h2>
        </div>
        {req.detail && (
          <div class="dialog-body">
            <div class="detail">{req.detail}</div>
          </div>
        )}
        <div class="dialog-foot">
          <button class="btn ghost" onClick={() => ask.answer(undefined)}>{t('بستن', 'Close')}</button>
          {req.actions.map((a, i) => (
            <button key={i} class={`btn${i === 0 ? ' primary' : ''}`} autoFocus={i === 0} onClick={() => ask.answer(i)}>
              {a}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function PickAsk({ ask, req }: { ask: Ask; req: Extract<HostRequest, { kind: 'quickPick' }> }) {
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const [picked, setPicked] = useState<Set<number>>(() => new Set(req.items.flatMap((it, i) => (it.picked ? [i] : []))));
  const listRef = useRef<HTMLDivElement>(null);
  const visible = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return req.items
      .map((it, i) => ({ it, i }))
      .filter(({ it }) => it.separator || !needle || `${it.label} ${it.description ?? ''} ${it.detail ?? ''}`.toLowerCase().includes(needle))
      .filter(({ it }, idx, arr) => !it.separator || (arr[idx + 1] && !arr[idx + 1].it.separator));
  }, [q, req.items]);
  const choosable = visible.filter((v) => !v.it.separator);
  useEscape(() => ask.answer(undefined));
  useEffect(() => setSel(0), [q]);
  useEffect(() => {
    listRef.current?.querySelector('.sel')?.scrollIntoView({ block: 'nearest' });
  }, [sel]);

  const accept = (index?: number) => {
    if (req.canPickMany) ask.answer([...picked].sort((a, b) => a - b));
    else {
      const chosen = index ?? choosable[sel]?.i;
      ask.answer(chosen === undefined ? undefined : [chosen]);
    }
  };
  const toggle = (i: number) => {
    const next = new Set(picked);
    if (next.has(i)) next.delete(i);
    else next.add(i);
    setPicked(next);
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSel((s) => Math.min(choosable.length - 1, s + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSel((s) => Math.max(0, s - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      accept();
    } else if (e.key === ' ' && req.canPickMany && choosable[sel] && !q) {
      e.preventDefault();
      toggle(choosable[sel].i);
    }
  };

  return (
    <div class="veil" onMouseDown={(e) => e.target === e.currentTarget && ask.answer(undefined)}>
      <div class="dialog pick" role="dialog">
        <div class="dialog-head">
          <h2>{req.title || req.placeHolder || t('انتخاب کنید', 'Choose')}</h2>
          <button class="icon-btn" onClick={() => ask.answer(undefined)} aria-label={t('بستن', 'Close')}>
            <Icon name="x" />
          </button>
        </div>
        <input class="field" autoFocus value={q} placeholder={req.placeHolder ?? t('جست‌وجو…', 'Search…')} onInput={(e) => setQ(e.currentTarget.value)} onKeyDown={onKey} />
        <div class="pick-list" ref={listRef}>
          {visible.map(({ it, i }) => {
            if (it.separator) return <div key={`s${i}`} class="pick-sep">{it.label}</div>;
            const pos = choosable.findIndex((c) => c.i === i);
            return (
              <button
                key={i}
                class={`pick-item${pos === sel ? ' sel' : ''}`}
                onMouseEnter={() => setSel(pos)}
                onClick={() => (req.canPickMany ? toggle(i) : accept(i))}
              >
                {req.canPickMany && <span class={`check${picked.has(i) ? ' on' : ''}`}>{picked.has(i) && <Icon name="check" size={12} stroke={3} />}</span>}
                <span class="t">
                  <span>
                    {stripCodicons(it.label)} {it.description && <span class="d">{stripCodicons(it.description)}</span>}
                  </span>
                  {it.detail && <span class="d">{stripCodicons(it.detail)}</span>}
                </span>
              </button>
            );
          })}
          {!choosable.length && <div class="pick-sep">{t('چیزی پیدا نشد.', 'Nothing found.')}</div>}
        </div>
        {req.canPickMany && (
          <div class="dialog-foot">
            <button class="btn ghost" onClick={() => ask.answer(undefined)}>{t('انصراف', 'Cancel')}</button>
            <button class="btn primary" onClick={() => accept()}>{t('تأیید', 'OK')}</button>
          </div>
        )}
      </div>
    </div>
  );
}

/** VS Code labels carry `$(icon)` codes; the desktop shows the text alone. */
function stripCodicons(s: string): string {
  return s.replace(/\$\([a-z0-9-~]+\)\s*/gi, '');
}

function InputAsk({ ask, req }: { ask: Ask; req: Extract<HostRequest, { kind: 'inputBox' }> }) {
  const [value, setValue] = useState(req.value ?? '');
  useEscape(() => ask.answer(undefined));
  return (
    <div class="veil" onMouseDown={(e) => e.target === e.currentTarget && ask.answer(undefined)}>
      <form
        class="dialog"
        onSubmit={(e) => {
          e.preventDefault();
          ask.answer(value);
        }}
      >
        <div class="dialog-head">
          <h2>{req.title || req.prompt || t('ورود متن', 'Input')}</h2>
        </div>
        <div class="dialog-body">
          {req.title && req.prompt && <div class="detail" style={{ marginTop: 0, marginBottom: 10 }}>{req.prompt}</div>}
          <input
            class="field"
            autoFocus
            type={(req.password ? 'password' : 'text') as 'text'}
            value={value}
            placeholder={req.placeHolder}
            dir="auto"
            autoComplete="off"
            spellcheck={false}
            onInput={(e) => setValue(e.currentTarget.value)}
          />
          {req.error && <div class="err">{req.error}</div>}
        </div>
        <div class="dialog-foot">
          <button type="button" class="btn ghost" onClick={() => ask.answer(undefined)}>{t('انصراف', 'Cancel')}</button>
          <button type="submit" class="btn primary">{t('تأیید', 'OK')}</button>
        </div>
      </form>
    </div>
  );
}

// ------------------------------------------------------------------------------------------- viewers

type Doc = Extract<HostNotice, { kind: 'document' }>;
type Diff = Extract<HostNotice, { kind: 'diff' }>;

export function DocumentView({ doc, onClose }: { doc: Doc; onClose: () => void }) {
  useEscape(onClose);
  const ref = useRef<HTMLPreElement>(null);
  const lines = useMemo(() => doc.content.split('\n'), [doc.content]);
  useEffect(() => {
    if (doc.line) ref.current?.querySelector('.hl')?.scrollIntoView({ block: 'center' });
  }, [doc]);
  return (
    <div class="veil center" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div class="dialog wide">
        <div class="dialog-head">
          <Icon name="file" />
          <h2>{doc.title}</h2>
          {doc.path && <span class="path">{doc.path}</span>}
          <button class="icon-btn" onClick={() => void navigator.clipboard.writeText(doc.content)} title={t('رونوشت', 'Copy')}>
            <Icon name="copy" />
          </button>
          <button class="icon-btn" onClick={onClose} aria-label={t('بستن', 'Close')}>
            <Icon name="x" />
          </button>
        </div>
        <pre class="code" ref={ref}>
          {lines.map((l, i) => (
            <div key={i} class={`ln${doc.line === i + 1 ? ' hl' : ''}`}>
              <i>{i + 1}</i>
              <span>{l || ' '}</span>
            </div>
          ))}
        </pre>
      </div>
    </div>
  );
}

export function DiffView({ diff, onClose }: { diff: Diff; onClose: () => void }) {
  useEscape(onClose);
  const lines = useMemo(() => lineDiff(diff.before, diff.after), [diff]);
  const added = lines.filter((l) => l.kind === 'add').length;
  const removed = lines.filter((l) => l.kind === 'del').length;
  return (
    <div class="veil center" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div class="dialog wide">
        <div class="dialog-head">
          <Icon name="file" />
          <h2>{diff.title}</h2>
          <span class="path" style={{ color: 'var(--g-ok)' }}>+{num(added)}</span>
          <span class="path" style={{ color: 'var(--g-bad)' }}>-{num(removed)}</span>
          <button class="icon-btn" onClick={onClose} aria-label={t('بستن', 'Close')}>
            <Icon name="x" />
          </button>
        </div>
        <pre class="code">
          {lines.map((l, i) =>
            l.kind === 'gap' ? (
              <div key={i} class="gap">{t('{n} خط بدون تغییر', '{n} unchanged lines', { n: l.count })}</div>
            ) : (
              <div key={i} class={`ln ${l.kind}`}>
                <i>{l.kind === 'del' ? l.a : l.b}</i>
                <span>{l.text || ' '}</span>
              </div>
            ),
          )}
          {!lines.some((l) => l.kind === 'add' || l.kind === 'del') && <div class="gap">{t('تغییری نیست.', 'No changes.')}</div>}
        </pre>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------------------------------- toasts

export interface Toast {
  id: number;
  level: 'info' | 'warning' | 'error';
  text: string;
  actions?: string[];
  answer?: (i: number | undefined) => void;
}

export function Toasts({ toasts, dismiss }: { toasts: Toast[]; dismiss: (id: number, choice?: number) => void }) {
  return (
    <div class="toasts" aria-live="polite">
      {toasts.map((x) => (
        <div key={x.id} class={`toast ${x.level}`}>
          <span class="ic">
            <Icon name={levelIcon[x.level]} />
          </span>
          <div class="grow">
            {x.text}
            {!!x.actions?.length && (
              <div class="acts">
                {x.actions.map((a, i) => (
                  <button key={i} class={`btn${i === 0 ? ' primary' : ''}`} onClick={() => dismiss(x.id, i)}>
                    {a}
                  </button>
                ))}
              </div>
            )}
          </div>
          <button class="icon-btn sm" onClick={() => dismiss(x.id)} aria-label={t('بستن', 'Close')}>
            <Icon name="x" size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}

// ------------------------------------------------------------------------------------------- tasks

export interface Task {
  id: string;
  title: string;
  output: string;
  exitCode?: number;
}

export function TaskDrawer({ tasks, onClose }: { tasks: Task[]; onClose: () => void }) {
  const [current, setCurrent] = useState(tasks[tasks.length - 1]?.id);
  const task = tasks.find((x) => x.id === current) ?? tasks[tasks.length - 1];
  const ref = useRef<HTMLPreElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [task?.output]);
  useEffect(() => setCurrent(tasks[tasks.length - 1]?.id), [tasks.length]);
  if (!task) return null;
  return (
    <div class="drawer">
      <div class="tabs">
        <Icon name="terminal" />
        {tasks.map((x) => (
          <button key={x.id} class={`tab${x.id === task.id ? ' on' : ''}`} onClick={() => setCurrent(x.id)}>
            {x.exitCode === undefined ? <span class="spinner" style={{ width: 10, height: 10, borderWidth: 1.5 }} /> : null}
            {x.title}
            {x.exitCode !== undefined && x.exitCode !== 0 && <span style={{ color: 'var(--g-bad)' }}>({num(x.exitCode)})</span>}
          </button>
        ))}
        <span style={{ flex: 1 }} />
        <button class="icon-btn sm" onClick={onClose} aria-label={t('بستن', 'Close')}>
          <Icon name="x" size={14} />
        </button>
      </div>
      <pre ref={ref}>{task.output}</pre>
    </div>
  );
}

// ------------------------------------------------------------------------------------------- menus

export interface MenuItem {
  label: string;
  icon?: IconName;
  danger?: boolean;
  run: () => void;
}

export function Menu({ x, y, items, onClose }: { x: number; y: number; items: Array<MenuItem | 'sep'>; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });
  useEscape(onClose);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPos({ left: Math.max(8, Math.min(x, innerWidth - r.width - 8)), top: Math.max(8, Math.min(y, innerHeight - r.height - 8)) });
    const away = (e: MouseEvent) => {
      if (!el.contains(e.target as Node)) onClose();
    };
    setTimeout(() => window.addEventListener('mousedown', away), 0);
    window.addEventListener('blur', onClose);
    return () => {
      window.removeEventListener('mousedown', away);
      window.removeEventListener('blur', onClose);
    };
  }, []);
  return (
    <div class="menu" ref={ref} style={{ left: pos.left, top: pos.top }} role="menu">
      {items.map((it, i) =>
        it === 'sep' ? (
          <hr key={i} />
        ) : (
          <button
            key={i}
            class={it.danger ? 'danger' : ''}
            role="menuitem"
            onClick={() => {
              onClose();
              it.run();
            }}
          >
            {it.icon && <Icon name={it.icon} />}
            {it.label}
          </button>
        ),
      )}
    </div>
  );
}
