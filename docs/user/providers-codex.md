# Codex

Use your ChatGPT plan or an existing Codex CLI login to run Codex in T3 Code.

## Connect with ChatGPT

Connect during onboarding or in **Settings → Providers** (select your target environment first for remote machines). T3 Code manages the Codex runtime and signs you in via OpenAI.

- Manage shared usage and credits through **Manage usage** in T3 Code.
- **Remote sign-in**: If sign-in doesn't return automatically, paste the full `localhost` redirect URL into the sign-in panel.
- **Speed options**: Fast and Ultrafast speeds are not available through ChatGPT sharing—[use an existing Codex login](#use-an-existing-codex-login) instead.
- Disconnecting stops running threads while preserving history.

## Use an existing Codex login

Run `codex login` on the environment's machine, then add a Codex instance in **Settings → Providers** via **Configure manually**. See [provider setup](./install.md#providers) for installation details.

If provider status checks time out on a slower machine, set `T3CODE_CODEX_PROBE_TIMEOUT_MS=60000` in the server environment and restart. See [Provider check timeouts](./install.md#provider-check-timeouts).

## Use multiple accounts

Add another ChatGPT account in **Settings → Providers**, or configure multiple CLI logins with a **shadow home** so work and personal accounts can continue the same threads:

```bash
mkdir -p ~/.codex_personal
CODEX_HOME=~/.codex_personal codex login
```

| Instance       | CODEX_HOME path | Shadow home path    |
| -------------- | --------------- | ------------------- |
| Codex Work     | `~/.codex`      | _(leave empty)_     |
| Codex Personal | `~/.codex`      | `~/.codex_personal` |

- Both instances must share the same **CODEX_HOME path**. Keep the shadow directory fresh—don't copy your full Codex home into it.
- The shadow account needs file-based credential storage (`auth.json`); see [OpenAI's credential storage guide](https://learn.chatgpt.com/docs/auth#credential-storage).
- Use a separate **CODEX_HOME path** (no shadow home) if you want completely isolated sessions.

To switch accounts mid-thread, pick another compatible Codex instance sharing the same **CODEX_HOME path** from the model picker.

## Features and options

- **Image generation**: Supported when your Codex version, model, and account allow it. If disabled in Codex config, add `-c features.image_generation=true` to the instance's **Launch arguments** (applies to new sessions).
- **Async questions**: Codex can ask a question while continuing to work; answer in the question panel (steers the active turn or starts a new one) or dismiss it without sending.
- **App access approvals**: Respond to external app access requests directly in chat (one-time, session, or permanent depending on the tool).
- **MCP OAuth sign-in**: Click **Sign in** on the thread notice, approve in your browser, and paste the final redirect URL into **Finish sign-in** (requires provider management permission).
- **Daybreak**: Models with cyber access programs show a **Cyber Access** option (`Standard` or `Daybreak`, initialized from `daybreak = true` in `config.toml`).
- **Usage limits**: Limit stops display the exhausted window, reset time, and (on workspace plans) whether credits or spend limits need adjustment.
- **Feedback to OpenAI**: Send `/feedback <description>` in an existing Codex thread to upload conversation and Codex logs to OpenAI.

## OpenAI Chrome extension

Using your signed-in Chrome profile via [OpenAI's Chrome extension](https://learn.chatgpt.com/docs/chrome-extension) requires a browser connection for the Codex thread. For remote environments, forward the remote page's port or use a reachable URL—T3 Code's built-in preview browser uses its own separate session.

## Continue a thread in the Codex CLI

To pick up a Codex thread in a terminal, open the thread's menu in the chat header or sidebar and choose **Copy > CLI resume command**, or search the command palette for **Copy CLI resume command**. On mobile, long-press the thread. The command changes into the thread's folder and runs `codex resume` with the thread's session, using the instance's binary and home, including its shadow home. Run it on the machine Kinako's server runs on, and not while the thread is working in Kinako.

## Bring a Codex CLI session into Kinako

To continue a session you started with `codex` in a terminal, search the command palette for **Import CLI session** while in the project, or open the project's settings and choose **Import** under **Terminal sessions**. With per-project thread trees enabled, the project's menu in the sidebar has it too. On mobile, start a new task in the project and choose **Import CLI session**. The list shows sessions started from the project's folder under the instance's Codex home, newest first. Importing one opens a thread with the session's earlier messages, and its next turn resumes the same Codex session. Importing a session again opens its existing thread.

Close the session in the terminal before importing it. A session updated in the last few minutes is marked as possibly still open. The earlier part of the conversation shows its text only, and turns from before the import cannot be diffed or restored. Sessions started from Kinako or from upstream T3 Code, and Codex sub-agent sessions, are not listed.

To bring in sessions from all your folders at once, search the command palette for **Import CLI history**, choose **Import CLI history** when adding a project, or open a project's settings and choose it under **Terminal sessions**. On mobile, start a new task and choose **Import CLI history**. It lists every folder with Claude Code or Codex sessions on the computer the environment runs on, from the last 30 days or a longer period you choose. Select whole folders to import every session in the period, or on desktop and web expand a folder to pick sessions. Folders without a project are added as projects. Sessions import one at a time: **Stop after current** keeps what already finished, and **Retry failed** tries only what failed, showing each failure's reason. Sessions that already have a thread, in any project, are skipped, so running it again is safe, and sessions that may still be open in a terminal are left out unless you pick them. Folders that no longer exist are not listed.
