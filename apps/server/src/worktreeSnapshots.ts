import {
  CheckpointRef,
  GitCommandError,
  ThreadId,
  type VcsRestoreWorktreeSnapshotResult,
  type VcsWorktreeSnapshotInput,
  type WorktreeSnapshot,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Base64Url from "effect/encoding/Base64Url";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import * as CheckpointStore from "./checkpointing/CheckpointStore.ts";
import type { CheckpointStoreError } from "./checkpointing/Errors.ts";
import * as GitManager from "./git/GitManager.ts";
import * as ProjectStore from "./orchestration-v2/ProjectStore.ts";
import * as GitVcsDriver from "./vcs/GitVcsDriver.ts";
import { withWorkspaceLease } from "./workspace/workspaceLease.ts";
import { makeIsManagedWorktreePath } from "./worktreesDirectory.ts";

// Snapshots are commits at hidden refs in the worktree's repository, built by the
// checkpoint capture: objects are shared with the repository, binary files work, and
// they outlive the worktree folder because linked worktrees share one object store.
const SNAPSHOT_REFS_PREFIX = "refs/t3/worktree-snapshots";
const SNAPSHOT_REF_PATTERN = /^refs\/t3\/worktree-snapshots\/[A-Za-z0-9_-]+\/(\d+)$/;
const SNAPSHOT_MESSAGE_SUBJECT = "t3 worktree snapshot";
export const WORKTREE_SNAPSHOT_RETENTION_MS = 30 * 86_400_000;
export const WORKTREE_SNAPSHOTS_PER_THREAD = 3;

const SnapshotMetadata = Schema.Struct({
  threadId: Schema.NullOr(ThreadId),
  threadTitle: Schema.NullOr(Schema.String),
  branch: Schema.NullOr(Schema.String),
  worktreePath: Schema.String,
});
const encodeMetadata = Schema.encodeSync(Schema.fromJsonString(SnapshotMetadata));
const decodeMetadata = Schema.decodeUnknownOption(Schema.fromJsonString(SnapshotMetadata));

export interface CaptureWorktreeSnapshotInput {
  readonly worktreePath: string;
  readonly threadId: ThreadId;
  readonly threadTitle: string | null;
  readonly branch: string | null;
}

export class WorktreeSnapshots extends Context.Service<
  WorktreeSnapshots,
  {
    /**
     * Saves tracked edits and untracked, non-ignored files. Returns null for a clean
     * worktree. The caller must hold the worktree's workspace lease.
     */
    readonly capture: (
      input: CaptureWorktreeSnapshotInput,
    ) => Effect.Effect<string | null, CheckpointStoreError | GitCommandError>;
    /** Drops snapshots past retention and beyond the per-thread limit, then republishes. */
    readonly prune: Effect.Effect<void>;
    readonly snapshots: Stream.Stream<ReadonlyArray<WorktreeSnapshot>>;
    readonly restore: (
      input: VcsWorktreeSnapshotInput,
    ) => Effect.Effect<VcsRestoreWorktreeSnapshotResult, GitCommandError>;
    readonly discard: (input: VcsWorktreeSnapshotInput) => Effect.Effect<void, GitCommandError>;
  }
>()("t3/worktreeSnapshots") {}

const make = Effect.gen(function* () {
  const git = yield* GitVcsDriver.GitVcsDriver;
  const gitManager = yield* GitManager.GitManager;
  const checkpoints = yield* CheckpointStore.CheckpointStore;
  const projectStore = yield* ProjectStore.ProjectStoreV2;
  const sql = yield* SqlClient.SqlClient;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const isManagedWorktreePath = yield* makeIsManagedWorktreePath;
  const published = yield* SubscriptionRef.make<ReadonlyArray<WorktreeSnapshot>>([]);

  const failure = (operation: string, cwd: string, detail: string) =>
    new GitCommandError({
      operation: `WorktreeSnapshots.${operation}`,
      command: "git",
      cwd,
      detail,
    });

  const run = (operation: string, cwd: string, args: string[]) =>
    git.execute({
      operation: `WorktreeSnapshots.${operation}`,
      cwd,
      args,
      allowNonZeroExit: true,
      timeoutMs: 300_000,
    });

  const capture = Effect.fn("WorktreeSnapshots.capture")(function* (
    input: CaptureWorktreeSnapshotInput,
  ) {
    const status = yield* git.execute({
      operation: "WorktreeSnapshots.status",
      cwd: input.worktreePath,
      args: ["status", "--porcelain=v1", "-z", "--ignore-submodules=none", "--untracked-files=all"],
      maxOutputBytes: 1024,
    });
    if (status.stdout.length === 0 && !status.stdoutTruncated) return null;
    const ref = `${SNAPSHOT_REFS_PREFIX}/${Base64Url.encode(input.threadId)}/${yield* Clock.currentTimeMillis}`;
    yield* checkpoints.captureCheckpoint({
      cwd: input.worktreePath,
      checkpointRef: CheckpointRef.make(ref),
      message: `${SNAPSHOT_MESSAGE_SUBJECT}\n\n${encodeMetadata({
        threadId: input.threadId,
        threadTitle: input.threadTitle,
        branch: input.branch,
        worktreePath: input.worktreePath,
      })}`,
    });
    return ref;
  });

  // Project roots plus the repositories of additional directories, one entry per
  // git common dir so a repository opened as several projects is listed once.
  // Deleted projects count too: their threads' worktrees are still cleaned up, and
  // their snapshots must stay restorable and still expire.
  const repositories = Effect.fn("WorktreeSnapshots.repositories")(function* () {
    const projects = yield* projectStore.list({ includeDeleted: true });
    const additional = yield* sql<{ path: string }>`
      SELECT DISTINCT json_extract(directory.value, '$.path') AS "path"
      FROM orchestration_v2_projection_threads thread,
        json_each(thread.payload_json, '$.additionalDirectories') directory
      WHERE json_extract(directory.value, '$.worktreePath') IS NOT NULL
    `.pipe(NodeSqliteClient.readOnly);
    const seen = new Set<string>();
    const result: string[] = [];
    for (const cwd of new Set([
      ...projects.map((project) => path.resolve(project.workspaceRoot)),
      ...additional.flatMap((row) => (row.path ? [path.resolve(row.path)] : [])),
    ])) {
      const commonDir = yield* run("commonDir", cwd, [
        "rev-parse",
        "--path-format=absolute",
        "--git-common-dir",
      ]).pipe(Effect.orElseSucceed(() => null));
      if (commonDir === null || commonDir.exitCode !== 0) continue;
      const key = commonDir.stdout.trim();
      if (seen.has(key)) continue;
      seen.add(key);
      result.push(cwd);
    }
    return result;
  });

  const listIn = Effect.fn("WorktreeSnapshots.listIn")(function* (repository: string) {
    const refs = yield* run("list", repository, [
      "for-each-ref",
      "--format=%(refname)%00%(contents:body)%1e",
      SNAPSHOT_REFS_PREFIX,
    ]);
    if (refs.exitCode !== 0) return [];
    const snapshots: WorktreeSnapshot[] = [];
    for (const record of refs.stdout.split("\x1e")) {
      const [ref = "", body = ""] = record.trim().split("\0");
      const createdAt = SNAPSHOT_REF_PATTERN.exec(ref)?.[1];
      const metadata = decodeMetadata(body.trim());
      if (createdAt === undefined || Option.isNone(metadata)) continue;
      const stat = yield* run("stat", repository, [
        "diff-tree",
        "-r",
        "--no-renames",
        "--shortstat",
        `${ref}^`,
        ref,
      ]);
      snapshots.push({
        repository,
        ref,
        ...metadata.value,
        createdAt: DateTime.formatIso(DateTime.makeUnsafe(Number(createdAt))),
        fileCount: Number(/(\d+) files? changed/.exec(stat.stdout)?.[1] ?? 0),
      });
    }
    return snapshots;
  });

  const list = Effect.fn("WorktreeSnapshots.list")(function* () {
    const all = (yield* Effect.forEach(yield* repositories(), (repository) =>
      listIn(repository).pipe(Effect.orElseSucceed(() => [])),
    )).flat();
    return all.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  });

  const publish = list().pipe(
    Effect.tap((snapshots) => SubscriptionRef.set(published, snapshots)),
    Effect.asVoid,
    Effect.catchCause((cause) => Effect.logWarning("worktree snapshot listing failed", { cause })),
  );

  const remove = (repository: string, ref: string) =>
    run("delete", repository, ["update-ref", "-d", ref]).pipe(
      Effect.flatMap((result) =>
        result.exitCode === 0
          ? Effect.void
          : Effect.fail(failure("delete", repository, result.stderr.trim() || "update-ref failed")),
      ),
    );

  const prune = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    const snapshots = yield* list();
    const perThread = new Map<string, number>();
    const kept: WorktreeSnapshot[] = [];
    for (const snapshot of snapshots) {
      const owner = `${snapshot.repository}\0${snapshot.ref.slice(0, snapshot.ref.lastIndexOf("/"))}`;
      const rank = (perThread.get(owner) ?? 0) + 1;
      perThread.set(owner, rank);
      const removed =
        (rank > WORKTREE_SNAPSHOTS_PER_THREAD ||
          Date.parse(snapshot.createdAt) < now - WORKTREE_SNAPSHOT_RETENTION_MS) &&
        (yield* remove(snapshot.repository, snapshot.ref).pipe(
          Effect.as(true),
          Effect.catch((error) =>
            Effect.logWarning("worktree snapshot prune failed", { ref: snapshot.ref, error }).pipe(
              Effect.as(false),
            ),
          ),
        ));
      if (!removed) kept.push(snapshot);
    }
    yield* SubscriptionRef.set(published, kept);
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("worktree snapshot prune failed", { cause }).pipe(Effect.andThen(publish)),
    ),
  );

  const find = Effect.fn("WorktreeSnapshots.find")(function* (
    operation: string,
    input: VcsWorktreeSnapshotInput,
  ) {
    const repository = path.resolve(input.repository);
    const snapshot = SNAPSHOT_REF_PATTERN.test(input.ref)
      ? (yield* list().pipe(Effect.orElseSucceed(() => []))).find(
          (entry) => entry.repository === repository && entry.ref === input.ref,
        )
      : undefined;
    if (snapshot === undefined)
      return yield* failure(operation, input.repository, "Snapshot not found.");
    return snapshot;
  });

  const ensureWorktree = Effect.fn("WorktreeSnapshots.ensureWorktree")(function* (
    snapshot: WorktreeSnapshot,
  ) {
    if (yield* fs.exists(snapshot.worktreePath).pipe(Effect.orElseSucceed(() => true))) return;
    if (snapshot.branch === null || !(yield* isManagedWorktreePath(snapshot.worktreePath)))
      return yield* failure(
        "restore",
        snapshot.repository,
        "The worktree no longer exists and cannot be recreated here.",
      );
    yield* git.pruneWorktrees({ cwd: snapshot.repository });
    const branchExists = yield* run("restore", snapshot.repository, [
      "rev-parse",
      "--verify",
      "--quiet",
      `refs/heads/${snapshot.branch}`,
    ]);
    const parent = yield* git.resolveCommit({
      cwd: snapshot.repository,
      revision: `${snapshot.ref}^`,
    });
    // GitManager also copies the project's files to copy and applies its submodule
    // setting, as a worktree created for a new thread would get.
    yield* gitManager.createWorktree(
      branchExists.exitCode === 0
        ? { cwd: snapshot.repository, refName: snapshot.branch, path: snapshot.worktreePath }
        : {
            cwd: snapshot.repository,
            refName: parent.commitSha,
            newRefName: snapshot.branch,
            path: snapshot.worktreePath,
          },
    );
  });

  const restore = Effect.fn("WorktreeSnapshots.restore")(function* (
    input: VcsWorktreeSnapshotInput,
  ) {
    const snapshot = yield* find("restore", input);
    const cwd = snapshot.worktreePath;
    return yield* Effect.gen(function* () {
      yield* ensureWorktree(snapshot);
      const status = yield* run("restore", cwd, [
        "status",
        "--porcelain=v1",
        "--untracked-files=all",
      ]);
      if (status.exitCode !== 0)
        return yield* failure("restore", cwd, status.stderr.trim() || "git status failed");
      if (status.stdout.trim() !== "")
        return yield* failure(
          "restore",
          cwd,
          "The worktree has uncommitted changes. Commit or discard them, then restore.",
        );
      // Replays the snapshot's change from its parent onto the current HEAD, so a
      // branch that moved on still merges, and conflicts are left as markers.
      const picked = yield* run("restore", cwd, ["cherry-pick", "--no-commit", snapshot.ref]);
      const conflicts = yield* run("restore", cwd, [
        "diff",
        "--name-only",
        "--diff-filter=U",
        "-z",
      ]);
      const conflictedPaths = conflicts.stdout.split("\0").filter(Boolean);
      yield* run("restore", cwd, ["cherry-pick", "--quit"]);
      if (picked.exitCode !== 0 && conflictedPaths.length === 0)
        return yield* failure("restore", cwd, picked.stderr.trim() || "git cherry-pick failed");
      // Leaves the files as uncommitted edits, as they were before removal.
      yield* run("restore", cwd, ["reset", "--quiet"]);
      return { worktreePath: cwd, conflictedPaths };
    }).pipe((effect) => withWorkspaceLease(cwd, effect));
  });

  const discard = Effect.fn("WorktreeSnapshots.discard")(function* (
    input: VcsWorktreeSnapshotInput,
  ) {
    const snapshot = yield* find("discard", input);
    yield* remove(snapshot.repository, snapshot.ref);
    yield* publish;
  });

  return WorktreeSnapshots.of({
    capture,
    prune,
    snapshots: Stream.unwrap(publish.pipe(Effect.as(SubscriptionRef.changes(published)))),
    restore,
    discard,
  });
});

export const layer = Layer.effect(WorktreeSnapshots, make);
