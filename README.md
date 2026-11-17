# Gisoo Desktop

The [Gisoo](https://gisoo.pro) coding agent as a desktop app for Windows and macOS. Every project is a
folder in the sidebar with its own chats, and every chat runs the same agent as
[Gisoo for VS Code](https://github.com/netarz/gisoo-vscode): it reads the project, plans, edits files
with diffs you approve, runs the commands you allow and keeps going until the task is done.

[فارسی](#فارسی)

## What it does

- **Projects and their chats.** Add a folder and it becomes a project. Its chats are listed under it,
  and "Recent" shows the latest ones across all projects. Chats run side by side: start one in a
  project, switch to another, and the first keeps working.
- **Chats from your other tools.** Chats you had in Gisoo for VS Code, Claude Code and Codex for the
  same folder appear under the project, labelled with their source. Open one to continue it in Gisoo.
- **Everything stays with the project.** Instruction files (`GISOO.md`, `CLAUDE.md`, `AGENTS.md` and
  the rest), custom slash commands, skills and project memory are read from the project's own folder,
  exactly as the extension does. Settings for one project are saved in `<project>/.gisoo/settings.json`
  and win over the settings for all projects.
- **The full agent.** Plans and to-do lists, Ask / Auto-edit / Plan permission modes, checkpoints,
  a model picker with every model on your Gisoo account, `@` file mentions, images, dictation,
  and the code graph. See the extension's README for the complete list.
- **MCP servers.** Servers you configured for Gisoo, Claude Code (`.mcp.json`, `~/.claude.json`) or
  Codex (`.codex/config.toml`, `~/.codex/config.toml`) are picked up per project, over stdio or HTTP.
  A server declared inside a project starts only after you allow it, and any later change to its
  command, environment or URL asks again. Tools that write go through the same approval as file edits.
- **AStack.** In a project that uses [AStack](https://github.com/ARaminco/AStack), Gisoo connects to its
  shared brain: the same memory, code graph, context search, journal, standup and handoffs that
  Claude Code and Codex use there.
- **Trust before tools.** A new project opens untrusted: the agent can read and chat, but runs no
  command and starts no MCP server until you trust the folder.
- **Gisoo account sign-in** in the browser, or with an API key. Your balance is shown in the app.
- **Persian and English**, right to left where it belongs, light and dark themes.
- **No telemetry.** The app talks only to the Gisoo API you configured.

Shortcuts: `Ctrl/Cmd+N` new chat, `Ctrl/Cmd+K` search, `Ctrl/Cmd+B` sidebar, `Ctrl/Cmd+,` settings.

## Install

Download the installer for your system from the
[releases](https://github.com/netarz/gisoo-desktop/releases): `Gisoo-Setup-<version>.exe` for Windows,
`Gisoo-<version>-arm64.dmg` (Apple silicon) or `-x64.dmg` (Intel) for macOS. Each release lists the
SHA-256 of every file in `SHA256SUMS.txt`.

Until our code-signing certificates are in place, the installers are not signed:

- **Windows** shows "Windows protected your PC". Choose *More info*, then *Run anyway*.
- **macOS** says the app "cannot be opened". Right-click Gisoo in Applications, choose *Open*, then
  *Open* again (or allow it under System Settings, Privacy & Security).

Security reports: see [SECURITY.md](SECURITY.md).

## Build from source

Requires Node.js 20 or newer.

```bash
npm ci
npm start            # build and run
npm run typecheck
npm run dist:win     # Windows installer in release/
npm run dist:mac     # macOS disk images in release/ (run on a Mac)
```

## How it is put together

| Folder | What it holds |
| --- | --- |
| `src/`, `webview/` | The agent and the chat UI, copied unchanged from gisoo-vscode by `npm run sync-core`. Do not edit them here; change them upstream and sync. |
| `shim/` | Answers the `vscode` API the core imports: files, settings, terminals, dialogs, each scoped to its project. |
| `main/` | The Electron main process: windows, projects, chats, sign-in, imported chats. |
| `shell/` | The window around the chats: sidebar, home, settings (Preact). |
| `chat/` | The page that hosts one chat. |
| `scripts/` | `sync-core.mjs` and `make-icons.cjs` (`npm run icons` redraws `build/` from the logo). |

## Licence

[MIT](LICENSE) © NetArz

---

## فارسی

<div dir="rtl">

گیسو دسکتاپ، دستیار برنامه‌نویسی [گیسو](https://gisoo.pro) را به‌صورت یک برنامهٔ مستقل برای ویندوز و مک در اختیار شما می‌گذارد. هر پروژه یک پوشه در نوار کناری است و گفت‌وگوهای خودش را دارد. پشت هر گفت‌وگو همان دستیار افزونهٔ گیسو برای VS Code کار می‌کند: پروژه را می‌خواند، برای کار برنامه می‌ریزد، فایل‌ها را با تغییراتی که شما تأیید می‌کنید ویرایش می‌کند، دستورهایی را که اجازه داده‌اید اجرا می‌کند و تا پایان کار پیش می‌رود.

- **پروژه‌ها و گفت‌وگوهایشان:** هر پوشه‌ای که اضافه کنید یک پروژه می‌شود و گفت‌وگوهایش زیر خودش فهرست می‌شوند. بخش «اخیر» تازه‌ترین گفت‌وگوهای همهٔ پروژه‌ها را نشان می‌دهد. چند گفت‌وگو هم‌زمان کار می‌کنند.
- **گفت‌وگوهای ابزارهای دیگر:** گفت‌وگوهایی که در افزونهٔ گیسو، Claude Code یا Codex روی همان پوشه داشته‌اید، با نام منبعشان زیر پروژه می‌آیند و می‌توانید آن‌ها را در گیسو ادامه دهید.
- **همه‌چیز در پوشهٔ خود پروژه:** فایل‌های دستورالعمل، فرمان‌های سفارشی، مهارت‌ها و حافظهٔ پروژه از پوشهٔ همان پروژه خوانده می‌شوند. تنظیم‌های مخصوص هر پروژه در `.gisoo/settings.json` همان پوشه ذخیره می‌شوند.
- **سرورهای MCP:** سرورهایی که برای گیسو، Claude Code یا Codex تنظیم کرده‌اید برای هر پروژه شناخته می‌شوند. سروری که داخل خود پروژه تعریف شده، فقط بعد از اجازهٔ شما روشن می‌شود و اگر دستور یا نشانی‌اش عوض شود، دوباره اجازه می‌خواهد.
- **AStack:** در پروژه‌ای که AStack دارد، گیسو به همان حافظهٔ مشترک، نقشهٔ کد، ژورنال و تحویل کاری وصل می‌شود که Claude Code و Codex از آن استفاده می‌کنند.
- **اول اعتماد، بعد اجرا:** پروژهٔ تازه تا وقتی به آن اعتماد نکنید هیچ دستوری اجرا نمی‌کند و هیچ سرور MCP را روشن نمی‌کند.
- **نصب:** نصب‌کننده‌ها فعلاً امضای دیجیتال ندارند. در ویندوز «More info» و بعد «Run anyway» را بزنید؛ در مک روی برنامه کلیک راست کنید و «Open» را بزنید.
- **ورود با حساب گیسو** از مرورگر یا با کلید دسترسی (API Key).
- رابط فارسی و انگلیسی، راست‌به‌چپ، پوستهٔ روشن و تیره، بدون ارسال آمار استفاده.

این برنامه متن‌باز و با مجوز MIT منتشر شده است.

</div>
