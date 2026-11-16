import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ProcessRunner from "../processRunner.ts";
import {
  MAX_SANDBOX_REASON_LENGTH,
  type SandboxAvailability,
  type SandboxedCommand,
  type SandboxPolicy,
  type SandboxPolicyEntry,
  SandboxUnavailableError,
} from "./sandboxPolicy.ts";

const SANDBOX_EXEC = "/usr/bin/sandbox-exec";

/** sandbox-exec refuses compiled profiles over 64 KiB; the source length is the bound we check. */
const SEATBELT_PROFILE_LIMIT_BYTES = 65_535;

/**
 * Setuid binaries such as `ps` cannot be exec'd under a non-trivial profile. This exempts
 * `/bin/ps` with SBPL's `no-sandbox` exec modifier. Unverified on a Mac, so it stays off.
 */
const EXEMPT_PS_FROM_SANDBOX = false;

const DEVICE_WRITES = [
  '(literal "/dev/null")',
  '(literal "/dev/zero")',
  '(literal "/dev/dtracehelper")',
  '(subpath "/dev/fd")',
  '(literal "/dev/tty")',
  '(regex #"^/dev/ttys[0-9]+$")',
  '(literal "/dev/ptmx")',
];

const sbplString = (value: string) => `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;

const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export type SeatbeltProfile =
  | { readonly _tag: "Built"; readonly profile: string }
  | { readonly _tag: "Refused"; readonly reason: string };

function entryFilter(entry: SandboxPolicyEntry): string | undefined {
  if (entry.kind === "directory") return `(subpath ${sbplString(entry.path)})`;
  if (entry.kind === "socket" || entry.access !== "read-write") {
    return `(literal ${sbplString(entry.path)})`;
  }
  // Writers such as Claude Code and ssh replace these files through a sibling temp file.
  if (/["\n]/.test(entry.path)) return undefined;
  return `(regex #"^${escapeRegex(entry.path)}($|\\.)")`;
}

const isWithin = (path: string, root: string) =>
  path === root || root === "/" || path.startsWith(`${root}/`);

/**
 * An SBPL profile that applies `policy`. The last matching rule wins, so rules start from the
 * broad ones and follow the policy's order, which lists every entry after the entries containing
 * it: a deeper entry overrides its parents the way a nested mount does on Linux.
 */
export function seatbeltProfile(policy: SandboxPolicy): SeatbeltProfile {
  const rules = [
    "(version 1)",
    "(allow default)",
    '(deny file-write* (subpath "/"))',
    `(allow file-write-data file-ioctl ${DEVICE_WRITES.join(" ")})`,
  ];
  for (const [index, entry] of policy.entries.entries()) {
    const filter = entryFilter(entry);
    if (filter === undefined) {
      return {
        _tag: "Refused",
        reason: `The path ${JSON.stringify(entry.path)} cannot be matched.`,
      };
    }
    if (entry.access === "hidden") {
      rules.push(`(deny file-read* file-test-existence file-write* ${filter})`);
      continue;
    }
    const underHidden = policy.entries
      .slice(0, index)
      .some(
        (parent) =>
          parent.access === "hidden" &&
          parent.kind === "directory" &&
          isWithin(entry.path, parent.path),
      );
    // realpath(3) needs to stat every ancestor, including the hidden ones.
    if (underHidden) {
      rules.push(
        `(allow file-read-metadata file-test-existence (path-ancestors ${sbplString(entry.path)}))`,
      );
    }
    rules.push(
      entry.access === "read-write"
        ? `(allow file-read* file-test-existence file-write* ${filter})`
        : `(allow file-read* file-test-existence ${filter})`,
    );
  }
  rules.push("(deny signal)", "(allow signal (target same-sandbox))");
  if (EXEMPT_PS_FROM_SANDBOX) {
    rules.push('(allow process-exec (literal "/bin/ps") (with no-sandbox))');
  }
  const profile = rules.join("\n");
  const bytes = new TextEncoder().encode(profile).length;
  return bytes > SEATBELT_PROFILE_LIMIT_BYTES
    ? {
        _tag: "Refused",
        reason: `The sandbox profile is ${bytes} bytes, over the ${SEATBELT_PROFILE_LIMIT_BYTES}-byte limit. Remove entries from the sandbox path lists.`,
      }
    : { _tag: "Built", profile };
}

const PROBE_POLICY: SandboxPolicy = {
  platform: "darwin",
  cwd: "/",
  entries: [{ path: "/private/tmp", access: "hidden", kind: "directory", source: "temp" }],
  rejected: [],
};

export class Seatbelt extends Context.Service<
  Seatbelt,
  {
    /** Runs sandbox-exec once per server with a profile of the shape real launches use. */
    readonly availability: Effect.Effect<SandboxAvailability>;
    /** The command that runs `input` inside `policy`. Fails rather than run it unsandboxed. */
    readonly wrap: (
      input: SandboxedCommand & { readonly policy: SandboxPolicy },
    ) => Effect.Effect<SandboxedCommand, SandboxUnavailableError>;
  }
>()("t3/sandbox/Seatbelt") {}

const make = Effect.fn("Seatbelt.make")(function* () {
  const platform = yield* HostProcess.Platform;
  const runner = yield* ProcessRunner.ProcessRunner;

  const probe = Effect.fn("Seatbelt.probe")(function* () {
    if (platform !== "darwin") {
      return { _tag: "Unavailable", reason: "Seatbelt only runs on macOS." } as const;
    }
    const built = seatbeltProfile(PROBE_POLICY);
    if (built._tag === "Refused") return { _tag: "Unavailable", reason: built.reason } as const;
    const result = yield* runner
      .run({
        command: SANDBOX_EXEC,
        args: ["-p", built.profile, "/usr/bin/true"],
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
      ? ({ _tag: "Available", command: SANDBOX_EXEC } as const)
      : ({
          _tag: "Unavailable",
          reason: (stderr.trim() || `sandbox-exec exited with code ${code}.`).slice(
            0,
            MAX_SANDBOX_REASON_LENGTH,
          ),
        } as const);
  });
  const availability = yield* Effect.cached(probe());

  const wrap = Effect.fn("Seatbelt.wrap")(function* (
    input: SandboxedCommand & { readonly policy: SandboxPolicy },
  ) {
    if (input.policy.platform !== "darwin") {
      return yield* new SandboxUnavailableError({
        reason: "This policy is not for a macOS sandbox.",
      });
    }
    const available = yield* availability;
    if (available._tag === "Unavailable") {
      return yield* new SandboxUnavailableError({ reason: available.reason });
    }
    const built = seatbeltProfile(input.policy);
    if (built._tag === "Refused") {
      return yield* new SandboxUnavailableError({ reason: built.reason });
    }
    return {
      command: available.command,
      args: ["-p", built.profile, input.command, ...input.args],
      env: input.env,
    };
  });

  return Seatbelt.of({ availability, wrap });
});

export const layer = Layer.effect(Seatbelt, make());
