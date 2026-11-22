# Permission modes

Permission modes control when an agent needs your approval to act. Choose a mode in the message
composer; it applies to that thread. A new thread names its mode under the composer. In a thread
on your default mode, open the model picker and choose **Permissions** at its bottom, or press
`mod+shift+a`. A thread on another mode shows the mode next to the model.

Set the default for new threads in **Settings → Threads → New threads → Permissions**.
Projects can override the environment default. New threads use this setting rather than the
mode of the thread you were viewing. The initial default is **Full access**; existing threads
and modes you choose in a draft keep their permissions.

| Mode                  | Behavior                                                                                |
| --------------------- | --------------------------------------------------------------------------------------- |
| **Supervised**        | Requests approval for commands and file changes.                                        |
| **Auto-accept edits** | Approves file edits automatically; other actions can still require approval.            |
| **Auto**              | Uses the provider's automatic review to approve routine actions and ask about others.   |
| **Kinako Auto**       | Kinako reviews each request: routine local actions run, and it asks you about the rest. |
| **Full access**       | Allows commands and edits without approval prompts.                                     |

An administrator can cap the modes available on a machine with a
[managed policy](./managed-policy.md#permission-modes); modes above the cap show who manages them.

Approve or reject requests in the conversation to let the agent continue. Permission modes do
not prevent the agent from asking questions about the task. Subagent approval requests appear in
the parent conversation with the subagent's name, so you can respond without switching threads.

## Kinako Auto

**Kinako Auto** works the same way on every provider that sends approval requests, including ones
without their own **Auto**, such as Pi, Kiro, Muse Code, and ACP Registry agents. Cursor does not
offer it, because Cursor settles approvals itself.

Kinako first applies fixed rules. It never approves access to credentials, `.env` files, git
hooks, or system files, privileged commands such as `sudo`, pushes, publishes, merges, or changes
outside the thread's workspace and its project's [folders](./multi-repo-projects.md); those always come to you. Reads, edits, and
build, test, and inspection commands inside the workspace run without asking. Anything else goes
to a reviewer model, which sees your recent messages and the requested action, never file
contents or command output. If the reviewer is unsure, slow, or unavailable, the request comes to
you.

The provider's own sandbox still applies. Where the provider has its own **Auto**, that review
runs first and Kinako only reviews what it hands back. Codex and Claude are the exception: their
automatic review answers inside the provider, so under **Kinako Auto** they run as **Auto-accept
edits** and Kinako reviews the commands they ask about.

Requests waiting on the review show **Kinako Auto is reviewing** and do not notify you; you can
still answer them yourself. A request handed to you shows the reason, and actions Kinako approved
appear in the conversation as **Approved by Kinako Auto**. Kinako approves each action once,
never for the rest of a session.

Choose the reviewer in **Settings → Threads → Kinako Auto**: a provider model, a text generator,
a decision API, or rules only. By default it uses the text generation model. Projects can choose
their own reviewer and add instructions for it. Add a decision API such as TypeSafe's System One
in **Settings → Providers → Decision APIs**; it only reviews approvals and never writes text.

## Provider differences

Providers enforce permissions differently. Some read-only actions can proceed in **Supervised**.
**Auto** uses automatic review on Codex, Claude, Cursor, Grok, Antigravity, and fx; providers without
an equivalent, including OpenCode, fall back to asking. On Grok and Antigravity, actions their review
does not approve come to you for approval. On fx, prompts it still sends also come to you.

Antigravity offers **Auto** only when your Antigravity sign-in provides its Auto mode; some accounts,
including some personal Google accounts, do not. Without it, an Antigravity thread already set to
**Auto** runs in **Supervised**.

Muse Code offers only **Supervised**, **Kinako Auto**, and **Full access**. A Muse thread already set
to another mode runs in **Supervised**.

T3 Code offers no **Auto-accept edits** for fx, and **Full access** only with fx 0.0.14 or later. An fx
thread set to a mode its fx lacks runs in **Supervised**.

Grok offers no **Auto-accept edits**. A Grok thread already set to it runs in **Supervised**. Grok
file-change approvals offer **Allow all edits this session**. Its command approvals have no
session-wide choice, because Grok would remember that command for the whole project.

ACP Registry agents run their own tools in their own mode; T3 Code answers their approval requests
by the permission mode. ACP Registry agents have no shared automatic review, so in **Auto** their
requests come to you as in **Supervised**. See
[ACP Registry permissions](./providers-acp.md#permissions-and-terminals).

Claude can still ask in **Full access** when its settings disable bypass permissions or require
approval for an action. Dangerous-removal safety checks in bypass mode reject the command with
the original warning. Claude can use a safe rewrite when the warning supplies one; otherwise it
continues without the removal and tells you what it skipped.
While a Claude approval is pending, type a text reply to decline that request and give feedback
directly to the agent that asked, including a subagent. Other pending requests stay unanswered.

Antigravity can still send native approval requests in **Full access**. It only offers remembered
approvals for actions that support them.

Kiro offers only **Supervised**, **Kinako Auto**, and **Full access**. Kiro approvals that offer
only a standing approval always come to you under **Kinako Auto**. In **Supervised** Kiro also asks you to
review a turn's file changes. See [Kiro permissions](./providers-kiro.md#permission-modes).

See the [provider guides](./install.md#providers) for setup and provider-specific limits.
