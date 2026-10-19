import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  ProjectId,
  ThreadId,
  ThreadWorkspaceError,
  GitCommandError,
  type OrchestrationV2ThreadProjection,
  type Project,
  type VcsMoveThreadInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProjectSetupScriptRunner from "../project/ProjectSetupScriptRunner.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as VcsStatusBroadcaster from "../vcs/VcsStatusBroadcaster.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";
import * as ThreadWorkspaceService from "./ThreadWorkspaceService.ts";

const layerGit = GitVcsDriver.layer.pipe(
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "workspace-move-test-" })),
  Layer.provide(VcsProcess.layer),
  Layer.provideMerge(NodeServices.layer),
);

const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const driver = yield* GitVcsDriver.GitVcsDriver;
  const directory = yield* fs.makeTempDirectoryScoped();
  const root = path.join(directory, "repo");
  const worktree = path.join(directory, "worktree");
  yield* fs.makeDirectory(root);
  const git = (cwd: string, args: readonly string[]) =>
    driver
      .execute({ operation: "workspace-move-test", cwd, args })
      .pipe(Effect.map((r) => r.stdout));
  yield* git(root, ["init", "-b", "main"]);
  yield* git(root, ["config", "user.name", "Test"]);
  yield* git(root, ["config", "user.email", "test@example.com"]);
  yield* fs.writeFileString(path.join(root, "tracked.txt"), "original\n");
  yield* fs.writeFileString(path.join(root, ".gitignore"), "ignored\n");
  yield* fs.writeFileString(path.join(root, "deleted.txt"), "delete me");
  yield* git(root, ["add", "."]);
  yield* git(root, ["commit", "-m", "initial"]);
  const threadId = ThreadId.make("thread-move");
  const projectId = ProjectId.make("project-move");
  let worktreePath: string | null = null;
  let branch: string | null = "main";
  let associatedWorktreePath: string | null = null;
  let archivedAt: string | null = null;
  let active = false;
  let failDispatch = false;
  let failCleanup = false;
  let failIndexCleanup = false;
  let race = false;
  const bindings: unknown[] = [];
  const projection = () =>
    ({
      thread: {
        id: threadId,
        projectId,
        worktreePath,
        associatedWorktreePath,
        branch,
        archivedAt,
        deletedAt: null,
      },
      runs: active ? [{ status: "running" }] : [],
    }) as unknown as OrchestrationV2ThreadProjection;
  const project = { id: projectId, workspaceRoot: root, scripts: [] } as unknown as Project;
  let projectRoot = root;
  const workflow = {
    listRefs: (
      input: Parameters<GitWorkflowService.GitWorkflowService["Service"]["listRefs"]>[0],
    ) => driver.listRefs(input),
    createWorktree: (
      input: Parameters<GitWorkflowService.GitWorkflowService["Service"]["createWorktree"]>[0],
    ) =>
      git(root, ["worktree", "add", "-b", input.newRefName!, worktree, input.refName]).pipe(
        Effect.as({ worktree: { path: worktree, refName: input.newRefName! } }),
      ),
  } as unknown as GitWorkflowService.GitWorkflowService["Service"];
  const serviceLayer = ThreadWorkspaceService.layer.pipe(
    Layer.provide(Layer.succeed(GitWorkflowService.GitWorkflowService, workflow)),
    Layer.provide(
      Layer.succeed(ThreadManagementService.ThreadManagementService, {
        getThreadRecords: () => Effect.sync(projection),
        dispatch: (command: {
          expectedWorktreePath: string | null;
          worktreePath: string | null;
          branch: string | null;
          associatedWorktreePath: string | null;
        }) =>
          Effect.sync(() => {
            if (failDispatch || race || command.expectedWorktreePath !== worktreePath)
              throw new Error("dispatch rejected");
            bindings.push(command);
            worktreePath = command.worktreePath;
            branch = command.branch;
            associatedWorktreePath = command.associatedWorktreePath;
          }).pipe(
            Effect.catchDefect((cause) =>
              Effect.fail(new ThreadWorkspaceError({ reason: "workspace_changed", cause })),
            ),
          ),
      } as unknown as ThreadManagementService.ThreadManagementService["Service"]),
    ),
    Layer.provide(
      Layer.succeed(ProjectService.ProjectService, {
        getById: () => Effect.sync(() => Option.some({ ...project, workspaceRoot: projectRoot })),
      } as unknown as ProjectService.ProjectService["Service"]),
    ),
    Layer.provide(
      Layer.succeed(ProjectSetupScriptRunner.ProjectSetupScriptRunner, {
        runForThread: () => Effect.succeed({ status: "no-script" }),
      } as unknown as ProjectSetupScriptRunner.ProjectSetupScriptRunner["Service"]),
    ),
    Layer.provide(
      Layer.succeed(VcsStatusBroadcaster.VcsStatusBroadcaster, {
        refreshStatus: () => Effect.void,
      } as unknown as VcsStatusBroadcaster.VcsStatusBroadcaster["Service"]),
    ),
    Layer.provide(
      Layer.succeed(GitVcsDriver.GitVcsDriver, {
        ...driver,
        execute: (input) =>
          input.cwd === root &&
          input.args.includes("--reverse") &&
          (failCleanup || (failIndexCleanup && input.args.includes("--cached")))
            ? Effect.fail(
                new GitCommandError({
                  operation: "test-cleanup",
                  command: "git",
                  cwd: root,
                  detail: "simulated cleanup failure",
                }),
              )
            : driver.execute(input),
      }),
    ),
  );
  const service = yield* ThreadWorkspaceService.ThreadWorkspaceService.pipe(
    Effect.provide(serviceLayer),
  );
  const move = (target: VcsMoveThreadInput["target"], source = worktreePath) =>
    service.moveThread({ threadId, expectedWorktreePath: source, target, runSetupScript: false });
  const write = (cwd: string, name: string, content: string) =>
    fs.writeFileString(path.join(cwd, name), content);
  const read = (cwd: string, name: string) => fs.readFileString(path.join(cwd, name));
  return {
    root,
    worktree,
    git,
    move,
    write,
    read,
    bindings,
    setBranch: (value: string) => {
      branch = value;
    },
    aliasProject: Effect.gen(function* () {
      projectRoot = path.join(directory, "alias");
      yield* fs.symlink(root, projectRoot);
    }),
    dirtySubmodule: Effect.gen(function* () {
      const dependency = path.join(directory, "dependency");
      yield* fs.makeDirectory(dependency);
      yield* git(dependency, ["init", "-b", "main"]);
      yield* git(dependency, ["config", "user.name", "Test"]);
      yield* git(dependency, ["config", "user.email", "test@example.com"]);
      yield* fs.writeFileString(path.join(dependency, "code.txt"), "original\n");
      yield* git(dependency, ["add", "."]);
      yield* git(dependency, ["commit", "-m", "initial"]);
      yield* git(root, [
        "-c",
        "protocol.file.allow=always",
        "submodule",
        "add",
        dependency,
        "module",
      ]);
      yield* git(root, ["commit", "-m", "add submodule"]);
      yield* fs.writeFileString(path.join(root, "module", "code.txt"), "unsaved submodule work\n");
    }),
    setArchived: () => {
      archivedAt = "2026-01-01";
    },
    setActive: () => {
      active = true;
    },
    setDispatchFailure: (value: boolean) => {
      failDispatch = value;
    },
    setCleanupFailure: (value: boolean) => {
      failCleanup = value;
    },
    setIndexCleanupFailure: (value: boolean) => {
      failIndexCleanup = value;
    },
    setRace: () => {
      race = true;
    },
  };
});

