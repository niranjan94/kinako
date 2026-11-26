# Claude

T3 Code drives your Claude Code installation, login, skills, and plugins. See [provider setup](./install.md#providers) for initial installation.

## Multiple accounts and presets

Isolate separate Claude accounts or router presets with distinct `CLAUDE_CONFIG_DIR` directories:

```bash
mkdir -p ~/.claude_personal
CLAUDE_CONFIG_DIR=~/.claude_personal claude auth login
```

Add a second Claude instance in **Settings → Providers** (or **Add Claude account** on mobile) pointing **CLAUDE_CONFIG_DIR path** to `~/.claude_personal` (leave empty for the default directory). Always use `CLAUDE_CONFIG_DIR` rather than `HOME` so system keychain paths stay intact.

- Existing threads can only switch between Claude instances sharing the same config directory.
- Put API keys and endpoint overrides in **Environment variables** (not **Launch arguments**).
- Paths in `--settings` and `--append-system-prompt-file` expand `~` to the server's home directory; other relative paths resolve from the thread's workspace.

## Compact long conversations

- **Auto-compact threshold**: Set **Auto-compact after** (`100000`–`1000000` tokens) in the Claude instance settings to trigger summarization earlier without changing the model's context window.
- **Manual compaction**: Send `/compact` in chat.
- **Idle compaction (>200k tokens)**: Configure **Settings → Providers → Advanced → Compact idle threads** (overridable per instance):
  - **When you return** (default): Shows a **Compact** chip next to Send once Claude's prompt cache expires (~1 hour on subscriptions, 5 min on API/Bedrock/Vertex). Click it to switch to **Keep** if you want full history.
  - **Before the cache expires (beta)**: Automatically sends `/compact` shortly before the cache expires while history is still cached (falls back to **When you return** if missed).
  - **Never**: Disables idle compaction prompts.

## Steering, usage limits, and tasks

- **Steering**: Steered messages wait until Claude finishes its active tool calls, then enter the same turn (or queue for the next turn if Claude exits or drops them).
- **Usage limits**: Mid-turn limit hits display the window and reset time; Claude holds the turn until reset, or you can stop and resume later.
- **Task lists**: Add `CLAUDE_CODE_ENABLE_TODO_TOOLS=1` in the instance's **Environment → Variables** to show Claude's task list progress in web and desktop threads.
- **Auto mode**: Uses Claude Code's native auto mode (disabled if `disableAutoMode` is set in Claude's managed, user, or project settings). See [Permission modes](./permission-modes.md).

## Skills and MCP sign-in

- **Skills**: Loaded from `<CLAUDE_CONFIG_DIR>/skills`, the project's `.claude/skills` (config dir wins on name collisions), and enabled Claude plugins (e.g. `plugin:review`). Invoke via `$`. Send `disable-model-invocation` skills one per message.
- **MCP OAuth**: When a Claude MCP server needs sign-in, click **Sign in** on the thread notice, approve in your browser, and paste the final redirect URL into T3 Code (**Finish sign-in**). Connectors added on `claude.ai` authenticate there instead.

## Continue a thread in Claude Code

To pick up a Claude thread in a terminal, open the thread's menu in the chat header or sidebar and choose **Copy > CLI resume command**, or search the command palette for **Copy CLI resume command**. On mobile, long-press the thread. The command changes into the thread's folder and runs `claude --resume` with the thread's session, using the instance's binary and config directory.

Run it on the machine Kinako's server runs on, and not while the thread is working in Kinako. Claude Code's `/resume` picker does not list sessions started from Kinako, so use the copied command instead of searching for the session there. The option is unavailable after you roll a Claude thread back, until its next turn finishes.

For a Claude provider managed by CLIProxyAPI, continue the thread in Kinako so it can use the hub credential.

## Bring a Claude Code session into Kinako

To continue a session you started with `claude` in a terminal, search the command palette for **Import CLI session** while in the project, or open the project's settings and choose **Import** under **Terminal sessions**. With per-project thread trees enabled, the project's menu in the sidebar has it too. On mobile, start a new task in the project and choose **Import CLI session**. The list shows sessions started from the project's folder under the instance's config directory, newest first. Importing one opens a thread with the session's earlier messages, and its next turn continues the same Claude Code session. Importing a session again opens its existing thread.

Close the session in the terminal before importing it. A session updated in the last few minutes is marked as possibly still open. The earlier part of the conversation shows its text only, and turns from before the import cannot be diffed or restored. Sessions started from Kinako, from upstream T3 Code, or from other apps built on the Claude Agent SDK are not listed.

To bring in sessions from all your folders at once, search the command palette for **Import CLI history**, choose **Import CLI history** when adding a project, or open a project's settings and choose it under **Terminal sessions**. On mobile, start a new task and choose **Import CLI history**. It lists every folder with Claude Code or Codex sessions on the computer the environment runs on, from the last 30 days or a longer period you choose. Select whole folders to import every session in the period, or on desktop and web expand a folder to pick sessions. Folders without a project are added as projects. Sessions import one at a time: **Stop after current** keeps what already finished, and **Retry failed** tries only what failed, showing each failure's reason. Sessions that already have a thread, in any project, are skipped, so running it again is safe, and sessions that may still be open in a terminal are left out unless you pick them. Folders that no longer exist are not listed.

## Claude in Chrome

To use the [Claude in Chrome extension](https://code.claude.com/docs/en/chrome) in T3 Code threads, add `--chrome` to **Launch arguments** in the Claude instance settings (applies to new sessions). Requires a direct Anthropic `/login` plan—not supported with API keys, `setup-token`, Bedrock/Vertex, or WSL.

## OpenRouter and local routers

Create a separate Claude instance with its own config directory (e.g. `~/.claude_openrouter`, after running `/logout` if it had a cached Anthropic login) and set **Environment variables**:

| Variable               | Value                                    |
| ---------------------- | ---------------------------------------- |
| `ANTHROPIC_BASE_URL`   | `https://openrouter.ai/api`              |
| `ANTHROPIC_AUTH_TOKEN` | Your OpenRouter API key (mark Sensitive) |
| `ANTHROPIC_API_KEY`    | Explicitly empty                         |

Add unlisted OpenRouter models via **Add custom model** in the instance settings. See the [OpenRouter Claude Code guide](https://openrouter.ai/docs/cookbook/coding-agents/claude-code-integration) or [Claude Code Router](https://github.com/musistudio/claude-code-router) for local router setup.
