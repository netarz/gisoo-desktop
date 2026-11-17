# Security policy

Gisoo Desktop runs an AI agent that can read files, edit them and run commands on your computer, so we treat
security reports as the most urgent kind of bug.

## Reporting a vulnerability

Please **do not open a public issue**. Report privately through
[GitHub's private vulnerability reporting](https://github.com/netarz/gisoo-desktop/security/advisories/new)
or by email to **dev@gisoo.pro**. Include the version (the installer's name, e.g. `Gisoo-Setup-0.1.0.exe`), your OS, the steps to
reproduce, and what an attacker gains.

We acknowledge a report within three working days, keep you informed while we fix it, and credit you in the
release notes unless you prefer otherwise.

## Supported versions

Only the latest release receives security fixes.

## What we consider in scope

- A web page, a file in a project, a chat imported from another tool, or an MCP server's output that makes
  the agent act without the approval the settings promise.
- A project file (`.gisoo/`, `.mcp.json`, `.codex/config.toml`, `AGENTS.md`, `CLAUDE.md`) that runs code
  before the folder is trusted or before its MCP server is approved.
- Code running in the chat or shell window that reaches Node.js, the file system or the main process beyond
  the documented bridge.
- Leaking the Gisoo key, an MCP server's environment or headers, or the content of another project.
- Weaknesses in the sign-in flow (`gisoo-desktop://` callback).

## How the app is hardened

- Every window runs sandboxed, with context isolation, no Node.js integration and a strict Content Security
  Policy; the pages talk to the main process only through a fixed list of channels.
- Navigation and new windows are refused; links open in the system browser.
- Electron fuses: `RunAsNode`, `NODE_OPTIONS` and the `--inspect` switches are disabled, the app loads only
  from its signed `app.asar` and checks its integrity at start-up, cookies are encrypted.
- Untrusted folders cannot run commands, edit files or start MCP servers. MCP servers declared inside a
  project start only after you allow them, and the approval is tied to the exact command, arguments,
  environment and URL: any change asks again.
- Release builds are produced only by the GitHub Actions workflow in this repository, with every action
  pinned to a commit; each release carries `SHA256SUMS.txt`.