const test = <E>(
  name: string,
  body: (f: Effect.Success<typeof fixture>) => Effect.Effect<void, E, never>,
) =>
  it.effect(name, () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* body(yield* fixture);
      }),
    ).pipe(Effect.provide(layerGit)),
  );

const newWorktree = { worktree: { branch: "feature/move" } } as const;

describe("ThreadWorkspaceService", () => {
  test("rejects submodule edits that a superproject snapshot cannot transfer", (f) =>
    Effect.gen(function* () {
      yield* f.dirtySubmodule;
      expect((yield* f.move(newWorktree).pipe(Effect.flip)).reason).toBe("submodule_changes");
      expect(f.bindings).toHaveLength(0);
      expect(yield* f.read(f.root, "module/code.txt")).toBe("unsaved submodule work\n");
    }));
  test("moves from a project opened through a symbolic link", (f) =>
    Effect.gen(function* () {
      yield* f.aliasProject;
      yield* f.write(f.root, "tracked.txt", "saved\n");
      expect((yield* f.move(newWorktree)).cleanupPending).toBe(false);
      expect(yield* f.read(f.worktree, "tracked.txt")).toBe("saved\n");
    }));

  test("retains its associated worktree after changing the local branch", (f) =>
    Effect.gen(function* () {
      yield* f.move(newWorktree);
      expect((yield* f.move("local")).branch).toBe("main");
      yield* f.git(f.root, ["switch", "-c", "another-local-branch"]);
      f.setBranch("another-local-branch");
      const back = yield* f.move({ worktree: "associated" });
      expect(back.worktreePath).toBe(f.worktree);
      expect(back.branch).toBe("feature/move");
    }));
  test("finishes a partial file transfer without reapplying matching files", (f) =>
    Effect.gen(function* () {
      yield* f.git(f.root, ["worktree", "add", "-b", "feature/move", f.worktree, "HEAD"]);
      yield* f.write(f.root, "tracked.txt", "already copied\n");
      yield* f.write(f.worktree, "tracked.txt", "already copied\n");
      yield* f.write(f.root, "remaining", "still to transfer\n");
      expect((yield* f.move(newWorktree)).cleanupPending).toBe(false);
      expect(yield* f.read(f.worktree, "remaining")).toBe("still to transfer\n");
      expect(yield* f.git(f.root, ["status", "--porcelain"])).toBe("");
    }));

  test("rejects a worktree on another base while preserving source edits", (f) =>
    Effect.gen(function* () {
      yield* f.git(f.root, ["worktree", "add", "-b", "feature/move", f.worktree, "HEAD"]);
      yield* f.write(f.worktree, "committed", "another base");
      yield* f.git(f.worktree, ["add", "."]);
      yield* f.git(f.worktree, ["commit", "-m", "another base"]);
      yield* f.write(f.root, "tracked.txt", "saved\n");
      expect((yield* f.move(newWorktree).pipe(Effect.flip)).reason).toBe("different_base");
      expect(yield* f.read(f.root, "tracked.txt")).toBe("saved\n");
      expect(f.bindings).toHaveLength(0);
    }));

  test("moves tracked, staged, binary, deleted and untracked files in both directions, leaving ignored files", (f) =>
    Effect.gen(function* () {
      yield* f.write(f.root, "tracked.txt", "staged\n");
      yield* f.git(f.root, ["add", "tracked.txt"]);
      yield* f.write(f.root, "tracked.txt", "unstaged\n");
      yield* f.write(f.root, "new.bin", "\0binary\0");
      yield* f.write(f.root, "ignored", "secret");
      yield* f.git(f.root, ["rm", "deleted.txt"]);
      const result = yield* f.move(newWorktree);
      expect(result.cleanupPending).toBe(false);
      expect(yield* f.read(f.worktree, "tracked.txt")).toBe("unstaged\n");
      expect(yield* f.read(f.worktree, "new.bin")).toBe("\0binary\0");
      expect(yield* f.git(f.worktree, ["show", ":tracked.txt"])).toBe("staged\n");
      expect(yield* f.read(f.root, "tracked.txt")).toBe("original\n");
      expect(yield* f.read(f.root, "ignored")).toBe("secret");
      const back = yield* f.move("local");
      expect(back.worktreePath).toBe(null);
      expect(yield* f.read(f.root, "tracked.txt")).toBe("unstaged\n");
      expect(yield* f.git(f.worktree, ["status", "--porcelain"])).toBe("");
      const again = yield* f.move({ worktree: "associated" });
      expect(again.worktreePath).toBe(f.worktree);
    }));

  test("refuses a dirty target without changing either checkout", (f) =>
    Effect.gen(function* () {
      yield* f.move(newWorktree);
      yield* f.write(f.root, "tracked.txt", "local edits\n");
      yield* f.write(f.worktree, "tracked.txt", "worktree edits\n");
      expect((yield* f.move("local").pipe(Effect.flip)).reason).toBe("target_dirty");
      expect(yield* f.read(f.root, "tracked.txt")).toBe("local edits\n");
      expect(yield* f.read(f.worktree, "tracked.txt")).toBe("worktree edits\n");
    }));

  test("does not clean the source when metadata dispatch fails and a retry converges", (f) =>
    Effect.gen(function* () {
      yield* f.write(f.root, "tracked.txt", "changed\n");
      f.setDispatchFailure(true);
      yield* f.move(newWorktree).pipe(Effect.flip);
      expect(yield* f.read(f.root, "tracked.txt")).toBe("changed\n");
      expect(yield* f.read(f.worktree, "tracked.txt")).toBe("changed\n");
      f.setDispatchFailure(false);
      expect((yield* f.move(newWorktree)).cleanupPending).toBe(false);
      expect(yield* f.git(f.root, ["status", "--porcelain"])).toBe("");
    }));

  test("retries cleanup after metadata commits without applying changes twice", (f) =>
    Effect.gen(function* () {
      yield* f.write(f.root, "untracked", "saved\n");
      f.setCleanupFailure(true);
      expect((yield* f.move(newWorktree, null)).cleanupPending).toBe(true);
      expect(f.bindings).toHaveLength(1);
      expect(yield* f.read(f.root, "untracked")).toBe("saved\n");
      f.setCleanupFailure(false);
      expect((yield* f.move(newWorktree, null)).cleanupPending).toBe(false);
      expect(f.bindings).toHaveLength(1);
      expect(yield* f.git(f.root, ["status", "--porcelain"])).toBe("");
      expect((yield* f.move(newWorktree, null)).cleanupPending).toBe(false);
    }));

  test("finishes source index cleanup after file cleanup already succeeded", (f) =>
    Effect.gen(function* () {
      yield* f.write(f.root, "tracked.txt", "staged\n");
      yield* f.git(f.root, ["add", "tracked.txt"]);
      yield* f.write(f.root, "tracked.txt", "unstaged\n");
      f.setIndexCleanupFailure(true);
      expect((yield* f.move(newWorktree, null)).cleanupPending).toBe(true);
      expect(yield* f.read(f.root, "tracked.txt")).toBe("original\n");
      expect(yield* f.git(f.root, ["show", ":tracked.txt"])).toBe("staged\n");
      f.setIndexCleanupFailure(false);
      expect((yield* f.move(newWorktree, null)).cleanupPending).toBe(false);
      expect(yield* f.git(f.root, ["status", "--porcelain"])).toBe("");
      expect(yield* f.read(f.worktree, "tracked.txt")).toBe("unstaged\n");
      expect(yield* f.git(f.worktree, ["show", ":tracked.txt"])).toBe("staged\n");
    }));

  test("rejects archived threads", (f) =>
    Effect.gen(function* () {
      f.setArchived();
      expect((yield* f.move(newWorktree).pipe(Effect.flip)).reason).toBe("thread_unavailable");
    }));

  test("rejects active runs", (f) =>
    Effect.gen(function* () {
      f.setActive();
      expect((yield* f.move(newWorktree).pipe(Effect.flip)).reason).toBe("active_run");
    }));

  test("guards a concurrent binding and preserves the source", (f) =>
    Effect.gen(function* () {
      yield* f.write(f.root, "tracked.txt", "saved\n");
      f.setRace();
      yield* f.move(newWorktree).pipe(Effect.flip);
      expect(yield* f.read(f.root, "tracked.txt")).toBe("saved\n");
    }));

  test("returns to a clean local checkout at a different commit using detached HEAD", (f) =>
    Effect.gen(function* () {
      yield* f.move(newWorktree);
      yield* f.write(f.worktree, "committed", "new commit");
      yield* f.git(f.worktree, ["add", "."]);
      yield* f.git(f.worktree, ["commit", "-m", "worktree work"]);
      yield* f.write(f.worktree, "tracked.txt", "uncommitted\n");
      yield* f.move("local");
      expect(yield* f.read(f.root, "committed")).toBe("new commit");
      expect((yield* f.git(f.root, ["rev-parse", "--abbrev-ref", "HEAD"])).trim()).toBe("HEAD");
      expect(yield* f.read(f.root, "tracked.txt")).toBe("uncommitted\n");
    }));
});
