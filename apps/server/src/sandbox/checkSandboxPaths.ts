import {
  defaultSandboxPaths,
  type SandboxPathCheckInput,
  type SandboxPathCheckResult,
  type SandboxRejectedPath,
  type SandboxStatus,
} from "@t3tools/contracts";
import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import * as ServerConfig from "../config.ts";
import { resolveSandboxPolicy } from "./resolveSandboxPolicy.ts";
import * as Sandbox from "./Sandbox.ts";
import type { SandboxRejectedEntry } from "./sandboxPolicy.ts";

/** The cached probe result in the form clients read. */
export const sandboxStatus = Effect.fn("Sandbox.status")(function* () {
  const availability = yield* (yield* Sandbox.Sandbox).availability;
  return (
    availability._tag === "Available"
      ? { available: true }
      : { available: false, reason: availability.reason }
  ) satisfies SandboxStatus;
});

/** Which of the given setting paths the sandbox would leave out or warn about, and why. */
export const checkSandboxPaths = Effect.fn("Sandbox.checkPaths")(function* (
  input: SandboxPathCheckInput,
) {
  const platform = yield* HostProcess.Platform;
  if (platform !== "linux" && platform !== "darwin") {
    return { rejected: [], warnings: [] } satisfies SandboxPathCheckResult;
  }
  const config = yield* ServerConfig.ServerConfig;
  yield* (yield* FileSystem.FileSystem)
    .makeDirectory(config.worktreesDir, { recursive: true })
    .pipe(Effect.ignore);
  const home = yield* HostProcess.HomeDirectory;
  const policy = yield* resolveSandboxPolicy({
    platform,
    home,
    uid: (yield* HostProcess.UserId) ?? -1,
    // Rejecting a listed path does not depend on the thread, so any directory a thread may
    // work in serves as the working directory.
    cwd: config.worktreesDir,
    additionalDirectories: [],
    providerPaths: [],
    attachmentsDir: config.attachmentsDir,
    serverPaths: [],
    baseDir: config.baseDir,
    worktreesDir: config.worktreesDir,
    gitCheckouts: [],
    pathEnv: undefined,
    tmpDir: undefined,
    sshAuthSock: undefined,
    settings: {
      readWritePaths: input.readWritePaths,
      readOnlyPaths: input.readOnlyPaths,
      allowDocker: false,
      allowSshAgent: false,
    },
  }).pipe(
    Effect.tapError((error) => Effect.logWarning("Sandbox path check failed", { error })),
    Effect.orElseSucceed(() => undefined),
  );
  const listed = (entry: SandboxRejectedEntry): ReadonlyArray<SandboxRejectedPath> => {
    if (entry.source === "user-read-write")
      return [{ path: entry.path, list: "read-write", reason: entry.reason }];
    if (entry.source === "user-read-only")
      return [{ path: entry.path, list: "read-only", reason: entry.reason }];
    return [];
  };
  // Many defaults name tools a machine does not have, so their absence is expected.
  const defaults = defaultSandboxPaths(platform);
  const defaultPaths = new Set(
    [...defaults.readWritePaths, ...defaults.readOnlyPaths].map((path) =>
      expandHomePath(path, home),
    ),
  );
  return {
    rejected: (policy?.rejected ?? []).flatMap(listed),
    warnings: (policy?.warnings ?? [])
      .filter((entry) => !defaultPaths.has(entry.path))
      .flatMap(listed),
  } satisfies SandboxPathCheckResult;
});
