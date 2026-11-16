# Permission modes

Permission modes control when an agent needs your approval to act. Choose a mode in the message
composer; it applies to that thread. A new thread names its mode under the composer. In a thread
on your default mode, open the model picker and choose **Permissions** at its bottom, or press
`mod+shift+a`. A thread on another mode shows the mode next to the model.

Set the default for new threads in **Settings → Threads → New threads → Permissions**.
Projects can override the environment default. New threads use this setting rather than the
mode of the thread you were viewing. The initial default is **Full access**; existing threads
and modes you choose in a draft keep their permissions.

| Mode                      | Behavior                                                                                                                                                                            |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Supervised**            | Requests approval for commands and file changes.                                                                                                                                    |
| **Auto-accept edits**     | Approves file edits automatically; other actions can still require approval.                                                                                                        |
| **Auto**                  | Uses the provider's automatic review to approve routine actions and ask about others.                                                                                               |
| **Sandboxed full access** | Allows commands and edits without approval prompts, with file access limited to the project, temp folders and paths you allow. See [Sandboxed full access](#sandboxed-full-access). |
| **Full access**           | Allows commands and edits without approval prompts.                                                                                                                                 |

An administrator can cap the modes available on a machine with a
[managed policy](./managed-policy.md#permission-modes); modes above the cap show who manages them.

Approve or reject requests in the conversation to let the agent continue. Permission modes do
not prevent the agent from asking questions about the task. Subagent approval requests appear in
the parent conversation with the subagent's name, so you can respond without switching threads.

## Provider differences

Providers enforce permissions differently. Some read-only actions can proceed in **Supervised**.
**Auto** uses automatic review on Codex, Claude, Cursor, Grok, and fx; providers without an equivalent,
including OpenCode and Antigravity, fall back to asking. On Grok, commands its review blocks come
to you for approval. On fx, prompts it still sends also come to you.

Muse Code offers only **Supervised** and **Full access**. A Muse thread already set to another mode
runs in **Supervised**.

T3 Code offers no **Auto-accept edits** or **Full access** for fx. An fx thread already set to either runs in
**Supervised**.

Grok offers no **Auto-accept edits**. A Grok thread already set to it runs in **Supervised**. Grok
file-change approvals offer **Allow all edits this session**. Its command approvals have no
session-wide choice, because Grok would remember that command for the whole project.

ACP Registry agents run their own tools in their own mode; T3 Code answers their approval requests
by the permission mode. See [ACP Registry permissions](./providers-acp.md#permissions-and-terminals).

Claude can still ask in **Full access** when its settings disable bypass permissions or require
approval for an action. Dangerous-removal safety checks in bypass mode reject the command with
the original warning. Claude can use a safe rewrite when the warning supplies one; otherwise it
continues without the removal and tells you what it skipped.
While a Claude approval is pending, type a text reply to decline that request and give feedback
directly to the agent that asked, including a subagent. Other pending requests stay unanswered.

Antigravity can still send native approval requests in **Full access**. It only offers remembered
approvals for actions that support them.

Only Claude and Codex run **Sandboxed full access**, and only on Linux and macOS. Every other provider, and Claude and Codex on Windows, runs a thread in that mode as **Supervised**.

Kiro offers only **Supervised** and **Full access**. In **Supervised** Kiro also asks you to
review a turn's file changes. See [Kiro permissions](./providers-kiro.md#permission-modes).

See the [provider guides](./install.md#providers) for setup and provider-specific limits.

## Sandboxed full access

**Sandboxed full access** works like **Full access**, with no approval prompts, but the agent runs inside a filesystem sandbox on the machine that runs the thread. It is meant to contain mistakes, such as a command that deletes or rewrites files outside the project. It is not a security boundary against a determined or compromised agent: the network stays open, and the routes listed under [What stays reachable](#what-stays-reachable) remain.

Claude and Codex support it when the thread's machine runs Linux or macOS. Other providers run a thread in this mode as **Supervised**, and the composer says so. When the machine cannot start the sandbox, the mode shows as unavailable with the reason.

An agent in this mode can start, message and steer only threads in **Sandboxed full access** or **Supervised**. **Auto-accept edits** and **Auto** skip approvals outside any sandbox, so they stay out of its reach, and a thread it starts with a provider that lacks this mode runs as **Supervised**. The threads and scheduled tasks it starts stay in its own project, and a new thread works in the agent's own checkout or a new worktree.

### What the agent can read and write

By default, a sandboxed agent can:

- Read and write the thread's project folder or worktree, the git folder of the repository a worktree came from, the thread's additional directories, temp folders, and the provider's own folder, such as `~/.claude` or `~/.codex`, apart from the provider's own installation inside it.
- Read and write package manager caches and similar folders, such as `~/.npm`, `~/.cache`, pnpm's store, Gradle's caches, `~/.cargo/registry`, `~/go/pkg/mod`, and `~/.ssh/known_hosts`.
- Read everything outside your home folder, plus home paths tools need, such as `~/.gitconfig`, `~/.ssh/config`, your public SSH keys, `~/.gradle`, pnpm's home folder, toolchains such as `~/.nvm`, `~/.cargo`, and `~/.rustup`, and folders on your `PATH`.

Folders on your `PATH` stay read-only even inside a folder the agent may write, unless they are inside the thread's project, so the agent cannot put a program there that you or T3 Code later run.

The rest of your home folder, including your private SSH keys and the app's own data folder, is hidden. Cargo's publishing tokens in `~/.cargo/credentials.toml` and git's stored passwords in `~/.config/git/credentials` stay hidden too, unless you list that file; on Linux this covers a token file that exists when the session starts, and one created later, for example by `cargo login`, is readable until the session restarts.

The network is open, so the sandbox keeps files outside the allowed paths from being changed but does not stop the agent sending anything it can read off the machine: SSH keys, cloud credentials such as `~/.aws`, Cargo publishing tokens, and git's stored passwords stay hidden, but files builds read, such as `~/.gradle/gradle.properties` and, on macOS, `~/.npmrc`, stay readable and can hold tokens.

To change the lists, open **Settings → Threads → Sandboxed full access** and choose an environment. Each list shows that environment's defaults until you edit it; editing saves the whole list, and the reset button returns to the defaults. Paths are absolute or start with `~/`, and only the last part of a path may contain a `*`, such as `~/.ssh/*.pub`. A path the sandbox leaves out, such as one that would expose your whole home folder, is listed under its list with the reason. A path that does not exist yet, or that may expose credentials such as `~/.ssh` or `~/.aws`, is kept but shown with a warning.

To add paths for one project, choose that project in the settings scope. A project can add paths to either list but cannot remove the environment's.

### Docker and the SSH agent

- **Docker in the sandbox** is off by default. Turning it on lets the agent use Docker, and Docker access is equivalent to full access to the machine, because a container can mount any folder.
- **SSH agent in the sandbox** is on by default. It lets the agent use the keys your ssh-agent holds, for example to push with git, without being able to read them.

With Docker off on Linux, a system Docker socket that exists when the session starts is masked, and rootless Docker sockets in your runtime folder are always hidden. A system socket that appears or is recreated after the session starts, for example when Docker restarts, is reachable until the session restarts. On macOS, Docker sockets stay masked even when they appear later.

### What stays reachable

The sandbox limits what the agent can change, not what runs later from what it changed. These still run outside the sandbox and can carry the agent's changes:

- **Your project.** Its scripts, build files, git hooks and `.git/config` take effect when you build, test or use git. T3 Code's own git work, such as status and checkpoints, skips the repository's hooks and `core.fsmonitor`. Commits, pushes, pulls, branch switches and new worktrees run its hooks, as git does in a terminal, including a worktree the agent asks T3 Code to create. A filter that `.gitattributes` names runs whenever git reads or writes those files, and the background fetch that keeps branch status current uses the repository's own `core.sshCommand` and credential helpers.
- **Caches that tools reuse**, such as `~/.npm` (including the packages `npx` keeps), `~/.cache`, pnpm's store, Gradle's caches, `~/.cargo/registry` and `~/go/pkg/mod`. A tool that trusts what it cached uses it in your next build.
- **The provider's own folder**, such as `~/.claude` or `~/.codex`, whose settings, hooks and MCP servers the provider reads when it runs outside the sandbox.

The sandbox also leaves open:

- The network, without restrictions.
- Sockets your user owns in temp folders, other than tmux, screen and zellij sessions in their default locations, the desktop app's control socket, and on Linux the X display's socket folder.
- On Linux, the X display through its abstract socket. Sandboxed tools do not get `DISPLAY`, but a program that sets it can reach your desktop where the X server trusts your user, as it does on GNOME.

### Requirements

On Linux, install bubblewrap (`bwrap`) and have an `env` that supports `--default-signal`. GNU coreutils and uutils coreutils both provide one; BusyBox's `env` does not. On macOS, nothing extra is needed. If a requirement is missing, the mode shows as unavailable with the reason.

### Known limits

- Tools that start a sandbox of their own do not work inside, such as Chromium or Playwright without `--no-sandbox`, rootless Podman, and the provider's own command sandbox.
- On macOS, setuid tools other than `ps` do not run.
- zellij does not run inside. tmux and screen do, in sessions separate from yours.
- The agent can change what is inside a folder it may write, but not remove, rename or replace the folder itself, so `rm -rf ~/.npm` leaves an empty `~/.npm` behind.
- Tools cannot install or update themselves from inside, such as `pnpm add -g`, pnpm fetching the version a project pins, or a provider updating itself. Run those outside the sandbox.
- A folder the sandbox reaches through a symbolic link inside a folder the agent can write, such as an additional directory that is a link inside the project, must point inside that folder, or the session does not start. Add the folder the link points to instead. A listed path reached that way is left out with the reason.
- On Linux, Claude does not save its `~/.claude.json` bookkeeping from sandboxed sessions.
- Changing a thread to or from this mode, or changing what the sandbox allows, applies from the thread's next turn.
- Older app versions cannot show threads in this mode. Update every client, including mobile, before you use it.

### Commit signing

When git signs commits with an SSH key file, commits fail inside the sandbox because the private key is hidden. Git prints `error: No private key found for public key "<path>"?` and then `fatal: failed to write commit object`.

To fix it, load the key into an ssh-agent that the server can see and keep **SSH agent in the sandbox** on; git then signs through the agent. Alternatively, add the key file to the read-only list, which makes the private key readable by the agent. Signing helpers that bring their own agent, such as 1Password, need their agent socket added to the read-only list.
