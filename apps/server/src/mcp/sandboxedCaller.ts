import {
  type OrchestrationV2ThreadShell,
  OrchestratorMcpFailure,
  type ProjectAdditionalDirectory,
  resolveThreadAdditionalDirectoryPath,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";

import * as Project from "../project/ProjectService.ts";

const outside = (path: string) =>
  new OrchestratorMcpFailure({
    code: "invalid_request",
    message: `A thread in Sandboxed full access can only give a new thread folders inside its own workspace or additional directories, and ${path} is not one of them.`,
  });

/**
 * A sandboxed caller may hand a new thread only folders its own sandbox already grants, so it
 * cannot widen its reach through a sibling. Paths compare after symlinks resolve; the mode
 * runs only on Linux and macOS.
 */
export const assertWithinCallerSandbox = Effect.fn("mcp.assertWithinCallerSandbox")(function* (
  caller: OrchestrationV2ThreadShell | undefined,
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
  for (const root of [
    caller.worktreePath ?? project?.workspaceRoot,
    ...(caller.additionalDirectories ?? []).map(resolveThreadAdditionalDirectoryPath),
  ]) {
    const real = root === undefined ? undefined : yield* realPath(root);
    if (real !== undefined) roots.push(real);
  }
  for (const directory of directories) {
    const real = yield* realPath(directory.path);
    if (real === undefined || !roots.some((root) => real === root || real.startsWith(`${root}/`))) {
      return yield* outside(directory.path);
    }
  }
});
