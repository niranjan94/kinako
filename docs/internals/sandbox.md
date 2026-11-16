# Sandboxed full access

Sandboxed full access runs a provider with no approval prompts and wraps the whole provider process in an OS sandbox at spawn: bubblewrap on Linux, Seatbelt (`sandbox-exec`) on macOS. It restricts the filesystem only. The goal is to contain mistakes, not adversaries; user-facing limits are in [Permission modes](../user/permission-modes.md#sandboxed-full-access).

## One policy, two hand-built backends

[`sandboxPolicy.ts`](../../apps/server/src/sandbox/sandboxPolicy.ts) is the only place that decides what a thread can reach. It turns settings and the thread's paths into an ordered list of real paths, each read-write, read-only or hidden, where every entry follows the entries that contain it. [`Bubblewrap.ts`](../../apps/server/src/sandbox/Bubblewrap.ts) and [`Seatbelt.ts`](../../apps/server/src/sandbox/Seatbelt.ts) only translate that list, so both platforms enforce the same decision and tests can assert the exact bwrap arguments and profile text. Both backends rely on the ordering: bwrap applies mounts in argument order, so a nested bind lands inside its parent, and Seatbelt lets the last matching rule win, so a deeper entry overrides its parents.

The Seatbelt profile stays small on purpose. `sandbox-exec` compiles it on every launch, which takes about 0.3 s at 64 KiB and fails near 1 MB, so do not add per-file rules where a directory rule works.

A unix-socket `connect(2)` under Seatbelt checks both the path lookup and `network-outbound`, so masking a socket needs a rule for each. A hidden directory still needs its ancestors to be stat-able, because `realpath(3)` walks them.

## Fail closed

The no-approval behaviour belongs only to a process spawned inside the wrapper. Every layer that could lose the sandbox downgrades the thread to Supervised or fails instead of running unwrapped:

- [`RuntimePolicy.ts`](../../apps/server/src/orchestration-v2/RuntimePolicy.ts) passes the mode through only when the provider lists it in `supportedRuntimeModes` and its adapter declares `wrapsProcessInOsSandbox`; it then attaches the sandbox request.
- [`externalSandbox.ts`](../../apps/server/src/sandbox/externalSandbox.ts) is how adapters read that request. Without it, the Claude adapter (`claudeRuntimePolicyForPermissions`) and the Codex adapter (`codexRuntimePolicyForSession`) run the thread Supervised.
- [`sandboxLaunch.ts`](../../apps/server/src/sandbox/sandboxLaunch.ts) and `Sandbox.wrap` fail the session when the policy cannot be built or the sandbox cannot start. Nothing falls back to an unwrapped spawn.

A new provider joins by listing the mode, wrapping its process, and keeping that same shape.

## Sandboxed callers

A sandboxed thread's agent, or an MCP client approved for the mode, must not get work done outside a sandbox through T3 Code's own tools. Caller limits therefore compare with `isRuntimeModeWithinCallerLimit` in [`providerPolicy.ts`](../../packages/contracts/src/providerPolicy.ts), not with the rank order that managed ceilings use: `auto-accept-edits` and `auto` rank below sandboxed full access but run unsandboxed without asking, so a sandboxed caller reaches only sandboxed and Supervised threads.

A child's sandbox is built from its own project and checkout, so a sandboxed thread could also widen its reach by launching into another project, or into the main checkout from a worktree. [`sandboxedCaller.ts`](../../apps/server/src/mcp/sandboxedCaller.ts) keeps its launches in its own project, in its own checkout or a folder the launch creates, and keeps extra folders to ones its own sandbox grants. A client outside a thread has no sandbox of its own, so it may pick any project, but extra folders still come only from inside that project.

## Nothing nests

Neither sandbox can start another sandbox inside it. Tools that sandbox themselves fail inside, and so would the provider's own command sandbox, so adapters turn the provider's own sandbox off: Codex gets its `externalSandbox` policy and Claude gets `sandbox.enabled: false` in its settings ([`ClaudeAdapterV2.ts`](../../apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts)).

## Shared `/tmp`

`/tmp` inside the sandbox is the host's `/tmp`, not a private tmpfs. The server prepares per-thread directories there before the sandbox starts, such as the private tmux and screen socket directory in `sandboxLaunch.ts`, and files the agent leaves in `/tmp` stay visible to the user's own tools. The cost is that same-user sockets in `/tmp` are reachable. tmux, screen and zellij socket directories are hidden because a multiplexer server runs commands outside the sandbox, and every thread's private socket directory shares one parent that each sandbox hides except for its own. So is the desktop app's control socket directory, whose `open-workspace` request adds any folder as a project. bwrap cannot hide a path that does not exist yet, so `sandboxLaunch.ts` creates these directories before the policy is built, as the tools would; the multiplexer ones only on Linux, since Seatbelt can deny a path before it exists. A multiplexer server at a path the server's environment does not name stays reachable, as does screen's when the system keeps `/run/screen` closed to the user.

## bwrap starts with SIGTERM ignored

bwrap does not forward signals and does not survive SIGTERM, and when it dies `--die-with-parent` SIGKILLs the provider, which loses its chance to shut down. So bwrap starts with SIGTERM ignored, `env --default-signal=TERM` restores it for the provider, and the server stops a sandboxed session by signalling its process group. That is why the Linux requirement includes an `env` with `--default-signal`: GNU coreutils and uutils coreutils (the default `env` on recent Ubuntu) both restore SIGTERM this way, BusyBox's `env` has no such flag, and the availability probe runs `env --default-signal=TERM` inside bwrap so a missing flag shows as unavailable.

## Codex runs sandboxed threads in their own app-server

One Codex app-server normally serves many threads, but a sandbox wraps a whole process and each thread's policy differs (its cwd, worktree and project additions). The Codex adapter therefore lists the mode in `dedicatedSessionRuntimeModes`, and the [orchestrator](../../apps/server/src/orchestration-v2/Orchestrator.ts) (`providerSessionIdFor`) gives such threads a per-thread session instead of the shared one.

A mode change that crosses between the shared and dedicated classes moves the thread: the old session detaches once its running turn ends, and the next turn derives a session of the new class and resumes the same Codex thread there. This is why a mode change applies from the next turn.
