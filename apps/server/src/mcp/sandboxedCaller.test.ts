import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { type OrchestrationV2ThreadShell, ProjectId, type RuntimeMode } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import * as Project from "../project/ProjectService.ts";
import { assertWithinCallerSandbox } from "./sandboxedCaller.ts";

it.effect("keeps a sandboxed caller's new threads inside its own folders", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const root = yield* fileSystem.realPath(
      yield* fileSystem.makeTempDirectoryScoped({ prefix: "kinako-sandboxed-caller-" }),
    );
    for (const directory of ["project/src", "docs/guide", "secret"]) {
      yield* fileSystem.makeDirectory(`${root}/${directory}`, { recursive: true });
    }
    yield* fileSystem.symlink(`${root}/secret`, `${root}/project/escape`);
    const callerIn = (runtimeMode: RuntimeMode) =>
      ({
        projectId: ProjectId.make("project"),
        runtimeMode,
        worktreePath: `${root}/project`,
        additionalDirectories: [
          { path: `${root}/docs`, mode: "local", branch: null, worktreePath: null },
        ],
      }) as unknown as OrchestrationV2ThreadShell;
    const check = (runtimeMode: RuntimeMode, path: string) =>
      assertWithinCallerSandbox(callerIn(runtimeMode), [{ path, mode: "local" }]).pipe(
        Effect.result,
        Effect.map((result) => result._tag),
      );

    assert.equal(yield* check("sandboxed-full-access", `${root}/project/src`), "Success");
    assert.equal(yield* check("sandboxed-full-access", `${root}/docs/guide`), "Success");
    assert.equal(yield* check("sandboxed-full-access", `${root}/secret`), "Failure");
    assert.equal(yield* check("sandboxed-full-access", `${root}/project/escape`), "Failure");
    assert.equal(yield* check("sandboxed-full-access", `${root}/missing`), "Failure");
    assert.equal(yield* check("full-access", `${root}/secret`), "Success");
  }).pipe(
    Effect.scoped,
    Effect.provide(
      Layer.mock(Project.ProjectService)({
        getById: () => Effect.succeedNone,
      }).pipe(Layer.provideMerge(NodeServices.layer)),
    ),
  ),
);
