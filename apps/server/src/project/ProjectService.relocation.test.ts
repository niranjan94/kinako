import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CheckpointScopeId,
  CommandId,
  EventId,
  MessageId,
  NodeId,
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../config.ts";
import { ClaudeProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import * as EffectOutbox from "../orchestration-v2/EffectOutbox.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as EventStore from "../orchestration-v2/EventStore.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as LegacyV1ThreadImporter from "../orchestration-v2/legacy/LegacyV1ThreadImporter.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ThreadCommandExecutor from "../orchestration-v2/ThreadCommandExecutor.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import * as ProjectEnrichmentService from "./ProjectEnrichmentService.ts";
import * as ProjectFaviconResolver from "./ProjectFaviconResolver.ts";
import * as ProjectService from "./ProjectService.ts";
import * as RepositoryIdentityResolver from "./RepositoryIdentityResolver.ts";

const layerEventPersistence = EventSink.layer.pipe(
  Layer.provideMerge(Layer.merge(EventStore.layer, ProjectionStore.layer)),
);
const layerServices = (gitCalls: Ref.Ref<ReadonlyArray<ReadonlyArray<string>>>) =>
  Layer.mergeAll(
    LegacyV1ThreadImporter.layer.pipe(Layer.provideMerge(layerEventPersistence)),
    ProjectStore.layer,
    IdAllocator.layer,
    ThreadCommandExecutor.layer,
    EffectOutbox.layer,
    Layer.mock(GitVcsDriver.GitVcsDriver)({
      execute: (input) =>
        Ref.update(gitCalls, (calls) => [...calls, [input.cwd, ...input.args]]).pipe(
          Effect.as({
            exitCode: 0 as never,
            stdout: "",
            stderr: "",
            stdoutTruncated: false,
            stderrTruncated: false,
          }),
        ),
    }),
    Layer.succeed(WorkspacePaths.WorkspacePaths, {
      normalizeWorkspaceRoot: (workspaceRoot) => Effect.succeed(workspaceRoot),
      resolveRelativePathWithinRoot: ({ workspaceRoot, relativePath }) =>
        Effect.succeed({ absolutePath: `${workspaceRoot}/${relativePath}`, relativePath }),
    }),
  ).pipe(
    Layer.provideMerge(
      ProjectEnrichmentService.layer.pipe(
        Layer.provide(
          Layer.merge(
            Layer.succeed(RepositoryIdentityResolver.RepositoryIdentityResolver, {
              resolve: () => Effect.succeed(null),
            }),
            Layer.succeed(ProjectFaviconResolver.ProjectFaviconResolver, {
              resolvePath: () => Effect.succeed(null),
            }),
          ),
        ),
      ),
    ),
    Layer.provideMerge(ServerSettings.layerTest()),
  );
const layerDatabase = SqlitePersistence.layerMemory.pipe(
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "project-relocation-test-" })),
  Layer.provideMerge(NodeServices.layer),
);

const projectId = ProjectId.make("project:relocation");
const createdAt = DateTime.makeUnsafe("2026-01-01T00:00:00.000Z");
const providerInstanceId = ProviderInstanceId.make("claude");
const claudeDriver = ProviderDriverKind.make("claudeAgent");

