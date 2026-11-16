import {
  type OrchestrationV2ThreadLaunchWorkspaceStrategy,
  type OrchestrationV2ThreadShell,
  OrchestratorMcpFailure,
  type ProjectAdditionalDirectory,
  type ProjectId,
  resolveThreadAdditionalDirectoryPath,
  type RuntimeMode,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";

import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as Project from "../project/ProjectService.ts";

/** A client from outside a thread, limited to Sandboxed full access, launching into `projectId`. */
export interface SandboxedClientCaller {
  readonly runtimeMode: RuntimeMode;
  readonly projectId: ProjectId;
}

const outside = (caller: OrchestrationV2ThreadShell | SandboxedClientCaller, path: string) =>
  new OrchestratorMcpFailure({
    code: "invalid_request",
    message:
      "id" in caller
        ? `A thread in Sandboxed full access can only give a new thread folders inside its own workspace or additional directories, and ${path} is not one of them.`
        : `A client limited to Sandboxed full access can only give a new thread folders inside the project or its additional directories, and ${path} is not one of them.`,
  });

const isSandboxedThread = (
  caller: Pick<OrchestrationV2ThreadShell, "runtimeMode"> | undefined,
): caller is Pick<OrchestrationV2ThreadShell, "runtimeMode"> =>
  caller?.runtimeMode === "sandboxed-full-access";

/**
 * A sandboxed thread starts work only in its own project, whose folders its sandbox already
 * grants. Clients outside a thread have no sandbox of their own to stay inside.
 */
export const assertCallerProject = (
  caller: Pick<OrchestrationV2ThreadShell, "runtimeMode" | "projectId"> | undefined,
  projectId: ProjectId | "scratch",
) =>
  !isSandboxedThread(caller) || projectId === caller.projectId
    ? Effect.void
    : Effect.fail(
        new OrchestratorMcpFailure({
          code: "invalid_request",
          message: `A thread in Sandboxed full access can start work only in its own project. Omit ${projectId === "scratch" ? "scratch" : "projectId"}.`,
        }),
      );

/**
 * A sandboxed thread binds a new thread to its own checkout or to a folder the launch creates,
 * so a worktree thread cannot reach the main checkout through it. Paths compare after symlinks
 * resolve.
 */
export const assertCallerCheckout = Effect.fn("mcp.assertCallerCheckout")(function* (
  caller: Pick<OrchestrationV2ThreadShell, "runtimeMode" | "worktreePath"> | undefined,
  launch: {
    readonly projectId: ProjectId;
    readonly workspaceRoot: string;
    readonly workspaceStrategy: OrchestrationV2ThreadLaunchWorkspaceStrategy | undefined;
  },
) {
  if (!isSandboxedThread(caller)) return;
  const strategy = launch.workspaceStrategy ?? { type: "root" };
  if (strategy.type === "worktree") return;
  const folders = yield* ManagedProjectFolders.ManagedProjectFolders;
  // Every Scratch thread launched at the root gets a new folder of its own.
  if (strategy.type === "root" && (yield* folders.isScratchProject(launch.projectId))) return;
  const fileSystem = yield* FileSystem.FileSystem;
  const realPath = (path: string) =>
    fileSystem.realPath(path).pipe(Effect.orElseSucceed(() => undefined));
  const own = caller.worktreePath ?? launch.workspaceRoot;
  const checkout =
    strategy.type === "existing_worktree" ? strategy.worktreePath : launch.workspaceRoot;
  const [ownReal, checkoutReal] = [yield* realPath(own), yield* realPath(checkout)];
  if (ownReal !== undefined && ownReal === checkoutReal) return;
  return yield* new OrchestratorMcpFailure({
    code: "invalid_request",
    message: `A thread in Sandboxed full access can start a thread only in its own checkout, ${own}, or a new worktree. Pass workspaceStrategy {type: "existing_worktree", worktreePath: "${own}"} or {type: "worktree", baseRef}.`,
  });
});

/**
 * A sandboxed caller may hand a new thread only folders its own sandbox already grants, so it
 * cannot widen its reach through a sibling. A client has no sandbox of its own, so it gets the
 * target project's folders. Paths compare after symlinks resolve; the mode runs only on Linux
 * and macOS.
 */
export const assertWithinCallerSandbox = Effect.fn("mcp.assertWithinCallerSandbox")(function* (
  caller: OrchestrationV2ThreadShell | SandboxedClientCaller | undefined,
  directories: ReadonlyArray<ProjectAdditionalDirectory> | undefined,
) {
  if (
    caller === undefined ||
    caller.runtimeMode !== "sandboxed-full-access" ||
    directories === undefined ||
    directories.length === 0
  ) {
    return;
  }
  const fileSystem = yield* FileSystem.FileSystem;
  const project = yield* Project.ProjectService.pipe(
    Effect.flatMap((projects) => projects.getById(caller.projectId)),
    Effect.map(Option.getOrUndefined),
    Effect.orElseSucceed(() => undefined),
  );
  const realPath = (candidate: string) =>
    fileSystem.realPath(candidate).pipe(Effect.orElseSucceed(() => undefined));
  const roots: Array<string> = [];
  const thread = "id" in caller ? caller : undefined;
  for (const root of [
    thread?.worktreePath ?? project?.workspaceRoot,
    ...(thread === undefined
      ? (project?.additionalDirectories ?? []).map((directory) => directory.path)
      : (thread.additionalDirectories ?? []).map(resolveThreadAdditionalDirectoryPath)),
  ]) {
    const real = root === undefined ? undefined : yield* realPath(root);
    if (real !== undefined) roots.push(real);
  }
  for (const directory of directories) {
    const real = yield* realPath(directory.path);
    if (real === undefined || !roots.some((root) => real === root || real.startsWith(`${root}/`))) {
      return yield* outside(caller, directory.path);
    }
  }
});
