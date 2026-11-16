import {
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
