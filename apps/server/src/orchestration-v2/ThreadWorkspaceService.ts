import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import {
  CommandId,
  ThreadWorkspaceError,
  type VcsMoveThreadInput,
  type VcsMoveThreadResult,
  type WorktreeMcpSetupScriptStatus,
} from "@t3tools/contracts";

import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProjectSetupScriptRunner from "../project/ProjectSetupScriptRunner.ts";
import * as VcsStatusBroadcaster from "../vcs/VcsStatusBroadcaster.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";
import { withWorkspaceLease } from "../workspace/workspaceLease.ts";

export class ThreadWorkspaceService extends Context.Service<
  ThreadWorkspaceService,
  {
    readonly moveThread: (
      input: VcsMoveThreadInput,
    ) => Effect.Effect<VcsMoveThreadResult, ThreadWorkspaceError>;
  }
>()("t3/orchestration-v2/ThreadWorkspaceService") {}

const make = Effect.gen(function* () {
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const projects = yield* ProjectService.ProjectService;
  const workflow = yield* GitWorkflowService.GitWorkflowService;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const setup = yield* ProjectSetupScriptRunner.ProjectSetupScriptRunner;
  const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
  const movingRepositories = new Set<string>();

  const gitFailure = Effect.mapError(
    (cause: unknown) => new ThreadWorkspaceError({ reason: "git_failed", cause }),
  );
  const execute = (
    cwd: string,
    args: readonly string[],
    options?: { env?: NodeJS.ProcessEnv; stdin?: string },
  ) =>
    git
      .execute({ operation: "moveThread", cwd, args, ...options, maxOutputBytes: 64 * 1024 * 1024 })
      .pipe(
        gitFailure,
        Effect.flatMap((result) =>
          result.stdoutTruncated
            ? Effect.fail(new ThreadWorkspaceError({ reason: "git_failed" }))
            : Effect.succeed(result.stdout),
        ),
      );
  const hasSubmoduleChanges = (cwd: string) =>
    execute(cwd, ["status", "--porcelain=v2", "--ignore-submodules=none", "-z"]).pipe(
      Effect.map((status) =>
        status
          .split("\0")
          .some(
            (entry) =>
              (entry.startsWith("1 ") || entry.startsWith("2 ")) &&
              entry.split(" ")[2]?.startsWith("S"),
          ),
      ),
    );

  // The alternate index captures untracked files as well as binary and mode changes,
  // without disturbing staged changes or the repository-wide stash list.
  const snapshot = Effect.fn("ThreadWorkspaceService.snapshot")(function* (cwd: string) {
    const dir = yield* fs.makeTempDirectoryScoped().pipe(gitFailure);
    const env = { ...process.env, GIT_INDEX_FILE: path.join(dir, "index") };
    const config = ["-c", "core.splitIndex=false", "-c", "core.fsmonitor=false"];
    const head = (yield* execute(cwd, ["rev-parse", "HEAD"])).trim();
    const index = (yield* execute(cwd, ["write-tree"])).trim();
    yield* execute(cwd, [...config, "read-tree", head], { env });
    yield* execute(cwd, [...config, "add", "--all", "--", "."], { env });
    const tree = (yield* execute(cwd, [...config, "write-tree"], { env })).trim();
    const patch = yield* execute(cwd, [
      "diff",
      "--binary",
      "--full-index",
      "--no-ext-diff",
      "--no-textconv",
      head,
      tree,
      "--",
    ]);
    const stagedPatch = yield* execute(cwd, [
      "diff",
      "--binary",
      "--full-index",
      "--no-ext-diff",
      "--no-textconv",
      head,
      index,
      "--",
    ]);
    return { head, index, tree, patch, stagedPatch };
  });

  const load = (input: VcsMoveThreadInput) =>
    threads.getThreadRecords(input.threadId, ["runs"]).pipe(gitFailure);
  const validate = Effect.fnUntraced(function* (input: VcsMoveThreadInput) {
    const projection = yield* load(input);
    if (projection.thread.archivedAt !== null || projection.thread.deletedAt !== null)
      return yield* new ThreadWorkspaceError({ reason: "thread_unavailable" });
    if (
      projection.runs.some((run) =>
        ["preparing", "queued", "starting", "running", "waiting"].includes(run.status),
      )
    )
      return yield* new ThreadWorkspaceError({ reason: "active_run" });
    return projection.thread;
  });

  const performMove = Effect.fn("ThreadWorkspaceService.performMove")(function* (
    input: VcsMoveThreadInput,
  ) {
    const thread = yield* validate(input);
    const projectOption = yield* projects.getById(thread.projectId).pipe(gitFailure);
    if (Option.isNone(projectOption))
      return yield* new ThreadWorkspaceError({ reason: "thread_unavailable" });
    const project = projectOption.value;
    const root = yield* fs.realPath(project.workspaceRoot).pipe(gitFailure);
    const source = yield* fs.realPath(input.expectedWorktreePath ?? root).pipe(gitFailure);
    return yield* withWorkspaceLease(
      path.resolve(source),
      Effect.gen(function* () {
        // Do not accept arbitrary filesystem paths from clients, even for a retry.
        const inventory = (yield* execute(root, ["worktree", "list", "--porcelain", "-z"]))
          .split("\0\0")
          .filter(Boolean)
          .map((record) => {
            const fields = record.split("\0");
            return {
              path: fields.find((field) => field.startsWith("worktree "))?.slice(9),
              branch: fields.find((field) => field.startsWith("branch refs/heads/"))?.slice(18),
            };
          });
        if (
          !inventory.some(
            (candidate) =>
              candidate.path !== undefined && path.resolve(candidate.path) === path.resolve(source),
          )
        )
          return yield* new ThreadWorkspaceError({ reason: "workspace_changed" });
        let created = false;
        // A superproject tree records gitlinks, not the files edited inside
        // submodules. Refuse instead of reporting those files as transferred.
        if (yield* hasSubmoduleChanges(source))
          return yield* new ThreadWorkspaceError({ reason: "submodule_changes" });
        let targetPath: string | null;
        let branch: string | null;
        if (input.target === "local") {
          targetPath = null;
          branch = thread.branch;
        } else {
          const selection = input.target.worktree;
          const branchName = selection === "associated" ? thread.branch : selection.branch;
          const associated =
            selection === "associated" && thread.associatedWorktreePath != null
              ? yield* fs.realPath(thread.associatedWorktreePath).pipe(gitFailure)
              : null;
          const existing = inventory.find((ref) =>
            associated !== null
              ? ref.path !== undefined && path.resolve(ref.path) === path.resolve(associated)
              : ref.branch === branchName,
          );
          if (existing?.path && path.resolve(existing.path) !== path.resolve(root)) {
            targetPath = existing.path;
            branch = existing.branch ?? null;
          } else if (selection === "associated") {
            return yield* new ThreadWorkspaceError({ reason: "target_missing" });
          } else {
            if (thread.worktreePath !== input.expectedWorktreePath)
              return yield* new ThreadWorkspaceError({ reason: "workspace_changed" });
            if (
              selection.baseRef !== undefined &&
              (yield* execute(source, [
                "rev-parse",
                "--verify",
                `${selection.baseRef}^{commit}`,
              ])).trim() !== (yield* execute(source, ["rev-parse", "HEAD"])).trim()
            )
              return yield* new ThreadWorkspaceError({ reason: "different_base" });
            const worktree = yield* workflow
              .createWorktree({
                cwd: source,
                refName: selection.baseRef ?? "HEAD",
                newRefName: selection.branch,
                baseRefName: selection.baseRef ?? thread.branch ?? "HEAD",
                path: null,
              })
              .pipe(gitFailure);
            targetPath = worktree.worktree.path;
            branch = worktree.worktree.refName;
            created = true;
          }
        }
        const target = targetPath ?? root;
        if (path.resolve(target) === path.resolve(source)) {
          if (thread.worktreePath !== targetPath)
            return yield* new ThreadWorkspaceError({ reason: "workspace_changed" });
          return {
            branch,
            worktreePath: targetPath,
            conflicts: false,
            cleanupPending: false,
            setupScript: { status: "skipped" } as const,
          };
        }
        return yield* withWorkspaceLease(
          path.resolve(target),
          Effect.gen(function* () {
            const retryAfterCommit = thread.worktreePath === targetPath;
            if (!retryAfterCommit && thread.worktreePath !== input.expectedWorktreePath)
              return yield* new ThreadWorkspaceError({ reason: "workspace_changed" });

            const sourceSnapshot = yield* snapshot(source);
            if (
              retryAfterCommit &&
              sourceSnapshot.patch === "" &&
              sourceSnapshot.stagedPatch === ""
            )
              return {
                branch,
                worktreePath: targetPath,
                conflicts: false,
                cleanupPending: false,
                setupScript: { status: "skipped" } as const,
              };
            if (yield* hasSubmoduleChanges(target))
              return yield* new ThreadWorkspaceError({ reason: "target_dirty" });
            let destination = yield* snapshot(target);
            // Once the binding commits, the destination is the complete copy.
            // The source may have only its index or some files left to clean.
            const captured = retryAfterCommit ? destination : sourceSnapshot;
            if (sourceSnapshot.head !== captured.head)
              return yield* new ThreadWorkspaceError({ reason: "workspace_changed" });
            if (destination.head !== captured.head) {
              if (destination.patch !== "" || destination.stagedPatch !== "")
                return yield* new ThreadWorkspaceError({ reason: "target_dirty" });
              if (targetPath !== null)
                return yield* new ThreadWorkspaceError({ reason: "different_base" });
              // A detached root avoids checking out the source worktree's branch twice.
              yield* execute(target, ["switch", "--detach", captured.head]);
              destination = yield* snapshot(target);
            }
            if (targetPath === null)
              branch = (yield* execute(target, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
            if (branch === "HEAD") branch = null;

            // A killed Git apply can leave a subset of the transferred files. Accept
            // only exact blob/mode matches; independent destination edits still fail.
            const changes = Effect.fnUntraced(function* (tree: string) {
              const raw = yield* execute(source, [
                "diff",
                "--raw",
                "--no-abbrev",
                "--no-renames",
                "-z",
                captured.head,
                tree,
                "--",
              ]);
              const fields = raw.split("\0");
              const entries = new Map<string, string>();
              for (let i = 0; i + 1 < fields.length; i += 2)
                entries.set(fields[i + 1]!, fields[i]!);
              return entries;
            });
            for (const [from, to] of [
              [retryAfterCommit ? sourceSnapshot.tree : destination.tree, captured.tree],
              [retryAfterCommit ? sourceSnapshot.index : destination.index, captured.index],
            ]) {
              const existing = yield* changes(from!);
              const incoming = yield* changes(to!);
              if ([...existing].some(([name, value]) => incoming.get(name) !== value))
                return yield* new ThreadWorkspaceError({ reason: "target_dirty" });
            }
            const patch = yield* execute(target, [
              "diff",
              "--binary",
              "--full-index",
              "--no-ext-diff",
              "--no-textconv",
              destination.tree,
              captured.tree,
              "--",
            ]);
            const stagedPatch = yield* execute(target, [
              "diff",
              "--binary",
              "--full-index",
              "--no-ext-diff",
              "--no-textconv",
              destination.index,
              captured.index,
              "--",
            ]);
            if (stagedPatch !== "")
              yield* execute(target, ["apply", "--cached", "--check", "--binary", "-"], {
                stdin: stagedPatch,
              });
            if (patch !== "") {
              yield* execute(target, ["apply", "--check", "--binary", "-"], { stdin: patch }).pipe(
                Effect.mapError((cause) => new ThreadWorkspaceError({ reason: "conflict", cause })),
              );
              yield* execute(target, ["apply", "--binary", "-"], { stdin: patch });
            }
            if (stagedPatch !== "")
              yield* execute(target, ["apply", "--cached", "--binary", "-"], {
                stdin: stagedPatch,
              });
            const current = yield* validate(input);
            if (!retryAfterCommit) {
              if (current.worktreePath !== input.expectedWorktreePath)
                return yield* new ThreadWorkspaceError({ reason: "workspace_changed" });
              const uuid = yield* crypto.randomUUIDv4().pipe(Effect.orDie);
              yield* threads
                .dispatch({
                  type: "thread.metadata.update",
                  commandId: CommandId.make(`workspace-move:${uuid}`),
                  threadId: input.threadId,
                  branch,
                  worktreePath: targetPath,
                  expectedWorktreePath: input.expectedWorktreePath,
                  expectedBranch: thread.branch,
                  associatedWorktreePath: targetPath ?? source,
                  requireIdle: true,
                })
                .pipe(gitFailure);
            }

            // Never discard edits made since capture. A retry can finish cleanup only
            // while both checkouts still contain exactly the transferred changes.
            const cleanup = Effect.gen(function* () {
              if ((yield* validate(input)).worktreePath !== targetPath) return true;
              const latestSource = yield* snapshot(source);
              const latestTarget = yield* snapshot(target);
              if (
                latestSource.tree !== sourceSnapshot.tree ||
                latestSource.index !== sourceSnapshot.index ||
                latestSource.head !== sourceSnapshot.head ||
                latestTarget.tree !== captured.tree ||
                latestTarget.index !== captured.index
              )
                return true;
              if (sourceSnapshot.patch !== "")
                yield* execute(source, ["apply", "--reverse", "--binary", "-"], {
                  stdin: sourceSnapshot.patch,
                });
              if (sourceSnapshot.stagedPatch !== "")
                yield* execute(source, ["apply", "--cached", "--reverse", "--binary", "-"], {
                  stdin: sourceSnapshot.stagedPatch,
                });
              return false;
            }).pipe(Effect.orElseSucceed(() => true));
            const cleanupPending = yield* cleanup;
            yield* Effect.forEach(
              [source, target],
              (cwd) => broadcaster.refreshStatus(cwd).pipe(Effect.ignoreCause({ log: true })),
              { discard: true },
            );
            let setupScript: WorktreeMcpSetupScriptStatus = { status: "skipped" };
            if (created && (input.runSetupScript ?? true))
              setupScript = yield* setup
                .runForThread({
                  threadId: thread.id,
                  projectId: project.id,
                  projectCwd: root,
                  worktreePath: target,
                  project: { id: project.id, workspaceRoot: root, scripts: project.scripts },
                })
                .pipe(
                  Effect.map((result): WorktreeMcpSetupScriptStatus =>
                    result.status === "started"
                      ? {
                          status: "started",
                          scriptName: result.scriptName,
                          terminalId: result.terminalId,
                        }
                      : result.status === "skipped-for-link"
                        ? { status: "skipped" }
                        : { status: "no-script" },
                  ),
                  Effect.orElseSucceed((): WorktreeMcpSetupScriptStatus => ({
                    status: "failed",
                    detail: "The workspace moved, but its setup script could not start.",
                  })),
                );
            return {
              branch,
              worktreePath: targetPath,
              conflicts: false,
              cleanupPending,
              setupScript,
            };
          }),
        );
      }),
    );
  });

  const moveThread: ThreadWorkspaceService["Service"]["moveThread"] = Effect.fn(
    "ThreadWorkspaceService.moveThread",
  )(function* (input) {
    const thread = yield* validate(input);
    const project = yield* projects.getById(thread.projectId).pipe(gitFailure);
    if (Option.isNone(project))
      return yield* new ThreadWorkspaceError({ reason: "thread_unavailable" });
    const repository = (yield* execute(project.value.workspaceRoot, [
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir",
    ])).trim();
    // Repository-wide exclusion also covers moves by different projects sharing the
    // root checkout. Cancellation cannot split applying, binding, and cleanup.
    return yield* Effect.uninterruptible(
      Effect.suspend(() => {
        if (movingRepositories.has(repository))
          return Effect.fail(new ThreadWorkspaceError({ reason: "in_progress" }));
        movingRepositories.add(repository);
        return Effect.scoped(performMove(input)).pipe(
          Effect.ensuring(Effect.sync(() => movingRepositories.delete(repository))),
        );
      }),
    );
  });
  return ThreadWorkspaceService.of({ moveThread });
});

export const layer = Layer.effect(ThreadWorkspaceService, make);
