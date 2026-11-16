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
  type SandboxPolicy,
  type SandboxPolicyInput,
} from "./sandboxPolicy.ts";

export class SandboxPolicyRefusedError extends Schema.TaggedError<SandboxPolicyRefusedError>()(
  "SandboxPolicyRefusedError",
  { reason: Schema.String },
) {
  override get message(): string {
    return `The sandbox cannot be built: ${this.reason}`;
  }
}

export interface ResolveSandboxPolicyInput extends Omit<
  SandboxPolicyInput,
  "gitCommonDirs" | "providerPaths"
> {
  /** Directories are created when missing; files that do not exist are left out. */
  readonly providerPaths: ReadonlyArray<{
    readonly path: string;
    readonly kind: "directory" | "file";
  }>;
}

/** Turns one thread's inputs into a concrete policy, reading the filesystem and git. */
export const resolveSandboxPolicy = Effect.fn("SandboxPolicy.resolve")(function* (
  input: ResolveSandboxPolicyInput,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const runner = yield* ProcessRunner.ProcessRunner;

  for (const provider of input.providerPaths) {
    if (provider.kind !== "directory") continue;
    yield* fileSystem.makeDirectory(provider.path, { recursive: true }).pipe(
      Effect.mapError(
        (cause) =>
          new SandboxPolicyRefusedError({
            reason: `Could not create ${provider.path}: ${cause.message}`,
          }),
      ),
    );
  }

  const gitCommonDir = (directory: string) =>
    runner
      .run({
        command: "git",
        args: ["rev-parse", "--path-format=absolute", "--git-common-dir"],
        cwd: directory,
        timeout: "10 seconds",
      })
      .pipe(
        Effect.map((result) => (result.code === 0 ? result.stdout.trim() : "")),
        Effect.orElseSucceed(() => ""),
      );
  const gitCommonDirs = (yield* Effect.forEach(
    [input.cwd, ...input.additionalDirectories.map((directory) => directory.path)],
    gitCommonDir,
    { concurrency: 4 },
  )).filter((directory) => directory.length > 0);

  const policyInput: SandboxPolicyInput = {
    ...input,
    gitCommonDirs,
    providerPaths: input.providerPaths.map((provider) => provider.path),
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
    return { realPath, kind: info.type === "Directory" ? "directory" : "file" } as const;
  });
  const statPaths = new Set<string>([
    input.worktreesDir,
    ...candidates.map((candidate) => candidate.path),
    ...[...listings].flatMap(([directory, names]) =>
      names.map((name) => path.join(directory, name)),
    ),
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
    ? resolution.policy
    : yield* new SandboxPolicyRefusedError({ reason: resolution.reason });
}) satisfies (
  input: ResolveSandboxPolicyInput,
) => Effect.Effect<
  SandboxPolicy,
  SandboxPolicyRefusedError,
  FileSystem.FileSystem | Path.Path | ProcessRunner.ProcessRunner
>;
