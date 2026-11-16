import * as HostProcess from "@t3tools/shared/HostProcess";
import { resolveCommandPath } from "@t3tools/shared/shell";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ProcessRunner from "../processRunner.ts";
import {
  MAX_SANDBOX_REASON_LENGTH,
  type SandboxAvailability,
  type SandboxedCommand,
  type SandboxPolicy,
  SandboxUnavailableError,
} from "./sandboxPolicy.ts";

/**
 * bwrap arguments that apply `policy`. Mount operations run in order, and the policy lists
 * every entry after the entries containing it, so nested binds land inside their parents.
 * Hidden directories become tmpfs mounts remounted read-only once everything inside them is
 * bound, so stray writes fail instead of vanishing.
 */
export function bubblewrapArgs(policy: SandboxPolicy): ReadonlyArray<string> {
  const mounts = policy.entries.flatMap((entry): ReadonlyArray<string> => {
    switch (entry.access) {
      case "read-write":
        return ["--bind", entry.path, entry.path];
      case "read-only":
        return ["--ro-bind", entry.path, entry.path];
      case "hidden":
        return entry.kind === "directory"
          ? ["--tmpfs", entry.path]
          : ["--ro-bind", "/dev/null", entry.path];
    }
  });
  const remounts = policy.entries.flatMap((entry) =>
    entry.access === "hidden" && entry.kind === "directory" ? ["--remount-ro", entry.path] : [],
  );
  return [
    "--die-with-parent",
    "--unshare-pid",
    "--ro-bind",
    "/",
    "/",
    "--dev",
    "/dev",
    "--proc",
    "/proc",
    ...mounts,
    ...remounts,
    "--chdir",
    policy.cwd,
  ];
}

/**
 * bwrap neither forwards signals nor survives SIGTERM, and when it dies `--die-with-parent`
 * SIGKILLs the command. So bwrap starts with SIGTERM ignored, and `env --default-signal`
 * restores it for the command, which then gets SIGTERM sent to the process group.
 */
const IGNORE_TERM_SCRIPT = `trap '' TERM; exec "$@"`;

function sandboxedCommand(
  tools: { readonly bwrap: string; readonly env: string },
  policy: SandboxPolicy,
  command: string,
  args: ReadonlyArray<string>,
): { readonly command: string; readonly args: ReadonlyArray<string> } {
  return {
    command: "/bin/sh",
    args: [
      "-c",
      IGNORE_TERM_SCRIPT,
      "kinako-sandbox",
      tools.bwrap,
      ...bubblewrapArgs(policy),
      "--",
      tools.env,
      "--default-signal=TERM",
      command,
      ...args,
    ],
  };
}

const PROBE_POLICY: SandboxPolicy = {
  platform: "linux",
  cwd: "/",
  entries: [{ path: "/tmp", access: "hidden", kind: "directory", source: "temp" }],
  rejected: [],
};

export class Bubblewrap extends Context.Service<
  Bubblewrap,
  {
    /** Runs bwrap once per server; AppArmor can refuse it even when it is on PATH. */
    readonly availability: Effect.Effect<SandboxAvailability>;
    /**
     * The command that runs `input` inside `policy`. Fails rather than run it unsandboxed.
     * Stop it by signalling its process group: SIGTERM to its pid alone is ignored.
     */
    readonly wrap: (
      input: SandboxedCommand & { readonly policy: SandboxPolicy },
    ) => Effect.Effect<SandboxedCommand, SandboxUnavailableError>;
  }
>()("t3/sandbox/Bubblewrap") {}

export const make = Effect.fn("Bubblewrap.make")(function* (options?: {
  readonly command?: string;
}) {
  const platform = yield* HostProcess.Platform;
  const runner = yield* ProcessRunner.ProcessRunner;
  const resolved = yield* resolveCommandPath(options?.command ?? "bwrap").pipe(
    Effect.orElseSucceed(() => null),
  );
  const env = yield* resolveCommandPath("env").pipe(Effect.orElseSucceed(() => null));

  const probe = Effect.fn("Bubblewrap.probe")(function* () {
    if (platform !== "linux") {
      return { _tag: "Unavailable", reason: "bubblewrap only runs on Linux." } as const;
    }
    if (resolved === null) {
      return { _tag: "Unavailable", reason: "bwrap was not found on PATH." } as const;
    }
    if (env === null) {
      return { _tag: "Unavailable", reason: "env was not found on PATH." } as const;
    }
    const result = yield* runner
      .run({
        ...sandboxedCommand({ bwrap: resolved, env }, PROBE_POLICY, "true", []),
        timeout: "10 seconds",
      })
      .pipe(Effect.result);
    if (result._tag === "Failure") {
      return {
        _tag: "Unavailable",
        reason: result.failure.message.slice(0, MAX_SANDBOX_REASON_LENGTH),
      } as const;
    }
    const { code, stderr } = result.success;
    return code === 0
      ? ({ _tag: "Available", command: resolved } as const)
      : ({
          _tag: "Unavailable",
          reason: (stderr.trim() || `bwrap exited with code ${code}.`).slice(
            0,
            MAX_SANDBOX_REASON_LENGTH,
          ),
        } as const);
  });
  const availability = yield* Effect.cached(probe());

  const wrap = Effect.fn("Bubblewrap.wrap")(function* (
    input: SandboxedCommand & { readonly policy: SandboxPolicy },
  ) {
    if (input.policy.platform !== "linux") {
      return yield* new SandboxUnavailableError({
        reason: "This policy is not for a Linux sandbox.",
      });
    }
    const available = yield* availability;
    if (available._tag === "Unavailable" || env === null) {
      return yield* new SandboxUnavailableError({
        reason: available._tag === "Unavailable" ? available.reason : "env was not found on PATH.",
      });
    }
    return {
      ...sandboxedCommand(
        { bwrap: available.command, env },
        input.policy,
        input.command,
        input.args,
      ),
      env: input.env,
    };
  });

  return Bubblewrap.of({ availability, wrap });
});

export const layer = Layer.effect(Bubblewrap, make());
