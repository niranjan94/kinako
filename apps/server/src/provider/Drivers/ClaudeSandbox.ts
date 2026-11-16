import type { SandboxPlatform } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { resolveCommandPath } from "@t3tools/shared/shell";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import type { SandboxRequest } from "../../sandbox/externalSandbox.ts";
import {
  resolveSandboxPolicy,
  SandboxPolicyRefusedError,
} from "../../sandbox/resolveSandboxPolicy.ts";
import * as Sandbox from "../../sandbox/Sandbox.ts";

/**
 * Whether a Keychain login can refresh its token with read-only access to `~/Library/Keychains`
 * is unverified, so the Keychain stays read-only until a Mac shows it needs more.
 */
const CLAUDE_MACOS_KEYCHAIN_ACCESS: "read-only" | "read-write" = "read-only";

export interface ClaudeSandboxPath {
  readonly path: string;
  readonly kind: "directory" | "file";
  readonly access: "read-write" | "read-only";
}

/** What Claude Code reads and writes outside the workspace, per platform. */
export function claudeSandboxPaths(input: {
  readonly platform: SandboxPlatform;
  readonly home: string;
  /** The configured `homePath`, `CLAUDE_CONFIG_DIR`, or `~/.claude`. */
  readonly configDir: string;
  /** The real path of the executable that will run. */
  readonly executable: string;
}): ReadonlyArray<ClaudeSandboxPath> {
  const inHome = (relative: string) => `${input.home}/${relative}`;
  return [
    { path: input.configDir, kind: "directory", access: "read-write" },
    // Claude replaces this through a sibling temp file, which a single-file bind cannot take on Linux.
    { path: inHome(".claude.json"), kind: "file", access: "read-write" },
    { path: inHome(".local/state/claude"), kind: "directory", access: "read-write" },
    { path: inHome(".local/share/claude"), kind: "directory", access: "read-only" },
    { path: inHome(".local/bin"), kind: "directory", access: "read-only" },
    { path: inHome(".config/anthropic"), kind: "directory", access: "read-only" },
    {
      path: input.executable.slice(0, input.executable.lastIndexOf("/")) || "/",
      kind: "directory",
      access: "read-only",
    },
    ...(input.platform === "darwin"
      ? [
          {
            path: inHome("Library/Keychains"),
            kind: "directory" as const,
            access: CLAUDE_MACOS_KEYCHAIN_ACCESS,
          },
          {
            path: inHome("Library/Preferences/com.apple.security.plist"),
            kind: "file" as const,
            access: "read-only" as const,
          },
        ]
      : []),
  ];
}

const CLAUDE_SCRIPT_EXTENSIONS = [".js", ".mjs", ".tsx", ".ts", ".jsx"];

/**
 * The command that starts `executable` inside the thread's sandbox. Fails, so the turn fails,
 * whenever the sandbox cannot be built or applied.
 */
export const sandboxClaudeLaunch = Effect.fn("ClaudeSandbox.launch")(function* (input: {
  readonly request: SandboxRequest;
  readonly cwd: string;
  readonly additionalDirectories: ReadonlyArray<string>;
  readonly configDir?: string | undefined;
  readonly executable: string;
  readonly env: NodeJS.ProcessEnv;
}) {
  const platform = yield* HostProcess.Platform;
  if (platform !== "linux" && platform !== "darwin") {
    return yield* new SandboxPolicyRefusedError({
      reason: "The filesystem sandbox only runs on Linux and macOS.",
    });
  }
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* HostProcess.HomeDirectory;
  const uid = (yield* HostProcess.UserId) ?? -1;
  const resolved = yield* resolveCommandPath(input.executable, { env: input.env }).pipe(
    Effect.orElseSucceed(() => null),
  );
  const executable =
    resolved === null
      ? undefined
      : yield* fileSystem.realPath(resolved).pipe(Effect.orElseSucceed(() => undefined));
  if (executable === undefined) {
    return yield* new SandboxPolicyRefusedError({
      reason: `Claude's executable ${input.executable} was not found.`,
    });
  }
  if (CLAUDE_SCRIPT_EXTENSIONS.some((extension) => executable.endsWith(extension))) {
    return yield* new SandboxPolicyRefusedError({
      reason: `Claude's executable ${executable} is a script; the sandbox needs the native executable.`,
    });
  }
  const policy = yield* resolveSandboxPolicy({
    platform,
    home,
    uid,
    cwd: input.cwd,
    additionalDirectories: input.additionalDirectories.map((directory) => ({
      path: path.resolve(input.cwd, directory),
      access: "read-write",
    })),
    providerPaths: claudeSandboxPaths({
      platform,
      home,
      configDir: input.configDir ?? input.env.CLAUDE_CONFIG_DIR ?? path.join(home, ".claude"),
      executable,
    }),
    ...input.request,
    pathEnv: input.env.PATH,
    tmpDir: input.env.TMPDIR,
    sshAuthSock: input.env.SSH_AUTH_SOCK,
  });
  const sandbox = yield* Sandbox.Sandbox;
  return yield* sandbox.wrap({ command: executable, args: [], env: input.env, policy });
});
