import { resolveSelfInvocation } from "@t3tools/shared/nodeRuntime";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import type { SandboxRequest } from "../../sandbox/externalSandbox.ts";
import { sandboxProviderLaunch } from "../../sandbox/sandboxLaunch.ts";

export interface CodexSandboxPath {
  readonly path: string;
  readonly kind: "directory" | "file";
  readonly access: "read-write" | "read-only";
}

/** What Codex reads and writes outside the workspace. */
export function codexSandboxPaths(input: {
  /** The CODEX_HOME the app-server runs with, then any shared home a shadow home links into. */
  readonly homes: ReadonlyArray<string>;
  /** The real path of the executable that will run. */
  readonly executable: string;
  /** A Kinako checkout or install a managed Codex runs for its token command. */
  readonly selfInvocationRoot?: string | undefined;
}): ReadonlyArray<CodexSandboxPath> {
  return [
    ...input.homes.map((path) => ({
      path,
      kind: "directory" as const,
      access: "read-write" as const,
    })),
    {
      path: input.executable.slice(0, input.executable.lastIndexOf("/")) || "/",
      kind: "directory",
      access: "read-only",
    },
    ...(input.selfInvocationRoot === undefined
      ? []
      : [
          {
            path: input.selfInvocationRoot,
            kind: "directory" as const,
            access: "read-only" as const,
          },
        ]),
  ];
}

/**
 * The checkout or install whose entrypoint a managed Codex runs for tokens: the outermost
 * ancestor below home holding `node_modules`, since a workspace links packages from there.
 */
const selfInvocationRoot = Effect.fn("CodexSandbox.selfInvocationRoot")(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* HostProcess.HomeDirectory;
  const { entrypoint } = yield* resolveSelfInvocation();
  if (entrypoint === undefined) return undefined;
  let root: string | undefined;
  for (
    let directory = path.dirname(entrypoint);
    directory !== home && directory !== path.dirname(directory);
    directory = path.dirname(directory)
  ) {
    if (
      yield* fileSystem
        .exists(path.join(directory, "node_modules"))
        .pipe(Effect.orElseSucceed(() => false))
    ) {
      root = directory;
    }
  }
  return root ?? path.dirname(entrypoint);
});

/** The app-server command inside the thread's sandbox, or a failure that ends the session. */
export const sandboxCodexLaunch = Effect.fn("CodexSandbox.launch")(function* (input: {
  readonly request: SandboxRequest;
  readonly cwd: string;
  readonly additionalDirectories: ReadonlyArray<string>;
  readonly executable: string;
  readonly args: ReadonlyArray<string>;
  readonly env: NodeJS.ProcessEnv;
  /** The configured shared home a shadow CODEX_HOME links into, never read from those links. */
  readonly sharedHomePath?: string | undefined;
  readonly managed: boolean;
}) {
  const path = yield* Path.Path;
  return yield* sandboxProviderLaunch({
    providerName: "Codex",
    request: input.request,
    cwd: input.cwd,
    additionalDirectories: input.additionalDirectories,
    executable: input.executable,
    args: input.args,
    env: input.env,
    providerPaths: Effect.fn("CodexSandbox.providerPaths")(function* ({ home, executable }) {
      const codexHome = input.env.CODEX_HOME ?? path.join(home, ".codex");
      return codexSandboxPaths({
        homes: [
          codexHome,
          ...(input.sharedHomePath === undefined || input.sharedHomePath === codexHome
            ? []
            : [input.sharedHomePath]),
        ],
        executable,
        selfInvocationRoot: input.managed ? yield* selfInvocationRoot() : undefined,
      });
    }),
  });
});
