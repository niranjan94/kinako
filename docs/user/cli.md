# CLI reference (`kinako`)

The `kinako` command runs and manages T3 Code servers, background services, remote access, threads, workflows, and diagnostics. Run `kinako --help` or `kinako <command> --help` for full flags.

See [Install T3 Code](./install.md#command-line) for installation (`curl -fsSL https://t3.codes/install.sh | sh`, `irm https://t3.codes/install.ps1 | iex`, or `npx t3@latest`).

## Running and connecting

| Command                          | Description                                                                                                  |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `kinako [path]` / `kinako start` | Start a foreground server and open the web app (optionally in a project directory).                          |
| `kinako serve`                   | Start the server without opening a browser (`--lan`, `--tailscale-serve`, `--host`, `--port`, `--base-dir`). |
| `kinako app [path]`              | Open a directory as a project/thread in the running desktop app.                                             |
| `kinako up`                      | Interactive setup for remote access and the background service (`--lan`, `--no-lan`, `--yes`).               |
| `kinako status`                  | Show how other devices can reach this host (`--json`).                                                       |
| `kinako pair`                    | Generate a one-time pairing URL / QR code (`--tailscale`, `--scope <scope>`).                                |

## Background service and updates

| Command                               | Description                                                                                                                                         |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `kinako service`                      | Manage the background service (`install`, `status`, `restart`, `uninstall`, `protect [--undo]`). See [Background service](./background-service.md). |
| `kinako update [version]`             | Update `kinako` and the service (`--channel nightly`, `--allow-downgrade`, `--yes`).                                                                |
| `kinako install` / `kinako uninstall` | Install or remove the `kinako` launcher and background service (keeps `~/.kinako/userdata`).                                                        |

## Threads, projects, and workflows

| Command           | Description                                                                                                                                                                                                   |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `kinako thread`   | Script threads on the host (`start`, `send`, `show`, `list`; supports `--wait`, `--json`, `--worktree`, `--provider`, `--model`, `--option`). See [Host scripts](./outside-agents.md#host-scripts-t3-thread). |
| `kinako project`  | Manage projects on the host (e.g. `kinako project add <path> --track <folder>`).                                                                                                                              |
| `kinako workflow` | Start and steer durable workflows (`start`, `list`, `show`, `resume`, `cancel`, `questions`, `signal`, `withdraw`, `hooks`, `store`). See [Workflows](./workflows.md).                                        |

## Environments, auth, themes, and policy

| Command              | Description                                                                                                                               |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `kinako environment` | Link or manage peer environments (`kinako environment link <addr> --pairing-code <code> --access <mode>`, `--from <file>`).               |
| `kinako auth`        | Manage pairing codes and sessions (`pairing create`, `session list/revoke/issue`).                                                        |
| `kinako theme`       | Manage server-published themes (`set <id>`, `clear`, `show`). See [Appearance](./appearance.md#environment-themes).                       |
| `kinako policy`      | Validate, inspect, and generate MDM/GPO templates for [managed policies](./managed-policy.md) (`check`, `show`, `settings`, `templates`). |

## Diagnostics and maintenance

| Command                | Description                                                                                                |
| ---------------------- | ---------------------------------------------------------------------------------------------------------- |
| `kinako doctor`        | Inspect database size and reclaim disk space (`--dry-run`, `--fix`).                                       |
| `kinako browser setup` | One-time Linux host setup (AppArmor sandbox profile, libraries, fonts) for the headless preview browser.   |
| `kinako trace summary` | Summarize local server trace latency and errors (`--since 30m`, `--limit 50`).                             |
| `kinako triage`        | Launch Claude Code, Codex, or Antigravity in your terminal with the T3 triage playbook.                    |
| `kinako feedback`      | Send or inspect agent feedback reports (`list [--json]`, `--kind`, `--subject`, `--expected`, `--actual`). |
