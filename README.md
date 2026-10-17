<p align="center">
  <img src="./assets/nightly/nightly-macos-1024.png" alt="" width="128" height="128">
</p>

<h1 align="center">Kinako</h1>

Kinako is a personal, opinionated fork of [T3 Code](https://github.com/pingdotgg/t3code), a GUI for driving the coding agents on your machine from web, desktop, and mobile clients.

This fork exists so I can run T3 Code the way I want it. It is kept up to date with upstream on a best-effort basis, with my own changes layered on top. It is built for my own use first; anyone else is welcome to use it, but there are no support or stability promises. For the official app, use upstream.

## How it differs from upstream

### Features

- **Import CLI sessions.** A project lists the Claude Code and Codex sessions you started from its directory in a terminal, and imports any of them as a thread, on web and mobile. Importing the same session again opens the existing thread.
- **Copy a CLI resume command.** Continue a Claude or Codex thread in its own CLI on the environment's host. The command is in the thread's Copy menu in the chat header and sidebar, in the command palette, and in the thread's long-press menu on mobile.
- **Files to copy into new worktrees.** New worktrees get the gitignored files from the main checkout, such as `.env`, that match the repository's `.worktreeinclude` (the same file Claude Code and Conductor read) or the **Files to copy** setting under Settings → Storage, which projects can override. Copied files, even edited ones, do not stop worktree cleanup as long as the main checkout still has the file; a Storage setting makes edited copies protect their worktree instead.
- **Build provenance in Settings → About.** CI builds show the repository and commit they were built from.
- **Summarize part of a conversation.** Under a sent message, **Summarize from here** or **Summarize up to here** replaces that part of the thread with a model-written summary to free context space, and **Restore full context** undoes it. Works on web, desktop, and mobile, and agents can do the same through MCP. See [Summarize part of a conversation](./docs/user/composer.md#summarize-part-of-a-conversation).
- **Context window meter with a breakdown, on by default.** Hover or tap the meter next to the composer to see what fills the window: Claude itemizes system prompt, tools, memory files, and messages; other providers show cached input, new input, and output. Mobile gets the meter too. Turn it off under Settings → General → Context window indicator.
- **Additional directories.** A project can give its threads extra folders to read and edit, each used as the current checkout or as a per-thread worktree on the thread's branch. Set the default in project settings and change it per draft from the composer's workspace menu. Claude, Codex, Cursor, Antigravity, Grok, and ACP providers receive the folders. See [Additional directories](./docs/user/project-settings.md#additional-directories).
- **GitHub issues next to pull requests.** The Pull requests view switches to **Issues**, where you can read an issue and its comments and reply. Every pull request and issue offers **Ask** (a supervised thread that knows the item) and **Send to agent** (a pre-filled message, plus a worktree for pull requests). See [Issues](./docs/user/source-control.md#issues).
- **Auto-fix CI on watched pull requests.** When a check fails on a new commit, the agent gets one turn per commit to fix it. Auto-fix pauses after three attempts in a row without passing checks, or when a fix turn pushes nothing. Turn it on from the row menu in **Linked pull requests**, from a pull request's AI helpers on mobile, or by asking the agent.
- **Keep awake.** Settings → General → Keep awake stops the host from sleeping while agents work (scheduled tasks included) or always, on macOS, Windows, and Linux with systemd. See [Keep the computer awake](./docs/user/background-service.md#keep-the-computer-awake).
- **Pairing and clients for remote environments.** Settings → Connections → **Clients** on a saved environment creates pairing links and revokes client sessions there, not only on the local host. Environments added over SSH get the access they need automatically. See [Manage or revoke access](./docs/user/remote-access.md#manage-or-revoke-access).
- **Network access for SSH environments.** The same **Clients** dialog can restart an SSH-launched server on the host's network, with QR codes for its LAN and Tailscale addresses, so phones and other machines pair with it directly.
- **Stable pairing addresses.** Settings → Connections lists the machine's `.local` name and its Tailscale MagicDNS names next to its IP addresses, so pairing links keep working when addresses change.
- **Claude workflow threads read as a run report.** Instead of the raw script, a workflow thread shows its name, elapsed time, agent and token totals, a stop control, and each phase's agents, with the script collapsed at the end.

### Changes

The fork sends no traffic to upstream's infrastructure. Every change so far:

- **Its own identity, so it runs alongside upstream T3 Code.** The app is called Kinako, the CLI is `kinako`, data lives in `~/.kinako`, links use `kinako://`, and the desktop and mobile apps, background service, default ports (3873, Tailscale Serve on 8443), SnapShot helpers and shortcut (Ctrl+Shift+3) are all separate from upstream's. Upgrading from an earlier build of this fork needs a one-time move; see [FORK.md](./FORK.md#moving-from-t3-code-to-kinako).
- **Nothing is imported from upstream T3 Code.** Kinako never reads `~/.t3` or upstream's desktop profiles, so the two installs share no drafts, layout, or settings.
- **The project file is `kinako.json`.** Upstream's `t3.json` is read only when a repository has no `kinako.json`, and an invalid `kinako.json` never falls back to it.
- **Commits and branches carry the Kinako name.** Commits the app makes are authored as `Kinako <kinako@localhost>`, temporary worktree branches are named `kinako/<hex>` (existing `t3/<hex>` branches are still recognized), and new project READMEs link this repository.
- **Codex knows it is talking to Kinako.** Codex sessions identify Kinako as their client to OpenAI, and new ChatGPT sign-ins show Kinako on OpenAI's consent page. Accounts already connected keep the name they were registered under.
- **Pull request worktrees are only reused from this environment's own worktree folders**, so a worktree upstream T3 Code created is never adopted.
- **Repository choice follows `gh repo set-default`** when a project has several remotes.
- **Telemetry is off by default.** Upstream's PostHog project key is removed. To collect events into a PostHog project you control, set `T3CODE_TELEMETRY_ENABLED=true` and `T3CODE_POSTHOG_KEY` (and `T3CODE_POSTHOG_HOST` for self-hosted PostHog). See [telemetry](./docs/user/telemetry.md).
- **Updates and installs come from this repository.** CLI self-update, `kinako update`, SSH remote installs, mobile environment updates, and the `install.sh` / `install.ps1` scripts all resolve releases from [niranjan94/kinako](https://github.com/niranjan94/kinako/releases).
- **Model manifest is fetched from this repository** instead of upstream.
- **SSH environments update from the app.** A server the desktop app starts over SSH runs under the service launcher, so the update button downloads the new release and restarts it, with nothing to run on the host. Every route to the same host shares that server.
- **Pairing links stay on your server's own origin** instead of handing the pairing token to `app.t3.codes`. Hosted pairing links come back only if `VITE_HOSTED_APP_URL` is set at build time. Remote access works over LAN, Tailscale, and SSH; T3 Connect is not built in.
- **Prompt links are only offered when `VITE_HOSTED_APP_URL` names a hosted app of your own**, instead of sharing prompts through `app.t3.codes`.
- **The sidebar header shows only the app name**, without the T3 wordmark.
- **Desktop release-notes links point at this repository.**
- **`kinako triage` works against this repository.** The agent it starts fetches the playbook, clones the source, searches issues, and files new ones here, labelled `via-triage`.
- **`.env.example` no longer carries upstream's production Clerk and relay values.**
- **CI runs on GitHub-hosted runners** (Ubuntu 24.04 and macOS) instead of Blacksmith, with job timeouts doubled to match the slower machines.
- **npm launcher.** The `kinako-cli` package provides the `kinako` command, downloads verified CLI archives from this repository, and uses `~/.kinako`. Update hints match npm, npx, pnpm, or Bun installs.
- **Own release workflow.** `fork-release.yml` builds macOS (signed and notarized), Windows, and Linux desktop installers plus CLI archives, publishes them to this repository's GitHub Releases, publishes `kinako-cli@nightly` to npm, and ends with an iOS build uploaded to TestFlight.

Upstream links that only open when you click them (marketing and legal pages) are left as-is. [FORK.md](./FORK.md) maps each change to the files it touches and covers merging upstream and cutting releases.

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
