import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as ProcessRunner from "../processRunner.ts";
import {
  resolveSandboxPolicy as resolveFromFacts,
  sandboxCandidates,
  sandboxWildcardDirectories,
  type SandboxPathFact,
  type SandboxRejectedEntry,
  type SandboxPolicy,
  type SandboxPolicyInput,
} from "./sandboxPolicy.ts";

export class SandboxPolicyRefusedError extends Schema.TaggedError<SandboxPolicyRefusedError>()(
  "SandboxPolicyRefusedError",
  { reason: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {
  override get message(): string {
    return `The sandbox cannot be built: ${this.reason}`;
  }
}

export interface ResolveSandboxPolicyInput extends Omit<
  SandboxPolicyInput,
  "gitCommonDirs" | "providerPaths" | "darwinUserCacheDir" | "gitExcludesFile"
> {
  /** Checkouts paired with the repositories the server knows they come from. */
  readonly gitCheckouts: ReadonlyArray<{ readonly checkout: string; readonly repository: string }>;
  /** Read-write directories are created when missing; other missing paths are left out. */
  readonly providerPaths: ReadonlyArray<{
    readonly path: string;
    readonly kind: "directory" | "file";
    readonly access: "read-write" | "read-only";
  }>;
}

/** Turns one thread's inputs into a concrete policy, reading the filesystem and git. */
export const resolveSandboxPolicy = Effect.fn("SandboxPolicy.resolve")(function* (
  input: ResolveSandboxPolicyInput,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const runner = yield* ProcessRunner.ProcessRunner;
  const hostEnvironment = yield* HostProcess.Environment;

  for (const provider of input.providerPaths) {
    if (provider.kind !== "directory" || provider.access !== "read-write") continue;
    yield* fileSystem.makeDirectory(provider.path, { recursive: true }).pipe(
      Effect.mapError(
        (cause) =>
          new SandboxPolicyRefusedError({
            reason: `Could not create the provider directory ${provider.path}.`,
            cause,
          }),
      ),
    );
  }

  const output = (command: string, args: ReadonlyArray<string>, cwd?: string) =>
    runner
      .run({
        command,
        args,
        cwd,
        env: { ...hostEnvironment, HOME: input.home },
        timeout: "10 seconds",
      })
      .pipe(
        Effect.map((result) => (result.code === 0 ? result.stdout.trim() : "")),
        Effect.orElseSucceed(() => ""),
      );
  const gitExcludesFile = yield* output("git", [
    "config",
    "--global",
    "--get",
    "core.excludesfile",
  ]);
  const darwinUserCacheDir =
    input.platform === "darwin" ? yield* output("getconf", ["DARWIN_USER_CACHE_DIR"]) : "";
  // The agent can rewrite a checkout's `.git` file, so it only says whether the checkout is a
  // linked worktree; the git dir granted is always the server-known repository's own.
  const gitCommonDirs: Array<string> = [];
  const droppedGitDirs: Array<SandboxRejectedEntry> = [];
  for (const { checkout, repository } of input.gitCheckouts) {
    if (path.resolve(checkout) === path.resolve(repository)) continue;
    const checkoutGit = yield* fileSystem
      .stat(path.join(checkout, ".git"))
      .pipe(Effect.orElseSucceed(() => undefined));
    if (checkoutGit?.type !== "File") continue;
    const gitDir = path.join(repository, ".git");
    const isLink = yield* fileSystem.readLink(gitDir).pipe(
      Effect.as(true),
      Effect.orElseSucceed(() => false),
    );
    const info = yield* fileSystem.stat(gitDir).pipe(Effect.orElseSucceed(() => undefined));
    if (isLink || info?.type !== "Directory") {
      droppedGitDirs.push({
        path: gitDir,
        source: "git-common-dir",
        reason: "The repository's git dir is not a plain directory, so it is not granted.",
      });
      continue;
    }
    gitCommonDirs.push(gitDir);
  }

  const policyInput: SandboxPolicyInput = {
    ...input,
    gitCommonDirs,
    providerPaths: input.providerPaths.map(({ path, access }) => ({ path, access })),
    ...(gitExcludesFile.length === 0
      ? {}
      : { gitExcludesFile: expandHomePath(gitExcludesFile, input.home) }),
    ...(darwinUserCacheDir.length === 0 ? {} : { darwinUserCacheDir }),
  };
  const candidates = sandboxCandidates(policyInput);

  const listings = new Map<string, ReadonlyArray<string>>();
  for (const directory of sandboxWildcardDirectories(candidates)) {
    listings.set(
      directory,
      yield* fileSystem.readDirectory(directory).pipe(Effect.orElseSucceed(() => [])),
    );
  }

  const probe = Effect.fnUntraced(function* (candidatePath: string) {
    const realPath = yield* fileSystem.realPath(candidatePath);
    const info = yield* fileSystem.stat(realPath);
    const kind =
      info.type === "Directory" ? "directory" : info.type === "Socket" ? "socket" : "file";
    return { realPath, kind } as const;
  });
  const statPaths = new Set<string>([
    input.worktreesDir,
    ...candidates.map((candidate) => candidate.path),
    ...[...listings].flatMap(([directory, names]) =>
      names.map((name) => path.join(directory, name)),
    ),
    // A Docker socket missing at launch is masked at its real location, found from its parents.
    ...candidates.flatMap((candidate) => {
      if (candidate.source !== "docker") return [];
      const parents: Array<string> = [];
      for (let parent = path.dirname(candidate.path); parent !== "/";) {
        parents.push(parent);
        parent = path.dirname(parent);
      }
      return parents;
    }),
  ]);
  const facts = new Map<string, SandboxPathFact>();
  for (const candidatePath of statPaths) {
    if (candidatePath.includes("*")) continue;
    const fact = yield* probe(candidatePath).pipe(Effect.option);
    if (fact._tag === "Some") facts.set(candidatePath, fact.value);
  }

  const resolution = resolveFromFacts(policyInput, {
    stat: (candidatePath) => facts.get(candidatePath),
    list: (directory) => listings.get(directory) ?? [],
  });
  return resolution._tag === "Resolved"
    ? { ...resolution.policy, rejected: [...droppedGitDirs, ...resolution.policy.rejected] }
    : yield* new SandboxPolicyRefusedError({ reason: resolution.reason });
}) satisfies (
  input: ResolveSandboxPolicyInput,
) => Effect.Effect<
  SandboxPolicy,
  SandboxPolicyRefusedError,
  FileSystem.FileSystem | Path.Path | ProcessRunner.ProcessRunner
>;
