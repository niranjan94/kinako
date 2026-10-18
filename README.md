<p align="center">
  <img src="./assets/nightly/nightly-macos-1024.png" alt="" width="128" height="128">
</p>

<h1 align="center">Kinako</h1>

Kinako is a personal, opinionated fork of [T3 Code](https://github.com/pingdotgg/t3code), a GUI for driving the coding agents on your machine from web, desktop, and mobile clients.

This fork exists so I can run T3 Code the way I want it. It is kept up to date with upstream on a best-effort basis, with my own changes layered on top. It is built for my own use first; anyone else is welcome to use it, but there are no support or stability promises. For the official app, use upstream.

## How it differs from upstream

Kinako installs alongside T3 Code with its own apps, `kinako` CLI, data in `~/.kinako`, and nightly updates. It does not import upstream's settings or data. Telemetry is off by default.

Feature highlights:

- **Databases:** browse Postgres and SQLite, run SQL with completion, and export results. Mobile and agents get read-only queries. [Guide](./docs/user/databases.md)
- **CLI sessions:** import Claude Code and Codex sessions, or copy a resume command to continue a thread in the terminal.
- **Context controls:** summarize part of a conversation, restore full context, and see a context-window breakdown. [Guide](./docs/user/composer.md#summarize-part-of-a-conversation)
- **Workspaces:** give threads additional directories and copy gitignored files such as `.env` into new worktrees. [Guide](./docs/user/project-settings.md#additional-directories)
- **GitHub:** read and reply to issues, send issues and PRs to agents, and opt into automatic CI fixes on watched PRs. [Guide](./docs/user/source-control.md)
- **Remote access:** manage pairing on remote environments, update SSH servers from the app, and pair using stable local or Tailscale names. [Guide](./docs/user/remote-access.md)
- **Keep awake:** prevent the host from sleeping while agents work, including scheduled tasks. [Guide](./docs/user/background-service.md#keep-the-computer-awake)

Remote access uses LAN, Tailscale, or SSH; T3 Connect is not built in. Pairing stays on your server, and builds and updates come from this repository.

See [FORK.md](./FORK.md) for fork maintenance and migration details.

## Installation

> [!WARNING]
> Install and authenticate at least one provider before use:
>
> - Codex: install [Codex CLI](https://developers.openai.com/codex/cli) and run `codex login`
> - Claude: install [Claude Code](https://claude.com/product/claude-code) and run `claude auth login`
> - Cursor: install [Cursor CLI](https://cursor.com/cli) and run `agent login`
> - Grok Build: install [Grok Build CLI](https://x.ai/cli) and run `grok login`
> - OpenCode: install [OpenCode](https://opencode.ai) and run `opencode auth login`
> - Antigravity: enable it in Settings, then use **Install Antigravity** and **Sign in with Google**. No CLI is required.

### Command line

With Node.js 20.11 or newer, run the npm launcher:

```bash
npx kinako-cli@nightly
```

Or install it globally:

```bash
npm install -g kinako-cli@nightly
kinako
```

The launcher downloads the matching CLI archive on first run. CLI builds support macOS Apple Silicon, Linux x64/arm64, and Windows x64/arm64; Intel Macs can use the desktop app.

To install without npm, on macOS or Linux:

```bash
curl -fsSL https://raw.githubusercontent.com/niranjan94/kinako/main/scripts/install.sh | T3CODE_CHANNEL=nightly sh
```

On Windows, in PowerShell:

```powershell
$env:T3CODE_CHANNEL = "nightly"
irm https://raw.githubusercontent.com/niranjan94/kinako/main/scripts/install.ps1 | iex
```

This fork publishes nightlies only; use the `nightly` npm tag or the channel shown above.

Then run `kinako` to start the server and open the local web app. `kinako service install` keeps it running in the background, and `kinako --help` has the full reference. Update a script install with `kinako update`, a global npm install with `npm install -g kinako-cli@nightly`, or rerun `npx kinako-cli@nightly`.

### Desktop app

Download the installer for your platform from [GitHub Releases](https://github.com/niranjan94/kinako/releases). The app updates itself along the nightly channel.

- **macOS:** signed and notarized; open the `.dmg` and drag Kinako into Applications.
- **Windows:** installers are unsigned, so SmartScreen warns; choose **More info → Run anyway**.
- **Linux:** use the `.AppImage` or install the `.deb` with `sudo apt install ./Kinako-*.deb`.

The upstream package registries (Homebrew, winget, Scoop, AUR) and the hosted app at app.t3.codes ship upstream's builds, not this fork. iOS nightlies go to an internal TestFlight group only, and there is no Android release.

## Documentation

User and internal docs are inherited from upstream and live in [docs/](./docs). They still say "T3 Code" and use `t3` commands, which are `kinako` here, and some describe upstream-only infrastructure such as T3 Connect.

- [Install and first run](./docs/user/install.md)
- [Permission modes](./docs/user/permission-modes.md)
- [Keyboard shortcuts](./docs/user/keybindings.md)
- [Project settings](./docs/user/project-settings.md)
- [Appearance preferences](./docs/user/appearance.md)
- [Remote access from a phone or another machine](./docs/user/remote-access.md)
- [Connect Claude Code, Codex, ChatGPT and other agents over MCP](./docs/user/outside-agents.md)
- [Keeping app and server in sync](./docs/user/updating.md)
- [Source control integrations](./docs/user/source-control.md)
- Multiple accounts: [Codex](./docs/user/providers-codex.md) · [Claude](./docs/user/providers-claude.md)
- [Run Kinako as a background service](./docs/user/background-service.md)

Building from source? Start at [docs/internals/overview.md](./docs/internals/overview.md).

## Building from source

T3 Code uses [Vite+](https://viteplus.dev/guide/), so install the global `vp` tool first:

```bash
# macOS / Linux
curl -fsSL https://vite.plus | bash
```

```powershell
# Windows
irm https://vite.plus/ps1 | iex
```

Then install dependencies and start the dev server:

```bash
vp i
vp run dev
```

## Issues and contributions

Bugs that reproduce on upstream belong [upstream](https://github.com/pingdotgg/t3code/issues). Issues and pull requests here are fine for fork-specific behavior, but I make no promises about acting on them.

## License

[MIT](./LICENSE), same as upstream. All credit for T3 Code goes to its upstream authors.
