import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";

export const SandboxPathList = Schema.Array(TrimmedNonEmptyString);
export type SandboxPathList = typeof SandboxPathList.Type;

/**
 * Filesystem access for threads in sandboxed full access. A null list follows the server
 * platform's defaults (`defaultSandboxPaths`); a list replaces them. Entries are absolute or
 * `~/` paths; only the last segment may hold a `*` wildcard.
 */
export const SandboxSettings = Schema.Struct({
  readWritePaths: Schema.NullOr(SandboxPathList).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  readOnlyPaths: Schema.NullOr(SandboxPathList).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  allowDocker: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  allowSshAgent: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
});
export type SandboxSettings = typeof SandboxSettings.Type;

export const SandboxSettingsPatch = Schema.Struct({
  readWritePaths: Schema.optionalKey(Schema.NullOr(SandboxPathList)),
  readOnlyPaths: Schema.optionalKey(Schema.NullOr(SandboxPathList)),
  allowDocker: Schema.optionalKey(Schema.Boolean),
  allowSshAgent: Schema.optionalKey(Schema.Boolean),
});
export type SandboxSettingsPatch = typeof SandboxSettingsPatch.Type;

/** Paths a project adds to the environment's lists; it cannot remove any. */
export const ProjectSandboxOverride = Schema.Struct({
  readWritePaths: Schema.optionalKey(SandboxPathList),
  readOnlyPaths: Schema.optionalKey(SandboxPathList),
});
export type ProjectSandboxOverride = typeof ProjectSandboxOverride.Type;

export type SandboxPlatform = "linux" | "darwin";

const SHARED_READ_WRITE_PATHS = [
  "~/.local/state/pnpm",
  "~/.npm",
  // Not ~/.gradle itself: its init scripts and gradle.properties apply to every build.
  "~/.gradle/caches",
  "~/.gradle/wrapper",
  "~/.gradle/daemon",
  "~/.gradle/native",
  "~/.gradle/jdks",
  "~/.gradle/notifications",
  "~/.gradle/.tmp",
  "~/.aws-sam",
  "~/.ssh/known_hosts",
  "~/.cargo/registry",
  "~/.cargo/git",
  "~/go/pkg/mod",
  "~/.bun/install/cache",
];

const SHARED_READ_ONLY_PATHS = [
  "~/.gradle",
  "~/.gitconfig",
  "~/.config/git",
  "~/.ssh/config",
  "~/.ssh/*.pub",
  "~/.local/bin",
  "~/.nvm",
  "~/.fnm",
  "~/.local/share/fnm",
  "~/.local/share/vite-plus",
  "~/.local/share/mise",
  "~/.volta",
  "~/.cargo",
  "~/.rustup",
  "~/.bun",
  "~/.deno",
  "~/go",
  "~/.pyenv",
  "~/.local/share/uv",
  "~/.sdkman",
];

/** The lists a null setting stands for on `platform`. Missing paths are skipped when resolved. */
export function defaultSandboxPaths(platform: SandboxPlatform): {
  readonly readWritePaths: SandboxPathList;
  readonly readOnlyPaths: SandboxPathList;
} {
  return {
    // pnpm's home holds its global bin dir and the pnpm versions it runs; only the store is written.
    readWritePaths:
      platform === "darwin"
        ? ["~/Library/pnpm/store", "~/Library/Caches", ...SHARED_READ_WRITE_PATHS]
        : ["~/.local/share/pnpm/store", "~/.cache", ...SHARED_READ_WRITE_PATHS],
    readOnlyPaths:
      platform === "darwin"
        ? ["~/Library/pnpm", "~/Library/Preferences/pnpm", "~/.npmrc", ...SHARED_READ_ONLY_PATHS]
        : ["~/.local/share/pnpm", ...SHARED_READ_ONLY_PATHS],
  };
}

/** Whether this environment can run sandboxed full access, with the server's reason when not. */
export const SandboxStatus = Schema.Struct({
  available: Schema.Boolean,
  reason: Schema.optionalKey(Schema.String),
});
export type SandboxStatus = typeof SandboxStatus.Type;

export const SandboxPathCheckInput = Schema.Struct({
  readWritePaths: SandboxPathList,
  readOnlyPaths: SandboxPathList,
});
export type SandboxPathCheckInput = typeof SandboxPathCheckInput.Type;

/** A listed path the sandbox leaves out, with the resolver's reason. */
export const SandboxRejectedPath = Schema.Struct({
  path: Schema.String,
  list: Schema.Literals(["read-write", "read-only"]),
  reason: Schema.String,
});
export type SandboxRejectedPath = typeof SandboxRejectedPath.Type;

/** A listed path the sandbox keeps that needs attention, such as one that does not exist. */
export const SandboxPathWarning = SandboxRejectedPath;
export type SandboxPathWarning = typeof SandboxPathWarning.Type;

export const SandboxPathCheckResult = Schema.Struct({
  rejected: Schema.Array(SandboxRejectedPath),
  warnings: Schema.Array(SandboxPathWarning).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
});
export type SandboxPathCheckResult = typeof SandboxPathCheckResult.Type;
