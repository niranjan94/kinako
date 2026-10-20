import {
  DEFAULT_MODEL,
  DEFAULT_MODEL_BY_PROVIDER,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  AgentSessionImportFailedError,
  AgentSessionImportProjectChangedError,
  AgentSessionImportProjectNotFoundError,
  AgentSessionImportSource,
  AgentSessionNotFoundError,
  AgentSessionScanError,
  AgentSessionSource,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderThreadId,
  ThreadId,
  TurnItemId,
  type AgentSessionImportInput,
  type AgentSessionImportResult,
  type AgentSessionImportSessionInput,
  type AgentSessionImportSessionResult,
  type AgentSessionListInput,
  type AgentSessionListItem,
  type AgentSessionListResult,
  type OrchestrationV2AppThread,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import { normalizeProjectPathForComparison } from "@t3tools/shared/path";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProviderSessionRuntime from "../persistence/ProviderSessionRuntime.ts";
import * as AgentSessionScanner from "./AgentSessionScanner.ts";
import * as ProjectService from "./ProjectService.ts";

const IMPORT_EVENT_PREFIX = "agent-session-import:v2";
const CLAUDE_SESSION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const decodeImportedTranscriptPayload = Schema.decodeUnknownOption(
  Schema.Struct({
    cwd: Schema.optional(Schema.String),
    importedTranscripts: Schema.optional(Schema.Array(AgentSessionImportSource)),
  }),
);

class AgentSessionUnresumableSessionError extends Schema.TaggedError<AgentSessionUnresumableSessionError>()(
  "AgentSessionUnresumableSessionError",
  {
    source: AgentSessionSource,
    providerSessionId: Schema.String,
  },
) {
  override get message(): string {
    return `Session '${this.providerSessionId}' from '${this.source}' cannot be resumed.`;
  }
}

class AgentSessionThreadProjectConflictError extends Schema.TaggedError<AgentSessionThreadProjectConflictError>()(
  "AgentSessionThreadProjectConflictError",
  {
    threadId: ThreadId,
    expectedProjectId: ProjectId,
    actualProjectId: ProjectId,
  },
) {
  override get message(): string {
    return `This session was already imported into another project as thread '${this.threadId}'.`;
  }
}

class AgentSessionThreadModifiedError extends Schema.TaggedError<AgentSessionThreadModifiedError>()(
  "AgentSessionThreadModifiedError",
  { threadId: ThreadId },
) {
  override get message(): string {
    return `Imported thread '${this.threadId}' already contains non-imported activity.`;
  }
}

function dateTime(value: string): DateTime.Utc {
  return DateTime.makeUnsafe(value);
}

function messageEvents(input: {
  readonly threadId: ThreadId;
  readonly index: number;
  readonly message: AgentSessionScanner.AgentSessionThreadMessage;
}): ReadonlyArray<OrchestrationV2DomainEvent> {
  const ordinal = input.index + 1;
  const suffix = String(input.index).padStart(6, "0");
  const messageId = MessageId.make(`${input.threadId}:${suffix}`);
  const turnItemId = TurnItemId.make(
    `${IMPORT_EVENT_PREFIX}:turn-item:${input.threadId}:${suffix}`,
  );
  const at = dateTime(input.message.createdAt);
  const message: OrchestrationV2ConversationMessage = {
    createdBy: input.message.role === "user" ? "user" : "agent",
    creationSource: "server",
    id: messageId,
    threadId: input.threadId,
    runId: null,
    nodeId: null,
    role: input.message.role,
    text: input.message.text,
    attachments: [],
    streaming: false,
    createdAt: at,
    updatedAt: at,
  };
  const common = {
    id: turnItemId,
    threadId: input.threadId,
    runId: null,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal,
    status: "completed" as const,
    title: null,
    startedAt: at,
    completedAt: at,
    updatedAt: at,
  };
  const turnItem: OrchestrationV2TurnItem =
    input.message.role === "user"
      ? {
          ...common,
          createdBy: "user",
          creationSource: "server",
          type: "user_message",
          messageId,
          inputIntent: "turn_start",
          text: input.message.text,
          attachments: [],
        }
      : {
          ...common,
          type: "assistant_message",
          messageId,
          text: input.message.text,
          streaming: false,
        };
  return [
    {
      id: EventId.make(`${IMPORT_EVENT_PREFIX}:message:${input.threadId}:${suffix}`),
      type: "message.updated",
      threadId: input.threadId,
      occurredAt: at,
      payload: message,
    },
    {
      id: EventId.make(`${IMPORT_EVENT_PREFIX}:turn-item:${input.threadId}:${suffix}`),
      type: "turn-item.updated",
      threadId: input.threadId,
      occurredAt: at,
      payload: turnItem,
    },
  ];
}

/**
 * The thread an imported native session becomes, the same for every import of it. A later
 * generation replaces a thread the user deleted, since deleted threads cannot be restored.
 */
export function importedThreadId(
  source: {
    readonly providerInstanceId: AgentSessionImportSource["providerInstanceId"];
    readonly providerSessionId: string;
  },
  generation = 0,
): ThreadId {
  const base = `import:${source.providerInstanceId}:${source.providerSessionId}`;
  return ThreadId.make(generation === 0 ? base : `${base}:${generation}`);
}

const MAX_IMPORT_GENERATIONS = 100;

/** Events that create an imported thread with its visible history, bound to its native session. */
export function importedThreadEvents(input: {
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  readonly providerThreadId: OrchestrationV2ProviderThread["id"];
  readonly thread: AgentSessionScanner.AgentSessionThread;
}): ReadonlyArray<OrchestrationV2DomainEvent> {
  const { threadId, thread, providerThreadId } = input;
  const driver = ProviderDriverKind.make(thread.source);
  const model = thread.model ?? DEFAULT_MODEL_BY_PROVIDER[driver] ?? DEFAULT_MODEL;
  const createdAt = dateTime(thread.createdAt);
  const updatedAt = dateTime(thread.updatedAt);
  const appThread: OrchestrationV2AppThread = {
    createdBy: "system",
    creationSource: "server",
    id: threadId,
    projectId: input.projectId,
    title: thread.title.trim() === "" ? "Untitled thread" : thread.title,
    providerInstanceId: thread.providerInstanceId,
    modelSelection: { instanceId: thread.providerInstanceId, model },
    runtimeMode: DEFAULT_RUNTIME_MODE,
    interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
    branch: null,
    worktreePath: null,
    linkedPullRequest: null,
    branchPullRequest: null,
    activeProviderThreadId: providerThreadId,
    historyOrigin: "v1_import",
    lineage: {
      parentThreadId: null,
      relationshipToParent: null,
      rootThreadId: threadId,
    },
    forkedFrom: null,
    createdAt,
    updatedAt,
    archivedAt: null,
    settledOverride: "settled",
    settledAt: updatedAt,
    unsettledAt: null,
    snoozedUntil: null,
    snoozedAt: null,
    pinnedAt: null,
    pinOrderKey: null,
    activeOrderKey: null,
    lastVisitedAt: null,
    deletedAt: null,
  };
  const providerThread: OrchestrationV2ProviderThread = {
    id: providerThreadId,
    driver,
    providerInstanceId: thread.providerInstanceId,
    providerSessionId: null,
    appThreadId: threadId,
    ownerNodeId: null,
    nativeThreadRef: {
      driver,
      nativeId: thread.providerSessionId,
      strength: "strong",
    },
    nativeConversationHeadRef: null,
    status: "idle",
    firstRunOrdinal: null,
    lastRunOrdinal: null,
    handoffIds: [],
    forkedFrom: null,
    pendingBackgroundTasks: [],
    nativeMetadata: { importedNativeThreadId: thread.providerSessionId },
    createdAt,
    updatedAt,
  };
  return [
    {
      id: EventId.make(`${IMPORT_EVENT_PREFIX}:thread:${threadId}:created`),
      type: "thread.created",
      threadId,
      providerInstanceId: thread.providerInstanceId,
      occurredAt: createdAt,
      payload: appThread,
    },
    ...thread.messages.flatMap((message, index) => messageEvents({ threadId, index, message })),
    {
      id: EventId.make(`${IMPORT_EVENT_PREFIX}:provider-thread:${providerThreadId}`),
      type: "provider-thread.updated",
      threadId,
      driver,
      providerInstanceId: thread.providerInstanceId,
      occurredAt: updatedAt,
      payload: providerThread,
    },
  ];
}

const make = Effect.gen(function* () {
  const scanner = yield* AgentSessionScanner.AgentSessionScanner;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const projects = yield* ProjectService.ProjectService;
  const eventSink = yield* EventSink.EventSinkV2;
  const idAllocator = yield* IdAllocator.IdAllocatorV2;
  const runtimes = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;

  /** Write one parsed session as a thread, or adopt the thread a previous import created. */
  const importThread = Effect.fn("importAgentSessionThread")(function* (input: {
    readonly projectId: ProjectId;
    readonly workspaceRoot: string;
    readonly thread: AgentSessionScanner.AgentSessionThread;
    readonly source: AgentSessionImportSource;
    readonly generation?: number;
  }) {
    const { thread, source } = input;
    const generation = input.generation ?? 0;
    const threadId = importedThreadId(source, generation);
    if (
      thread.source === "claudeAgent" &&
      !CLAUDE_SESSION_ID_PATTERN.test(thread.providerSessionId)
    ) {
      return yield* new AgentSessionUnresumableSessionError({
        source: thread.source,
        providerSessionId: thread.providerSessionId,
      });
    }
    const existing = yield* Effect.option(orchestrator.getThreadRecords(threadId, []));
    if (Option.isSome(existing)) {
      if (existing.value.thread.projectId !== input.projectId) {
        return yield* new AgentSessionThreadProjectConflictError({
          threadId,
          expectedProjectId: input.projectId,
          actualProjectId: existing.value.thread.projectId,
        });
      }
      if (existing.value.thread.historyOrigin !== "v1_import") {
        return yield* new AgentSessionThreadModifiedError({ threadId });
      }
      yield* runtimes.recordImportedTranscript({ threadId, source });
      return { threadId, imported: false } as const;
    }

    const driver = ProviderDriverKind.make(thread.source);
    yield* runtimes.upsert(
      {
        threadId,
        providerName: driver,
        providerInstanceId: thread.providerInstanceId,
        adapterKey: driver,
        runtimeMode: DEFAULT_RUNTIME_MODE,
        status: "stopped",
        lastSeenAt: thread.updatedAt,
        resumeCursor:
          thread.source === "codex"
            ? { threadId: thread.providerSessionId }
            : { threadId, resume: thread.providerSessionId },
        runtimePayload: { cwd: input.workspaceRoot },
      },
      { onConflict: "ignore" },
    );
    const providerThreadId = idAllocator.derive.providerThread({
      driver,
      nativeThreadId: thread.providerSessionId,
    });
    yield* eventSink.write({
      events: importedThreadEvents({
        threadId,
        projectId: input.projectId,
        // Provider thread ids are global, so a deleted import keeps its own.
        providerThreadId:
          generation === 0
            ? providerThreadId
            : ProviderThreadId.make(`${providerThreadId}:${generation}`),
        thread,
      }),
    });
    yield* runtimes.recordImportedTranscript({ threadId, source });
    return { threadId, imported: true } as const;
  });

  const readProject = (projectId: ProjectId) =>
    projects.getById(projectId).pipe(
      Effect.mapError((cause) => new AgentSessionScanError({ operation: "read-projects", cause })),
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.fail(new AgentSessionImportProjectNotFoundError({ projectId })),
          onSome: Effect.succeed,
        }),
      ),
    );

  /**
   * The generation an import of this session uses, and its live thread if there is one. A null
   * project accepts a live thread in any project.
   */
  const resolveImportGeneration = Effect.fn("resolveAgentSessionImportGeneration")(function* (
    session: Parameters<typeof importedThreadId>[0],
    projectId: ProjectId | null,
  ) {
    for (let generation = 0; generation < MAX_IMPORT_GENERATIONS; generation++) {
      const threadId = importedThreadId(session, generation);
      const existing = yield* Effect.option(orchestrator.getThreadRecords(threadId, []));
      if (Option.isNone(existing)) return { generation, liveThreadId: null };
      if (existing.value.thread.deletedAt === null) {
        // Another project's thread is not this project's to open; importing reports the conflict.
        return {
          generation,
          liveThreadId:
            projectId === null || existing.value.thread.projectId === projectId ? threadId : null,
        };
      }
    }
    return { generation: MAX_IMPORT_GENERATIONS, liveThreadId: null };
  });

  const listSessions = Effect.fn("listAgentSessions")(function* (input: AgentSessionListInput) {
    // A scanned folder may not be a project yet, and its sessions may live in any project.
    const target =
      "projectId" in input
        ? {
            workspaceRoot: (yield* readProject(input.projectId)).workspaceRoot,
            projectId: input.projectId,
          }
        : { workspaceRoot: input.workspaceRoot, projectId: null };
    const listed = yield* scanner.listSessions(target.workspaceRoot, {
      ...(input.maxAgeMs === undefined ? {} : { maxAgeMs: input.maxAgeMs }),
      ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
      reuseDiscovery: target.projectId === null,
    });
    const sessions = yield* Effect.forEach(
      listed.sessions,
      (summary) =>
        resolveImportGeneration(summary, target.projectId).pipe(
          Effect.map(({ liveThreadId }): AgentSessionListItem => ({
            provider: summary.source,
            providerInstanceId: summary.providerInstanceId,
            providerSessionId: summary.providerSessionId,
            title: summary.title,
            updatedAt: summary.updatedAt,
            importedThreadId: liveThreadId,
          })),
        ),
      { concurrency: 16 },
    );
    return {
      sessions,
      ...(listed.nextCursor === null ? {} : { nextCursor: listed.nextCursor }),
    } satisfies AgentSessionListResult;
  });

  const importSession = Effect.fn("importAgentSession")(function* (
    input: AgentSessionImportSessionInput,
  ) {
    const project = yield* readProject(input.projectId);
    const { generation, liveThreadId } = yield* resolveImportGeneration(input, input.projectId);
    if (liveThreadId !== null) {
      return { threadId: liveThreadId, imported: false } satisfies AgentSessionImportSessionResult;
    }
    const session = yield* scanner.readSession({
      workspaceRoot: project.workspaceRoot,
      providerInstanceId: input.providerInstanceId,
      providerSessionId: input.providerSessionId,
    });
    if (Option.isNone(session)) {
      return yield* new AgentSessionNotFoundError({
        providerInstanceId: input.providerInstanceId,
        providerSessionId: input.providerSessionId,
      });
    }
    return yield* importThread({
      projectId: input.projectId,
      workspaceRoot: project.workspaceRoot,
      thread: session.value.thread,
      source: session.value.source,
      generation,
    }).pipe(
      Effect.mapError(
        (cause) =>
          new AgentSessionImportFailedError({ providerSessionId: input.providerSessionId, cause }),
      ),
    );
  });

  const importRecentAgentThreads = Effect.fn("importRecentAgentThreadsV2")(function* (
    input: AgentSessionImportInput,
  ) {
    const project = yield* readProject(input.projectId);
    if (
      input.expectedWorkspaceRoot !== undefined &&
      normalizeProjectPathForComparison(project.workspaceRoot) !==
        normalizeProjectPathForComparison(input.expectedWorkspaceRoot)
    ) {
      return yield* new AgentSessionImportProjectChangedError({ projectId: input.projectId });
    }
    const runtimeRows = yield* runtimes
      .list()
      .pipe(
        Effect.mapError(
          (cause) => new AgentSessionScanError({ operation: "read-projects", cause }),
        ),
      );
    const completedSources = runtimeRows.flatMap((runtime) => {
      const payload = decodeImportedTranscriptPayload(runtime.runtimePayload);
      if (
        Option.isNone(payload) ||
        payload.value.cwd === undefined ||
        normalizeProjectPathForComparison(payload.value.cwd) !==
          normalizeProjectPathForComparison(project.workspaceRoot)
      ) {
        return [];
      }
      return payload.value.importedTranscripts ?? [];
    });
    const outcomes = scanner.recentThreads(project.workspaceRoot, completedSources);
    const importedThreadIds = new Set<ThreadId>();
    let importedCount = 0;
    let skippedCount = 0;

    yield* Stream.runForEach(outcomes, (outcome) =>
      Effect.gen(function* () {
        if (outcome._tag === "Skipped") {
          skippedCount += 1;
          return;
        }
        const source = outcome.source;
        const threadId = importedThreadId(source);
        if (outcome._tag === "AlreadyImported") {
          importedThreadIds.add(threadId);
          importedCount += 1;
          return;
        }
        if (outcome._tag === "Duplicate") {
          if (importedThreadIds.has(threadId)) {
            yield* runtimes.recordImportedTranscript({ threadId, source }).pipe(Effect.ignore);
          }
          return;
        }

        const imported = yield* importThread({
          projectId: input.projectId,
          workspaceRoot: project.workspaceRoot,
          thread: outcome.thread,
          source,
        }).pipe(
          Effect.as(true),
          Effect.catch((cause) =>
            Effect.logWarning("Could not import an agent session", {
              provider: outcome.thread.source,
              sessionId: outcome.thread.providerSessionId,
              cause,
            }).pipe(Effect.as(false)),
          ),
        );
        if (imported) {
          importedThreadIds.add(threadId);
          importedCount += 1;
        } else {
          skippedCount += 1;
        }
      }),
    );

    return { importedCount, skippedCount } satisfies AgentSessionImportResult;
  });

  return { importRecentAgentThreads, listSessions, importSession };
});

type AgentSessionImporterShape = Effect.Success<typeof make>;

export class AgentSessionImporter extends Context.Service<
  AgentSessionImporter,
  AgentSessionImporterShape
>()("t3/project/AgentSessionImporter") {}

export const layer = Layer.effect(AgentSessionImporter, make);
