# Install Kinako

Install Kinako on the computer or server that will run your agents. You can control it from the desktop app, a browser, or a paired mobile app.

## Requirements

Install and sign in to at least one coding agent before starting a thread. You can launch Kinako first and set up providers from the [Welcome page](./welcome-page.md) or **Settings → Providers**.

## Command line

Kinako publishes nightlies. Install the `kinako` command with the script for your platform.

```bash
curl -fsSL https://raw.githubusercontent.com/niranjan94/kinako/main/scripts/install.sh | T3CODE_CHANNEL=nightly sh
```

```powershell
$env:T3CODE_CHANNEL = "nightly"
irm https://raw.githubusercontent.com/niranjan94/kinako/main/scripts/install.ps1 | iex
```

Set `T3CODE_VERSION=<version>` to pin a build. The launcher package is available as `kinako-cli@nightly`.

| Task                                  | Command                                                                                        |
| ------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Start the server and open the web app | `kinako` or `kinako ./my-project`                                                              |
| Start the server without a browser    | `kinako serve`                                                                                 |
| Set up remote access                  | `kinako up`. See [Remote access](./remote-access.md).                                          |
| Run in the background                 | `kinako service install`. See [Background service](./background-service.md).                   |
| Update                                | `kinako update`                                                                                |
| Reclaim database space                | `kinako doctor`. See [Reclaim database space](./background-service.md#reclaim-database-space). |
| Uninstall                             | `kinako uninstall`                                                                             |

If Kinako reports a server is already running, connect with `kinako pair` or pass a separate `--base-dir`. Run `kinako --help` for the full reference.

### Intel Macs

Use the desktop app or build the server from source. See the [development runbook](../operations/00_development.md#first-checkout).

## Desktop app

Download the installer for your platform from [Kinako Releases](https://github.com/niranjan94/kinako/releases). The desktop app updates along the nightly channel.

- **macOS**. Open the signed and notarized `.dmg` and drag Kinako into Applications.
- **Windows**. Run the installer. If SmartScreen prompts for the unsigned installer, choose **More info → Run anyway**.
- **Linux**. Open the `.AppImage` or install the package with `sudo apt install ./Kinako-*.deb`.

### The `kinako` command

Manage the desktop app’s bundled command in **Settings → About**. Use **Add to PATH** if needed, then open a new terminal.

### Windows Subsystem for Linux

Select a WSL distro in **Settings → Sharing & access** to run agents and projects inside WSL. Install your provider CLIs inside that distro. Kinako manages the server runtime there.

## Mobile app

Kinako's mobile app is not in the public stores; the App Store and Google Play listings for T3 Code install upstream's app. The mobile app connects to a server on another machine via [remote access](./remote-access.md).

- **Android**: Nightly builds go to Google Play internal testing. Ask the maintainer to add you as a tester and send you the opt-in link, then install Kinako from Google Play.
- **iPhone and iPad**: Nightly builds go to TestFlight.
- If the mobile app crashes on launch, open **Settings → Diagnostics** on the next launch to copy recent startup crash reports.

## Providers

Open **Settings → Providers** (web or desktop), select the environment, and enable the providers you use. Installation and sign-in always happen on the **environment's machine**.

| Provider         | Install and authenticate                                                                                                 | Guide                                     |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------- |
| **Codex**        | Connect with ChatGPT in Settings, or install [Codex CLI](https://developers.openai.com/codex/cli) and run `codex login`. | [Codex](./providers-codex.md)             |
| **Claude**       | Install [Claude Code](https://claude.com/product/claude-code) and run `claude auth login`.                               | [Claude](./providers-claude.md)           |
| **Cursor**       | Sign in in Settings or install [Cursor CLI](https://cursor.com/cli) and run `agent login`.                               | [Cursor](./cursor.md)                     |
| **Grok Build**   | Install [Grok Build CLI](https://x.ai/cli) and run `grok login`.                                                         | [Grok](./providers-grok.md)               |
| **Antigravity**  | Install managed runtime and sign in with Google in Settings.                                                             | [Antigravity](./providers-antigravity.md) |
| **OpenCode**     | Install [OpenCode](https://opencode.ai) and run `opencode auth login`.                                                   | [OpenCode](./providers-opencode.md)       |
| **Kiro**         | Install [Kiro CLI](https://kiro.dev/docs/cli/) and run `kiro-cli login`.                                                 | [Kiro](./providers-kiro.md)               |
| **Pi**           | Install [Pi](./providers-pi.md) (Node.js 22.19+) and run `pi` → `/login`.                                                | [Pi](./providers-pi.md)                   |
| **Muse Code**    | Install [Muse Code](https://dev.meta.ai/docs/muse-code) and run `muse login`.                                            | [Muse Code](./providers-muse.md)          |
| **fx**           | Install [fx](https://fx.sh) and run `fx login`.                                                                          | [fx](./providers-fx.md)                   |
| **ACP Registry** | Add GitHub Copilot and other agents in **Settings → Providers → Add provider → Show more**.                              | [ACP](./providers-acp.md)                 |

- **Binary path**: If a CLI isn't on the server's `PATH` (common with version managers), set **Binary path** in the provider's settings.
- **Updates**: Click **Update now** on outdated provider cards (supports Homebrew, mise `latest`, npm/pnpm/Yarn/Bun/Volta/Vite+, or the CLI's own updater; update Nix, Chocolatey, or pinned mise installs manually).
- **Multiple instances**: Add extra provider instances for separate accounts, API keys, or custom endpoints (mark secret env vars as sensitive).

### Provider check timeouts

If a working CLI times out during T3 Code's readiness check, increase its probe deadline (in milliseconds) in the server's environment (or systemd override / `service.env`) and restart:

```bash
T3CODE_CODEX_PROBE_TIMEOUT_MS=60000 T3CODE_CLAUDE_PROBE_TIMEOUT_MS=60000 t3 serve
```

| Provider     | Environment variable                   |
| ------------ | -------------------------------------- |
| Codex        | `T3CODE_CODEX_PROBE_TIMEOUT_MS`        |
| Claude       | `T3CODE_CLAUDE_PROBE_TIMEOUT_MS`       |
| Cursor       | `T3CODE_CURSOR_PROBE_TIMEOUT_MS`       |
| Antigravity  | `T3CODE_ANTIGRAVITY_PROBE_TIMEOUT_MS`  |
| Grok         | `T3CODE_GROK_PROBE_TIMEOUT_MS`         |
| Kiro         | `T3CODE_KIRO_PROBE_TIMEOUT_MS`         |
| fx           | `T3CODE_FX_PROBE_TIMEOUT_MS`           |
| Pi           | `T3CODE_PI_PROBE_TIMEOUT_MS`           |
| Muse Code    | `T3CODE_MUSE_PROBE_TIMEOUT_MS`         |
| OpenCode     | `T3CODE_OPENCODE_PROBE_TIMEOUT_MS`     |
| ACP Registry | `T3CODE_ACP_REGISTRY_PROBE_TIMEOUT_MS` |

## Next steps

- [User guide index](./README.md): overview of how T3 Code works.
- [Working with threads](./thread-sidebar.md): start tasks and organize parallel work.
- [Permission modes](./permission-modes.md): control when agents ask before acting.
- [Remote access](./remote-access.md): connect from another device.
- [Updating T3 Code](./updating.md): keep apps, servers, and providers up to date.