const seedProject = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    INSERT INTO projection_projects (
      project_id, title, workspace_root, default_model_selection_json,
      scripts_json, created_at, updated_at, deleted_at
    ) VALUES (
      ${projectId}, 'Relocation test', '/work/old', NULL,
      '[]', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', NULL
    )
  `;
});

function threadEvents(input: {
  readonly threadId: ThreadId;
  readonly worktreePath: string | null;
  readonly scopeCwd: string;
  readonly sessionCwd?: string;
  readonly runStatus?: "running" | "completed";
}): ReadonlyArray<OrchestrationV2DomainEvent> {
  const { threadId } = input;
  const thread: OrchestrationV2AppThread = {
    createdBy: "user",
    creationSource: "web",
    id: threadId,
    projectId,
    title: threadId,
    providerInstanceId,
    modelSelection: { instanceId: providerInstanceId, model: "claude-opus-5-5" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: input.worktreePath === null ? null : `branch/${threadId}`,
    worktreePath: input.worktreePath,
    activeProviderThreadId: null,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
    forkedFrom: null,
    createdAt,
    updatedAt: createdAt,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  };
  const runId = RunId.make(`run:${threadId}`);
  const nodeId = NodeId.make(`node:${threadId}`);
  return [
    {
      id: EventId.make(`created:${threadId}`),
      type: "thread.created",
      threadId,
      providerInstanceId,
      occurredAt: createdAt,
      payload: thread,
    },
    {
      id: EventId.make(`run:${threadId}`),
      type: "run.created",
      threadId,
      runId,
      providerInstanceId,
      occurredAt: createdAt,
      payload: {
        id: runId,
        threadId,
        ordinal: 1,
        providerInstanceId,
        modelSelection: thread.modelSelection,
        providerThreadId: null,
        userMessageId: MessageId.make(`message:${threadId}`),
        rootNodeId: nodeId,
        activeAttemptId: null,
        status: input.runStatus ?? "completed",
        requestedAt: createdAt,
        startedAt: createdAt,
        completedAt: input.runStatus === "running" ? null : createdAt,
        checkpointId: null,
        contextHandoffId: null,
      },
    },
    {
      id: EventId.make(`scope:${threadId}`),
      type: "checkpoint-scope.created",
      threadId,
      runId,
      nodeId,
      occurredAt: createdAt,
      payload: {
        id: CheckpointScopeId.make(`scope:${threadId}`),
        threadId,
        runId,
        nodeId,
        parentScopeId: null,
        providerThreadId: null,
        kind: "root_run",
        ordinalWithinParent: 0,
        advancesAppRunCount: true,
        cwd: input.scopeCwd,
        createdAt,
      },
    },
    ...(input.sessionCwd === undefined
      ? []
      : [
          {
            id: EventId.make(`session:${threadId}`),
            type: "provider-session.attached" as const,
            threadId,
            driver: claudeDriver,
            providerInstanceId,
            occurredAt: createdAt,
            payload: {
              id: ProviderSessionId.make(`session:${threadId}`),
              driver: claudeDriver,
              providerInstanceId,
              status: "ready" as const,
              cwd: input.sessionCwd,
              model: null,
              capabilities: ClaudeProviderCapabilitiesV2,
              createdAt,
              updatedAt: createdAt,
              lastError: null,
            },
          },
        ]),
  ];
}

it.effect("moves threads, checkpoint scopes, and live sessions to the new project root", () =>
  Effect.gen(function* () {
    const gitCalls = yield* Ref.make<ReadonlyArray<ReadonlyArray<string>>>([]);
    yield* Effect.gen(function* () {
      yield* seedProject;
      const eventSink = yield* EventSink.EventSinkV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const main = ThreadId.make("thread:main");
      const nested = ThreadId.make("thread:nested");
      const managed = ThreadId.make("thread:managed");
      yield* eventSink.write({
        events: [
          ...threadEvents({
            threadId: main,
            worktreePath: null,
            scopeCwd: "/work/old",
            sessionCwd: "/work/old",
          }),
          ...threadEvents({
            threadId: nested,
            worktreePath: "/work/old/.worktrees/nested",
            scopeCwd: "/work/old/.worktrees/nested",
          }),
          // Handed off from the main checkout to a worktree outside the root.
          ...threadEvents({
            threadId: managed,
            worktreePath: "/home/worktrees/managed",
            scopeCwd: "/work/old",
            sessionCwd: "/home/worktrees/managed",
          }),
        ],
      });
      const service = yield* ProjectService.make;

      const moved = yield* service.update({
        commandId: CommandId.make("command:relocate"),
        projectId,
        workspaceRoot: "/work/new",
      });

      assert.equal(moved.workspaceRoot, "/work/new");
      const read = (threadId: ThreadId) =>
        projections.getThreadRecords(threadId, ["checkpointScopes", "providerSessions"]);
      const mainRecords = yield* read(main);
      assert.isNull(mainRecords.thread.worktreePath);
      assert.deepEqual(
        mainRecords.checkpointScopes.map((scope) => scope.cwd),
        ["/work/new"],
      );
      const nestedRecords = yield* read(nested);
      assert.equal(nestedRecords.thread.worktreePath, "/work/new/.worktrees/nested");
      assert.deepEqual(
        nestedRecords.checkpointScopes.map((scope) => scope.cwd),
        ["/work/new/.worktrees/nested"],
      );
      const managedRecords = yield* read(managed);
      assert.equal(managedRecords.thread.worktreePath, "/home/worktrees/managed");
      assert.deepEqual(
        managedRecords.checkpointScopes.map((scope) => scope.cwd),
        ["/work/new"],
      );

      const sql = yield* SqlClient.SqlClient;
      const detaches = yield* sql<{ readonly thread_id: string }>`
        SELECT thread_id FROM orchestration_v2_effect_outbox
        WHERE effect_type = 'provider-session.detach'
      `;
      assert.deepEqual(
        detaches.map((row) => row.thread_id),
        [main],
      );
      assert.deepEqual(yield* Ref.get(gitCalls), [
        [
          "/work/new",
          "worktree",
          "repair",
          "/home/worktrees/managed",
          "/work/new/.worktrees/nested",
        ],
      ]);

      const replayed = yield* service.update({
        commandId: CommandId.make("command:relocate-again"),
        projectId,
        workspaceRoot: "/work/new",
      });
      assert.equal(replayed.workspaceRoot, "/work/new");
      assert.lengthOf(yield* Ref.get(gitCalls), 1);
    }).pipe(Effect.provide(layerServices(gitCalls)));
  }).pipe(Effect.provide(layerDatabase)),
);

it.effect("rebases paths once when the new root is inside the old one", () =>
  Effect.gen(function* () {
    const gitCalls = yield* Ref.make<ReadonlyArray<ReadonlyArray<string>>>([]);
    yield* Effect.gen(function* () {
      yield* seedProject;
      const eventSink = yield* EventSink.EventSinkV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const main = ThreadId.make("thread:main");
      const nested = ThreadId.make("thread:nested");
      yield* eventSink.write({
        events: [
          ...threadEvents({ threadId: main, worktreePath: null, scopeCwd: "/work/old" }),
          ...threadEvents({
            threadId: nested,
            worktreePath: "/work/old/.worktrees/nested",
            scopeCwd: "/work/old/.worktrees/nested",
          }),
        ],
      });
      const service = yield* ProjectService.make;

      yield* service.update({
        commandId: CommandId.make("command:relocate-into-subfolder"),
        projectId,
        workspaceRoot: "/work/old/app",
      });

      const mainRecords = yield* projections.getThreadRecords(main, ["checkpointScopes"]);
      assert.deepEqual(
        mainRecords.checkpointScopes.map((scope) => scope.cwd),
        ["/work/old/app"],
      );
      const nestedRecords = yield* projections.getThreadRecords(nested, ["checkpointScopes"]);
      assert.equal(nestedRecords.thread.worktreePath, "/work/old/app/.worktrees/nested");
      assert.deepEqual(
        nestedRecords.checkpointScopes.map((scope) => scope.cwd),
        ["/work/old/app/.worktrees/nested"],
      );
    }).pipe(Effect.provide(layerServices(gitCalls)));
  }).pipe(Effect.provide(layerDatabase)),
);

it.effect("refuses to move a project while a thread is running and changes nothing", () =>
  Effect.gen(function* () {
    const gitCalls = yield* Ref.make<ReadonlyArray<ReadonlyArray<string>>>([]);
    yield* Effect.gen(function* () {
      yield* seedProject;
      const eventSink = yield* EventSink.EventSinkV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const idle = ThreadId.make("thread:idle");
      const busy = ThreadId.make("thread:busy");
      yield* eventSink.write({
        events: [
          ...threadEvents({
            threadId: idle,
            worktreePath: "/work/old/.worktrees/idle",
            scopeCwd: "/work/old/.worktrees/idle",
          }),
          ...threadEvents({
            threadId: busy,
            worktreePath: null,
            scopeCwd: "/work/old",
            runStatus: "running",
          }),
        ],
      });
      const service = yield* ProjectService.make;

      const failure = yield* service
        .update({
          commandId: CommandId.make("command:blocked"),
          projectId,
          workspaceRoot: "/work/new",
        })
        .pipe(Effect.flip);

      assert.instanceOf(failure, ProjectService.ProjectRelocationBlockedError);
      if (failure._tag !== "ProjectRelocationBlockedError") return;
      assert.deepEqual(failure.threads, [{ threadId: busy, title: busy, blocker: "active_turn" }]);
      assert.equal(Option.getOrThrow(yield* service.getById(projectId)).workspaceRoot, "/work/old");
      const idleRecords = yield* projections.getThreadRecords(idle, ["checkpointScopes"]);
      assert.equal(idleRecords.thread.worktreePath, "/work/old/.worktrees/idle");
      assert.deepEqual(yield* Ref.get(gitCalls), []);
    }).pipe(Effect.provide(layerServices(gitCalls)));
  }).pipe(Effect.provide(layerDatabase)),
);

it.effect("refuses a folder another project owns before touching any thread", () =>
  Effect.gen(function* () {
    const gitCalls = yield* Ref.make<ReadonlyArray<ReadonlyArray<string>>>([]);
    yield* Effect.gen(function* () {
      yield* seedProject;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`
        INSERT INTO projection_projects (
          project_id, title, workspace_root, default_model_selection_json,
          scripts_json, created_at, updated_at, deleted_at
        ) VALUES (
          'project:owner', 'Owner', '/work/new', NULL,
          '[]', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', NULL
        )
      `;
      const eventSink = yield* EventSink.EventSinkV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const nested = ThreadId.make("thread:nested");
      yield* eventSink.write({
        events: threadEvents({
          threadId: nested,
          worktreePath: "/work/old/.worktrees/nested",
          scopeCwd: "/work/old/.worktrees/nested",
        }),
      });
      const service = yield* ProjectService.make;

      const failure = yield* service
        .update({
          commandId: CommandId.make("command:conflict"),
          projectId,
          workspaceRoot: "/work/new",
        })
        .pipe(Effect.flip);

      assert.instanceOf(failure, ProjectService.ProjectConflictError);
      const records = yield* projections.getThreadRecords(nested, ["checkpointScopes"]);
      assert.equal(records.thread.worktreePath, "/work/old/.worktrees/nested");
      assert.deepEqual(
        records.checkpointScopes.map((scope) => scope.cwd),
        ["/work/old/.worktrees/nested"],
      );
    }).pipe(Effect.provide(layerServices(gitCalls)));
  }).pipe(Effect.provide(layerDatabase)),
);
