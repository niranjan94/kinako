import type { SandboxPlatform } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";

import type { SandboxRequest } from "../../sandbox/externalSandbox.ts";
import { sandboxProviderLaunch } from "../../sandbox/sandboxLaunch.ts";

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

/** The command that starts Claude inside the thread's sandbox, or a failure that ends the turn. */
export const sandboxClaudeLaunch = Effect.fn("ClaudeSandbox.launch")(function* (input: {
  readonly request: SandboxRequest;
  readonly cwd: string;
  readonly additionalDirectories: ReadonlyArray<string>;
  readonly configDir?: string | undefined;
  readonly executable: string;
  readonly env: NodeJS.ProcessEnv;
}) {
  const path = yield* Path.Path;
  return yield* sandboxProviderLaunch({
    providerName: "Claude",
    request: input.request,
    cwd: input.cwd,
    additionalDirectories: input.additionalDirectories,
    executable: input.executable,
    env: input.env,
    providerPaths: ({ platform, home, executable }) =>
      Effect.succeed(
        claudeSandboxPaths({
          platform,
          home,
          configDir: input.configDir ?? input.env.CLAUDE_CONFIG_DIR ?? path.join(home, ".claude"),
          executable,
        }),
      ),
  });
});
