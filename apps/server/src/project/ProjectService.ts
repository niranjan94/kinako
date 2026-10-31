import {
  CommandId,
  type OrchestrationProjectShell,
  type OrchestrationV2ThreadShell,
  ProjectId,
  type Project,
  type ProjectCreatePayload,
  type ProjectUpdatePayload,
  type ProjectSnapshot,
  ThreadId,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import * as EffectOutbox from "../orchestration-v2/EffectOutbox.ts";
import { withCommandMetrics } from "../observability/Metrics.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as LegacyV1ThreadImporter from "../orchestration-v2/legacy/LegacyV1ThreadImporter.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import {
  decodeProjectCommandRejection,
  encodeProjectCommandRejection,
  planProjectCommand,
  type ProjectCommand,
} from "../orchestration-v2/ProjectCommands.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ThreadCommandExecutor from "../orchestration-v2/ThreadCommandExecutor.ts";
import { planThreadDeletion } from "../orchestration-v2/ThreadDeletion.ts";
import { planThreadWorkspaceRelocation } from "../orchestration-v2/ThreadWorkspaceRelocation.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as ProjectEnrichmentService from "./ProjectEnrichmentService.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";

export interface ProjectCreateInput extends ProjectCreatePayload {
  readonly commandId: CommandId;
  readonly projectId: ProjectId;
}

export interface ProjectUpdateInput extends ProjectUpdatePayload {
  readonly commandId: CommandId;
  readonly projectId: ProjectId;
}

export interface ProjectBootstrapInput extends ProjectCreateInput {}

export interface ProjectDeleteInput {
  readonly commandId: CommandId;
  readonly projectId: ProjectId;
  readonly force?: boolean;
}

export class ProjectNotFoundError extends Schema.TaggedError<ProjectNotFoundError>()(
  "ProjectNotFoundError",
  { projectId: ProjectId },
) {
  override get message(): string {
    return `Project ${this.projectId} was not found.`;
  }
}

export class ProjectConflictError extends Schema.TaggedError<ProjectConflictError>()(
  "ProjectConflictError",
  {
    projectId: ProjectId,
    workspaceRoot: Schema.String,
    conflictingProjectId: ProjectId,
  },
) {
  override get message(): string {
    return `Workspace ${this.workspaceRoot} already belongs to project ${this.conflictingProjectId}.`;
  }
}

export class ProjectNotEmptyError extends Schema.TaggedError<ProjectNotEmptyError>()(
  "ProjectNotEmptyError",
  { projectId: ProjectId },
) {
  override get message(): string {
    return `Project ${this.projectId} is not empty.`;
  }
}

export const ProjectRelocationBlocker = Schema.Literals([
  "active_turn",
  "checkpoint_revert",
  "background_tasks",
]);
export type ProjectRelocationBlocker = typeof ProjectRelocationBlocker.Type;

export class ProjectRelocationBlockedError extends Schema.TaggedError<ProjectRelocationBlockedError>()(
  "ProjectRelocationBlockedError",
  {
    projectId: ProjectId,
    threads: Schema.Array(
      Schema.Struct({
        threadId: ThreadId,
        title: Schema.String,
        blocker: ProjectRelocationBlocker,
      }),
    ),
  },
) {
  override get message(): string {
    const titles = this.threads.map((thread) => `"${thread.title}"`).join(", ");
    return `Stop active work before changing the project path. Still busy: ${titles}.`;
  }
}

export class ProjectOperationError extends Schema.TaggedError<ProjectOperationError>()(
  "ProjectOperationError",
  {
    operation: Schema.Literals([
      "normalize-workspace",
      "read-project",
      "list-projects",
      "list-threads",
      "delete-thread",
      "relocate-thread",
      "dispatch-project-command",
    ]),
    projectId: Schema.optional(ProjectId),
    workspaceRoot: Schema.optional(Schema.String),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Project operation '${this.operation}' failed${this.projectId === undefined ? "" : ` for ${this.projectId}`}.`;
  }
}

export type ProjectServiceError =
  | ProjectNotFoundError
  | ProjectConflictError
  | ProjectNotEmptyError
  | ProjectRelocationBlockedError
  | ProjectOperationError;

export class ProjectService extends Context.Service<
  ProjectService,
  {
    readonly create: (input: ProjectCreateInput) => Effect.Effect<Project, ProjectServiceError>;
    readonly bootstrap: (
      input: ProjectBootstrapInput,
    ) => Effect.Effect<
      { readonly project: Project; readonly created: boolean },
      ProjectServiceError
    >;
    readonly update: (input: ProjectUpdateInput) => Effect.Effect<Project, ProjectServiceError>;
    readonly delete: (input: ProjectDeleteInput) => Effect.Effect<Project, ProjectServiceError>;
    readonly getById: (
      projectId: ProjectId,
      options?: { readonly includeDeleted?: boolean },
    ) => Effect.Effect<Option.Option<Project>, ProjectOperationError>;
    readonly getByWorkspaceRoot: (
      workspaceRoot: string,
      options?: { readonly includeDeleted?: boolean },
    ) => Effect.Effect<Option.Option<Project>, ProjectOperationError>;
    readonly snapshot: Effect.Effect<ProjectSnapshot, ProjectOperationError>;
    /**
     * A page of active projects in creation order, each with its repository
     * identity resolved, so a caller can match projects by repository.
     */
    readonly listPage: (input: {
      readonly cursor: number;
      readonly limit: number;
    }) => Effect.Effect<
      { readonly projects: ReadonlyArray<Project>; readonly nextCursor: number | null },
      ProjectOperationError
    >;
    readonly getShell: (
      projectId: ProjectId,
    ) => Effect.Effect<Option.Option<OrchestrationProjectShell>, ProjectOperationError>;
    readonly listShells: (options?: {
      readonly projectIds?: ReadonlyArray<ProjectId>;
    }) => Effect.Effect<ReadonlyArray<OrchestrationProjectShell>, ProjectOperationError>;
  }
>()("t3/project/ProjectService") {}

export const make = Effect.gen(function* () {
  const projects = yield* ProjectStore.ProjectStoreV2;
  const projectEnrichment = yield* ProjectEnrichmentService.ProjectEnrichmentService;
  const workspacePaths = yield* WorkspacePaths.WorkspacePaths;
  const threadProjections = yield* ProjectionStore.ProjectionStoreV2;
  const eventSink = yield* EventSink.EventSinkV2;
  const idAllocator = yield* IdAllocator.IdAllocatorV2;
  const legacyImporter = yield* LegacyV1ThreadImporter.LegacyV1ThreadImporter;
  const threadCommands = yield* ThreadCommandExecutor.ThreadCommandExecutor;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const effectOutbox = yield* EffectOutbox.EffectOutboxV2;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const projectLocks = yield* KeyedLock.make<ProjectId>();
  const workspaceLocks = yield* KeyedLock.make<string>();

  const toProject = (
    row: ProjectStore.ProjectRow,
    enrichment: ProjectEnrichmentService.ProjectEnrichment | null,
  ): Project => ({
    id: row.projectId,
    title: row.title,
    workspaceRoot: row.workspaceRoot,
    repositoryIdentity: enrichment?.repositoryIdentity ?? null,
    faviconPath: row.faviconPath ?? enrichment?.faviconPath ?? null,
    defaultModelSelection: row.defaultModelSelection,
    defaultThreadEnvMode: row.defaultThreadEnvMode,
    autoPull: row.autoPull,
    projectIcon: row.projectIcon,
    scripts: row.scripts,
    additionalDirectories: row.additionalDirectories,
    pinnedAt: row.pinnedAt,
    archivedAt: row.archivedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    deletedAt: row.deletedAt,
  });

  const hydrate = Effect.fn("ProjectService.hydrate")(function* (row: ProjectStore.ProjectRow) {
    const enrichment =
      row.deletedAt === null
        ? yield* projectEnrichment.getAvailable(row.workspaceRoot)
        : yield* projectEnrichment.peek(row.workspaceRoot);
    return toProject(row, enrichment);
  });

  const readRow = (projectId: ProjectId, options?: { readonly includeDeleted?: boolean }) =>
    projects
      .get(projectId, options)
      .pipe(
        Effect.mapError(
          (cause) => new ProjectOperationError({ operation: "read-project", projectId, cause }),
        ),
      );

  const normalizeWorkspaceRoot = (input: {
    readonly projectId?: ProjectId;
    readonly workspaceRoot: string;
    readonly createIfMissing?: boolean;
  }) =>
    workspacePaths
      .normalizeWorkspaceRoot(input.workspaceRoot, {
        createIfMissing: input.createIfMissing ?? false,
      })
      .pipe(
        Effect.mapError(
          (cause) =>
            new ProjectOperationError({
              operation: "normalize-workspace",
              ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
              workspaceRoot: input.workspaceRoot,
              cause,
            }),
        ),
      );

  const commit = Effect.fn("ProjectService.commit")(function* (command: ProjectCommand) {
    const { projectId } = command;
    const dispatchError = (cause: unknown) =>
      new ProjectOperationError({ operation: "dispatch-project-command", projectId, cause });
    const workspaceRoot = command.type === "project.delete" ? undefined : command.workspaceRoot;
    const planAndCommit = Effect.gen(function* () {
      const project = Option.getOrUndefined(yield* readRow(projectId, { includeDeleted: true }));
      const workspaceOwner =
        workspaceRoot === undefined
          ? undefined
          : Option.getOrUndefined(
              yield* projects
                .findActiveByWorkspaceRoot(workspaceRoot)
                .pipe(Effect.mapError(dispatchError)),
            );
      const now = yield* DateTime.now;
      const eventId = yield* idAllocator.allocate
        .event({ commandId: command.commandId })
        .pipe(Effect.mapError(dispatchError));
      const planned = planProjectCommand({
        command,
        state: { project, workspaceOwner },
        eventId,
        now,
      });
      if (Result.isSuccess(planned)) {
        const { receipt } = yield* eventSink.commitProjectCommand({
          commandId: command.commandId,
          projectId,
          commandType: command.type,
          acceptedAt: now,
          event: planned.success,
        });
        return receipt;
      }
      return yield* eventSink.commitRejectedProjectCommand({
        commandId: command.commandId,
        projectId,
        commandType: command.type,
        rejectedAt: now,
        error: encodeProjectCommandRejection(planned.failure),
      });
    });
    const receipt = yield* projectLocks
      .withLock(
        projectId,
        workspaceRoot === undefined
          ? planAndCommit
          : workspaceLocks.withLock(workspaceRoot, planAndCommit),
      )
      .pipe(Effect.mapError(dispatchError));
    if (receipt.projectId !== projectId || receipt.commandType !== command.type) {
      return yield* dispatchError(
        `Command ${command.commandId} was already used by ${receipt.commandType} for ${receipt.projectId}.`,
      );
    }
    // Retries re-plan against their own effects; the first receipt determines the outcome.
    if (receipt.status === "accepted") return;
    const rejection = Option.getOrUndefined(decodeProjectCommandRejection(receipt.error));
    switch (rejection?._tag) {
      case "ProjectWorkspaceConflictError":
        return yield* new ProjectConflictError({
          projectId,
          workspaceRoot: rejection.workspaceRoot,
          conflictingProjectId: rejection.conflictingProjectId,
        });
      case "ProjectCommandMissingProjectError":
        return yield* new ProjectNotFoundError({ projectId });
      default:
        return yield* dispatchError(
          rejection ?? receipt.error ?? "The command was previously rejected.",
        );
    }
  }, withCommandMetrics);

  const readCommitted = Effect.fn("ProjectService.readCommitted")(function* (projectId: ProjectId) {
    const row = yield* readRow(projectId, { includeDeleted: true });
    if (Option.isNone(row)) {
      return yield* new ProjectOperationError({
        operation: "read-project",
        projectId,
        cause: "The accepted project command did not produce a project row.",
      });
    }
    return yield* hydrate(row.value);
  });

  const getById: ProjectService["Service"]["getById"] = Effect.fn("ProjectService.getById")(
    function* (projectId, options) {
      const row = yield* readRow(projectId, options);
      return Option.isNone(row) ? Option.none() : Option.some(yield* hydrate(row.value));
    },
  );

  const getByWorkspaceRoot: ProjectService["Service"]["getByWorkspaceRoot"] = Effect.fn(
    "ProjectService.getByWorkspaceRoot",
  )(function* (workspaceRoot, options) {
    const normalized = yield* normalizeWorkspaceRoot({ workspaceRoot });
    const row = yield* (
      options?.includeDeleted === true
        ? projects
            .list({ includeDeleted: true })
            .pipe(
              Effect.map((rows) =>
                Option.fromUndefinedOr(rows.find((row) => row.workspaceRoot === normalized)),
              ),
            )
        : projects.findActiveByWorkspaceRoot(normalized)
    ).pipe(
      Effect.mapError((cause) => new ProjectOperationError({ operation: "list-projects", cause })),
    );
    return Option.isNone(row) ? Option.none() : Option.some(yield* hydrate(row.value));
  });

  const create: ProjectService["Service"]["create"] = Effect.fn("ProjectService.create")(
    function* (input) {
      const workspaceRoot = yield* normalizeWorkspaceRoot({
        projectId: input.projectId,
        workspaceRoot: input.workspaceRoot,
        createIfMissing: input.createWorkspaceRootIfMissing ?? false,
      });
      yield* commit({
        type: "project.create",
        commandId: input.commandId,
        projectId: input.projectId,
        title: input.title,
        workspaceRoot,
        ...(input.scripts === undefined ? {} : { scripts: input.scripts }),
      });
      yield* projectEnrichment.invalidate([workspaceRoot]);
      return yield* readCommitted(input.projectId);
    },
  );

  const listLiveProjectThreads = Effect.fn("ProjectService.listLiveProjectThreads")(function* (
    projectId: ProjectId,
  ) {
    const snapshot = yield* threadProjections
      .getShellSnapshot()
      .pipe(
        Effect.mapError(
          (cause) => new ProjectOperationError({ operation: "list-threads", projectId, cause }),
        ),
      );
    return [...snapshot.threads, ...snapshot.archivedThreads].filter(
      (thread) => thread.projectId === projectId && thread.deletedAt === null,
    );
  });

  const isRollbackPending = Effect.fn("ProjectService.isRollbackPending")(function* (
    threadId: ThreadId,
  ) {
    const thread = yield* threadProjections.getThread(threadId);
    if (thread.rollbackRequestId === undefined) return false;
    const rollbackEffects = yield* effectOutbox.listByCommandId(thread.rollbackRequestId);
    return rollbackEffects.some(
      (effect) =>
        effect.request.type === "provider-thread.rollback" &&
        (effect.status === "pending" || effect.status === "running"),
    );
  });

  const relocationBlocker = Effect.fn("ProjectService.relocationBlocker")(function* (
    thread: OrchestrationV2ThreadShell,
  ) {
    if (thread.activeRunId !== null || thread.activityRunStatus != null) {
      return "active_turn" as const;
    }
    if ((thread.pendingBackgroundTasks ?? []).length > 0) return "background_tasks" as const;
    if (yield* isRollbackPending(thread.id)) return "checkpoint_revert" as const;
    return null;
  });

  const ensureRelocatable = Effect.fn("ProjectService.ensureRelocatable")(function* (
    projectId: ProjectId,
    threads: ReadonlyArray<OrchestrationV2ThreadShell>,
  ) {
    const blocked = yield* Effect.forEach(
      threads,
      (thread) =>
        relocationBlocker(thread).pipe(
          Effect.map((blocker) =>
            blocker === null ? [] : [{ threadId: thread.id, title: thread.title, blocker }],
          ),
        ),
      { concurrency: 8 },
    ).pipe(
      Effect.map((entries) => entries.flat()),
      Effect.mapError(
        (cause) => new ProjectOperationError({ operation: "list-threads", projectId, cause }),
      ),
    );
    if (blocked.length > 0) {
      return yield* new ProjectRelocationBlockedError({ projectId, threads: blocked });
    }
  });

  const relocateThread = Effect.fn("ProjectService.relocateThread")(function* (input: {
    readonly commandId: CommandId;
    readonly projectId: ProjectId;
    readonly thread: OrchestrationV2ThreadShell;
    readonly fromRoot: string;
    readonly toRoot: string;
    readonly phase: "prepare" | "settle";
  }) {
    const { projectId, thread } = input;
    const failure = (cause: unknown) =>
      new ProjectOperationError({ operation: "relocate-thread", projectId, cause });
    const projection = yield* threadProjections
      .getThreadRecords(thread.id, ["runs", "checkpointScopes", "providerSessions"])
      .pipe(Effect.mapError(failure));
    if (projection.thread.deletedAt !== null || projection.thread.projectId !== projectId) return;
    // Re-checked under the thread lock: a turn queued after the snapshot check
    // would otherwise start at the old root.
    if (
      projection.runs.some((run) =>
        ["queued", "preparing", "starting", "running", "waiting"].includes(run.status),
      )
    ) {
      return yield* new ProjectRelocationBlockedError({
        projectId,
        threads: [{ threadId: thread.id, title: thread.title, blocker: "active_turn" }],
      });
    }
    const platform = yield* HostProcess.Platform;
    const now = yield* DateTime.now;
    const commandId = CommandId.make(
      `${input.commandId}:relocate-thread:${input.phase}:${thread.id}`,
    );
    const plan = yield* planThreadWorkspaceRelocation({
      commandId,
      projection,
      fromRoot: input.fromRoot,
      toRoot: input.toRoot,
      caseInsensitive: platform === "darwin" || platform === "win32",
      now,
      idAllocator,
    }).pipe(Effect.mapError(failure));
    if (plan.events.length === 0) return;
    const committed = yield* eventSink
      .commitCommand({
        commandId,
        commandType: "thread.workspace.relocate",
        threadId: thread.id,
        acceptedAt: now,
        events: plan.events,
        effects: plan.effects,
      })
      .pipe(Effect.mapError(failure));
    if (
      committed.receipt.threadId !== thread.id ||
      committed.receipt.commandType !== "thread.workspace.relocate"
    ) {
      return yield* failure(`Command ${commandId} belongs to a different command.`);
    }
    if (committed.receipt.status === "rejected") {
      return yield* failure(
        committed.receipt.error ?? "Thread relocation was previously rejected.",
      );
    }
  });

  const relocateThreads = (input: {
    readonly commandId: CommandId;
    readonly projectId: ProjectId;
    readonly threads: ReadonlyArray<OrchestrationV2ThreadShell>;
    readonly fromRoot: string;
    readonly toRoot: string;
    readonly phase: "prepare" | "settle";
  }) =>
    Effect.forEach(
      input.threads,
      (thread) => {
        const relocate = threadCommands.withLock(thread.id, relocateThread({ ...input, thread }));
        return input.phase === "prepare"
          ? relocate
          : relocate.pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning(
                  `Thread ${thread.id} kept a session from the old project path.`,
                  cause,
                ),
              ),
            );
      },
      { concurrency: 1, discard: true },
    );

  // Worktree checkouts link to the repository's gitdir by absolute path, so a
  // moved repository leaves them broken until git rewrites both sides.
  const repairWorktrees = Effect.fn("ProjectService.repairWorktrees")(
    function* (projectId: ProjectId, workspaceRoot: string) {
      const threads = yield* listLiveProjectThreads(projectId);
      const worktreePaths = [
        ...new Set(
          threads.flatMap((thread) => (thread.worktreePath === null ? [] : [thread.worktreePath])),
        ),
      ].toSorted();
      if (worktreePaths.length === 0) return;
      const result = yield* git.execute({
        operation: "ProjectService.repairWorktrees",
        cwd: workspaceRoot,
        args: ["worktree", "repair", ...worktreePaths],
        allowNonZeroExit: true,
      });
      if (result.exitCode !== 0) {
        yield* Effect.logWarning("Repairing worktrees after a project move failed.", {
          projectId,
          stderr: result.stderr,
        });
      }
    },
    Effect.catchCause((cause) =>
      Effect.logWarning("Repairing worktrees after a project move failed.", cause),
    ),
  );

  const update: ProjectService["Service"]["update"] = Effect.fn("ProjectService.update")(
    function* (input) {
      const existing = yield* readRow(input.projectId);
      if (Option.isNone(existing)) {
        return yield* new ProjectNotFoundError({ projectId: input.projectId });
      }
      const previousRoot = existing.value.workspaceRoot;
      const workspaceRoot =
        input.workspaceRoot === undefined
          ? previousRoot
          : yield* normalizeWorkspaceRoot({
              projectId: input.projectId,
              workspaceRoot: input.workspaceRoot,
            });
      const additionalDirectories =
        input.additionalDirectories === undefined
          ? undefined
          : yield* Effect.forEach(input.additionalDirectories, (directory) =>
              normalizeWorkspaceRoot({
                projectId: input.projectId,
                workspaceRoot: directory.path,
              }).pipe(Effect.map((path) => ({ path, mode: directory.mode }))),
            );
      const relocating = workspaceRoot !== previousRoot;
      if (relocating) {
        // Rebasing threads onto a root the project commit will refuse would
        // strand them, so the commit's ownership check runs first too.
        const owner = yield* projects.findActiveByWorkspaceRoot(workspaceRoot).pipe(
          Effect.mapError(
            (cause) =>
              new ProjectOperationError({
                operation: "list-projects",
                projectId: input.projectId,
                cause,
              }),
          ),
        );
        if (Option.isSome(owner) && owner.value.projectId !== input.projectId) {
          return yield* new ProjectConflictError({
            projectId: input.projectId,
            workspaceRoot,
            conflictingProjectId: owner.value.projectId,
          });
        }
        const threads = yield* listLiveProjectThreads(input.projectId);
        yield* ensureRelocatable(input.projectId, threads);
        // Before the project commit, so a retry still sees the old root and
        // finds the threads it has not rebased yet.
        yield* relocateThreads({
          commandId: input.commandId,
          projectId: input.projectId,
          threads,
          fromRoot: previousRoot,
          toRoot: workspaceRoot,
          phase: "prepare",
        });
      }
      yield* commit({
        type: "project.meta.update",
        commandId: input.commandId,
        projectId: input.projectId,
        ...(input.title === undefined ? {} : { title: input.title }),
        ...(workspaceRoot === previousRoot ? {} : { workspaceRoot }),
        ...(input.defaultModelSelection === undefined
          ? {}
          : { defaultModelSelection: input.defaultModelSelection }),
        ...(input.autoPull === undefined ? {} : { autoPull: input.autoPull }),
        ...(input.projectIcon === undefined ? {} : { projectIcon: input.projectIcon }),
        ...(input.faviconPath === undefined ? {} : { faviconPath: input.faviconPath }),
        ...(input.defaultThreadEnvMode === undefined
          ? {}
          : { defaultThreadEnvMode: input.defaultThreadEnvMode }),
        ...(input.scripts === undefined ? {} : { scripts: input.scripts }),
        ...(additionalDirectories === undefined ? {} : { additionalDirectories }),
        ...(input.pinned === undefined ? {} : { pinned: input.pinned }),
        ...(input.archived === undefined ? {} : { archived: input.archived }),
      });
      if (relocating) {
        // A turn that started between the two passes opened its session at
        // the old root; this pass detaches it.
        yield* listLiveProjectThreads(input.projectId).pipe(
          Effect.flatMap((threads) =>
            relocateThreads({
              commandId: input.commandId,
              projectId: input.projectId,
              threads,
              fromRoot: previousRoot,
              toRoot: workspaceRoot,
              phase: "settle",
            }),
          ),
          Effect.catchCause((cause) =>
            Effect.logWarning("Could not list threads after a project move.", cause),
          ),
        );
        yield* repairWorktrees(input.projectId, workspaceRoot);
        yield* projectEnrichment.invalidate([previousRoot, workspaceRoot]);
      }
      return yield* readCommitted(input.projectId);
    },
  );

  const bootstrap: ProjectService["Service"]["bootstrap"] = Effect.fn("ProjectService.bootstrap")(
    function* (input) {
      const existing = yield* getByWorkspaceRoot(input.workspaceRoot);
      if (Option.isSome(existing)) return { project: existing.value, created: false };
      return { project: yield* create(input), created: true };
    },
  );

  const deleteChildThread = Effect.fn("ProjectService.deleteChildThread")(function* (
    input: ProjectDeleteInput,
    threadId: ThreadId,
  ) {
    yield* legacyImporter.ensureTranscript(threadId);
    const projection = yield* threadProjections.getThreadRecords(threadId, [
      "runs",
      "attempts",
      "nodes",
      "runtimeRequests",
      "subagents",
      "providerSessions",
    ]);
    if (projection.thread.deletedAt !== null || projection.thread.projectId !== input.projectId) {
      return;
    }
    const command = {
      type: "thread.delete" as const,
      commandId: CommandId.make(`${input.commandId}:delete-thread:${threadId}`),
      threadId,
    };
    const now = yield* DateTime.now;
    const plan = yield* planThreadDeletion({
      command,
      projection,
      attachmentIds: yield* threadProjections.getThreadAttachmentIds(threadId),
      now,
      idAllocator,
    });
    const committed = yield* eventSink.commitCommand({
      commandId: command.commandId,
      commandType: command.type,
      threadId,
      acceptedAt: now,
      events: plan.events,
      effects: plan.effects,
    });
    if (
      committed.receipt.threadId !== command.threadId ||
      committed.receipt.commandType !== command.type
    ) {
      return yield* Effect.fail("The thread deletion command ID belongs to a different command.");
    }
    if (committed.receipt.status === "rejected") {
      return yield* Effect.fail(
        committed.receipt.error ?? "Thread deletion was previously rejected.",
      );
    }
  });

  const deleteChildThreads = Effect.fn("ProjectService.deleteChildThreads")(function* (
    input: ProjectDeleteInput,
  ) {
    const { projectId } = input;
    const snapshot = yield* threadProjections
      .getShellSnapshot({ projectId })
      .pipe(
        Effect.mapError(
          (cause) => new ProjectOperationError({ operation: "list-threads", projectId, cause }),
        ),
      );
    const projectThreads = [...snapshot.threads, ...snapshot.archivedThreads];
    if (projectThreads.length > 0 && input.force !== true) {
      return yield* new ProjectNotEmptyError({ projectId });
    }
    // Delete children durably before the project so a failed cascade can be retried.
    yield* Effect.forEach(
      projectThreads,
      (thread) =>
        threadCommands
          .withLock(thread.id, deleteChildThread(input, thread.id))
          .pipe(
            Effect.mapError(
              (cause) =>
                new ProjectOperationError({ operation: "delete-thread", projectId, cause }),
            ),
          ),
      { concurrency: 1, discard: true },
    );
  });

  // Best-effort cleanup releases disabled instances kept alive by overrides; crashes have no replay to revisit deletion.
  const clearProjectSettingsOverrides = (projectId: ProjectId) =>
    serverSettings.updateSettings({ projectSettingsOverrides: { [projectId]: null } }).pipe(
      Effect.asVoid,
      Effect.catchCause((cause) =>
        Effect.logWarning(
          `Failed to clear settings overrides for deleted project ${projectId}.`,
          cause,
        ),
      ),
    );

  const deleteProject: ProjectService["Service"]["delete"] = Effect.fn("ProjectService.delete")(
    function* (input) {
      const { projectId } = input;
      // Read deleted rows so retries replay receipts and other command ids fail as not found.
      const existing = yield* readRow(projectId, { includeDeleted: true });
      if (Option.isNone(existing)) {
        return yield* new ProjectNotFoundError({ projectId });
      }

      const isFirstDelete = existing.value.deletedAt === null;
      if (isFirstDelete) {
        yield* deleteChildThreads(input);
      }
      yield* commit({ type: "project.delete", commandId: input.commandId, projectId });
      if (isFirstDelete) {
        yield* clearProjectSettingsOverrides(projectId);
      }
      yield* projectEnrichment.invalidate([existing.value.workspaceRoot]);
      return yield* readCommitted(projectId);
    },
  );

  const enrichShell = (shell: OrchestrationProjectShell) =>
    projectEnrichment.getAvailable(shell.workspaceRoot).pipe(
      Effect.map((enrichment) => ({
        ...shell,
        repositoryIdentity: enrichment.repositoryIdentity,
      })),
    );

  const getShell: ProjectService["Service"]["getShell"] = Effect.fn("ProjectService.getShell")(
    function* (projectId) {
      const shell = yield* projects
        .getShell(projectId)
        .pipe(
          Effect.mapError(
            (cause) => new ProjectOperationError({ operation: "read-project", projectId, cause }),
          ),
        );
      return Option.isNone(shell) ? shell : Option.some(yield* enrichShell(shell.value));
    },
  );

  const listShells: ProjectService["Service"]["listShells"] = Effect.fn(
    "ProjectService.listShells",
  )(function* (options) {
    const shells = yield* projects
      .listShells(options)
      .pipe(
        Effect.mapError(
          (cause) => new ProjectOperationError({ operation: "list-projects", cause }),
        ),
      );
    return yield* Effect.forEach(shells, enrichShell, { concurrency: 16 });
  });

  const snapshot = Effect.gen(function* () {
    const rows = yield* projects
      .list()
      .pipe(
        Effect.mapError(
          (cause) => new ProjectOperationError({ operation: "list-projects", cause }),
        ),
      );
    const hydrated = yield* Effect.forEach(rows, hydrate, { concurrency: 8 });
    return {
      projects: hydrated,
      updatedAt: DateTime.formatIso(yield* DateTime.now),
    } satisfies ProjectSnapshot;
  });

  const listPage: ProjectService["Service"]["listPage"] = Effect.fn("ProjectService.listPage")(
    function* ({ cursor, limit }) {
      const rows = (yield* snapshot).projects.filter((project) => project.deletedAt === null);
      const projects = yield* Effect.forEach(
        rows.slice(cursor, cursor + limit),
        (project) =>
          project.repositoryIdentity !== null
            ? Effect.succeed(project)
            : projectEnrichment
                .readRepositoryIdentity(project.workspaceRoot)
                .pipe(Effect.map((repositoryIdentity) => ({ ...project, repositoryIdentity }))),
        { concurrency: 8 },
      );
      return { projects, nextCursor: cursor + limit < rows.length ? cursor + limit : null };
    },
  );

  return ProjectService.of({
    create,
    bootstrap,
    update,
    delete: deleteProject,
    getById,
    getByWorkspaceRoot,
    snapshot,
    listPage,
    getShell,
    listShells,
  });
});

export const layer = Layer.effect(ProjectService, make).pipe(
  Layer.provide(ThreadCommandExecutor.layer),
);
