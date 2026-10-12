# T3 Code (niranjan94's fork)

A personal, opinionated fork of [pingdotgg/t3code](https://github.com/pingdotgg/t3code), a GUI for driving the coding agents on your machine from web, desktop, and mobile clients.

This fork exists so I can run T3 Code the way I want it. It is kept up to date with upstream on a best-effort basis, with my own changes layered on top. It is built for my own use first; anyone else is welcome to use it, but there are no support or stability promises. For the official app, use upstream.

## How it differs from upstream

The fork sends no traffic to upstream's infrastructure. Every change so far:

- **Telemetry is off by default.** Upstream's PostHog project key is removed. To collect events into a PostHog project you control, set `T3CODE_TELEMETRY_ENABLED=true` and `T3CODE_POSTHOG_KEY` (and `T3CODE_POSTHOG_HOST` for self-hosted PostHog). See [telemetry](./docs/user/telemetry.md).
- **Updates and installs come from this repository.** CLI self-update, `t3 update`, SSH remote installs, mobile environment updates, and the `install.sh` / `install.ps1` scripts all resolve releases from [niranjan94/t3code](https://github.com/niranjan94/t3code/releases).
- **Model manifest is fetched from this repository** instead of upstream.
- **Pairing links stay on your server's own origin** instead of handing the pairing token to `app.t3.codes`. Hosted pairing links come back only if `VITE_HOSTED_APP_URL` is set at build time. Remote access works over LAN, Tailscale, and SSH; T3 Connect is not built in.
- **Desktop release-notes links point at this repository.**
- **`.env.example` no longer carries upstream's production Clerk and relay values.**
- **CI runs on GitHub-hosted runners** (Ubuntu 24.04 and macOS) instead of Blacksmith, with job timeouts doubled to match the slower machines.
- **Own release workflow.** `fork-release.yml` builds unsigned macOS, Windows, and Linux desktop installers plus CLI archives and publishes them to this repository's GitHub Releases.

Upstream links that only open when you click them (marketing and legal pages, the `t3 triage` playbook, npm upgrade hints) are left as-is. [FORK.md](./FORK.md) maps each change to the files it touches and covers merging upstream and cutting releases.

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

```bash
curl -fsSL https://raw.githubusercontent.com/niranjan94/t3code/main/scripts/install.sh | sh
```

On Windows, in PowerShell:

```powershell
irm https://raw.githubusercontent.com/niranjan94/t3code/main/scripts/install.ps1 | iex
```

Then run `t3` to start the server and open the local web app. `t3 service install` keeps it running in the background, `t3 update` moves to a newer release of this fork, and `t3 --help` has the full reference.

### Desktop app

Download the installer for your platform from [GitHub Releases](https://github.com/niranjan94/t3code/releases). Builds are unsigned:

- **macOS:** after installing, clear the quarantine flag with `xattr -dr com.apple.quarantine "/Applications/T3 Code (Alpha).app"`. Auto-update does not work for unsigned macOS apps, so download new versions by hand.
- **Windows:** SmartScreen warns on unsigned installers; choose **More info → Run anyway**.
- **Linux:** use the `.AppImage` or install the `.deb` with `sudo apt install ./T3-Code-*.deb`.

The upstream package registries (Homebrew, winget, Scoop, AUR) and the hosted app at app.t3.codes ship upstream's builds, not this fork. This fork does not publish mobile builds.

## Documentation

User and internal docs are inherited from upstream and live in [docs/](./docs). Some of them describe upstream-only infrastructure such as T3 Connect.

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
- [Run T3 Code as a background service](./docs/user/background-service.md)

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
