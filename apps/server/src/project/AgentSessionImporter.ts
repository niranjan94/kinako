import {
  DEFAULT_MODEL,
  DEFAULT_MODEL_BY_PROVIDER,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  isRuntimeModeAbove,
  AgentSessionImportFailedError,
  AgentSessionImportProjectChangedError,
  AgentSessionImportProjectNotFoundError,
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
  type AgentSessionImportSource,
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
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
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
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadCommandExecutor from "../orchestration-v2/ThreadCommandExecutor.ts";
import * as ProviderSessionRuntime from "../persistence/ProviderSessionRuntime.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as AgentSessionScanner from "./AgentSessionScanner.ts";
import * as ProjectService from "./ProjectService.ts";

const IMPORT_EVENT_PREFIX = "agent-session-import:v2";
const CLAUDE_SESSION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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

class AgentSessionNativeThreadOwnedError extends Schema.TaggedError<AgentSessionNativeThreadOwnedError>()(
  "AgentSessionNativeThreadOwnedError",
  {},
) {
  override get message(): string {
    return "This session already belongs to another thread.";
  }
}

// ACP imports read the history while holding the session-mutation lock, and an agent can
// leave session/resume or initialize unanswered. Longer than session/load's own deadline.
const NATIVE_HISTORY_READ_TIMEOUT = "2 minutes";

/**
 * Whether a thread bound to a native session still lacks its native history.
 * Once a turn has run, the native session also holds that turn's messages, so
 * its history can no longer be imported as run-less items.
 */
export function isNativeHistoryPending(input: {
  readonly historyOrigin: OrchestrationV2AppThread["historyOrigin"];
  readonly hasRun: boolean;
}): boolean {
  return input.historyOrigin !== "v1_import" && !input.hasRun;
}

function dateTime(value: string): DateTime.Utc {
  return DateTime.makeUnsafe(value);
}

type HistoryMessage = Omit<AgentSessionScanner.AgentSessionThreadMessage, "role"> & {
  readonly role: AgentSessionScanner.AgentSessionThreadMessage["role"] | "reasoning";
};

function messageEvents(input: {
  readonly threadId: ThreadId;
  readonly index: number;
  readonly message: HistoryMessage;
}): ReadonlyArray<OrchestrationV2DomainEvent> {
  const ordinal = input.index + 1;
  const suffix = String(input.index).padStart(6, "0");
  const messageId = MessageId.make(`${input.threadId}:${suffix}`);
  const turnItemId = TurnItemId.make(
    `${IMPORT_EVENT_PREFIX}:turn-item:${input.threadId}:${suffix}`,
  );
  const at = dateTime(input.message.createdAt);
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
  const turnItemEvent = (payload: OrchestrationV2TurnItem): OrchestrationV2DomainEvent => ({
    id: EventId.make(turnItemId),
    type: "turn-item.updated",
    threadId: input.threadId,
    occurredAt: at,
    payload,
  });
  if (input.message.role === "reasoning") {
    return [
      turnItemEvent({ ...common, type: "reasoning", text: input.message.text, streaming: false }),
    ];
  }
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
    turnItemEvent(turnItem),
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
  readonly nativeThreadId?: string;
  readonly runtimeMode?: OrchestrationV2AppThread["runtimeMode"];
}): ReadonlyArray<OrchestrationV2DomainEvent> {
  const { threadId, thread, providerThreadId } = input;
  const nativeThreadId = input.nativeThreadId ?? thread.providerSessionId;
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
    runtimeMode: input.runtimeMode ?? DEFAULT_RUNTIME_MODE,
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
      nativeId: nativeThreadId,
      strength: "strong",
    },
    nativeConversationHeadRef: null,
    status: "idle",
    firstRunOrdinal: null,
    lastRunOrdinal: null,
    handoffIds: [],
    forkedFrom: null,
    pendingBackgroundTasks: [],
    nativeMetadata: { importedNativeThreadId: nativeThreadId },
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
    ...(thread.omittedMessageCount > 0
      ? [
          {
            id: EventId.make(`${IMPORT_EVENT_PREFIX}:history-truncated:${threadId}`),
            type: "turn-item.updated" as const,
            threadId,
            occurredAt: createdAt,
            payload: {
              id: TurnItemId.make(`${IMPORT_EVENT_PREFIX}:history-truncated:${threadId}`),
              threadId,
              runId: null,
              nodeId: null,
              providerThreadId: null,
              providerTurnId: null,
              nativeItemRef: null,
              parentItemId: null,
              ordinal: 0,
              status: "completed" as const,
              title: null,
              startedAt: createdAt,
              completedAt: createdAt,
              updatedAt: createdAt,
              type: "system_notice" as const,
              message: `${thread.omittedMessageCount} earlier ${thread.omittedMessageCount === 1 ? "message was" : "messages were"} not imported. This thread keeps the first user message and the most recent history. The original session transcript is unchanged.`,
            },
          },
        ]
      : []),
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
  const registry = yield* ProviderAdapterRegistry.ProviderAdapterRegistryV2;
  const threadCommands = yield* ThreadCommandExecutor.ThreadCommandExecutor;
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const ceiling = settingsService.managedPolicy?.limits?.maxRuntimeMode;

  // Imports run in full access, except under a policy ceiling: then in the project's default,
  // which the policy keeps under it, so imported threads never sit above the ceiling.
  const importRuntimeMode = (
    projectId: ProjectId,
    project: Parameters<typeof resolveProjectSettings>[2],
  ) =>
    ceiling === undefined
      ? Effect.succeed(DEFAULT_RUNTIME_MODE)
      : settingsService.getSettings.pipe(
          Effect.mapError(
            (cause) => new AgentSessionScanError({ operation: "read-settings", cause }),
          ),
          Effect.map((settings) => {
            const mode = resolveProjectSettings(settings, projectId, project).settings
              .defaultRuntimeMode;
            return isRuntimeModeAbove(mode, ceiling) ? ceiling : mode;
          }),
        );

  /** Write one parsed session as a thread, or adopt the thread a previous import created. */
  const importThread = Effect.fn("importAgentSessionThread")(function* (input: {
    readonly projectId: ProjectId;
    readonly workspaceRoot: string;
    readonly thread: AgentSessionScanner.AgentSessionThread;
    readonly source: AgentSessionImportSource;
    readonly runtimeMode: OrchestrationV2AppThread["runtimeMode"];
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
    const driver = ProviderDriverKind.make(thread.source);
    // Pi resumes by session file path; its session UUID only names the thread.
    const nativeThreadId = thread.source === "pi" ? source.filePath : thread.providerSessionId;
    const persistRuntime = runtimes.upsert(
      {
        threadId,
        providerName: driver,
        providerInstanceId: thread.providerInstanceId,
        adapterKey: driver,
        runtimeMode: input.runtimeMode,
        status: "stopped",
        lastSeenAt: thread.updatedAt,
        resumeCursor:
          thread.source === "claudeAgent"
            ? { threadId, resume: thread.providerSessionId }
            : { threadId: nativeThreadId },
        runtimePayload: { cwd: input.workspaceRoot },
      },
      { onConflict: "ignore" },
    );
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
      yield* persistRuntime;
      yield* runtimes.recordImportedTranscript({ threadId, source });
      return { threadId, imported: false } as const;
    }

    const providerThreadId = idAllocator.derive.providerThread({
      driver,
      providerInstanceId: thread.providerInstanceId,
      nativeThreadId,
    });
    const committed = yield* eventSink.write({
      // Earlier generations are deleted imports that still hold this native session.
      ...(generation === 0
        ? {
            unlessNativeThreadOwned: {
              driver,
              providerInstanceId: thread.providerInstanceId,
              appThreadId: threadId,
              nativeThreadRef: { driver, nativeId: nativeThreadId, strength: "strong" },
            },
          }
        : {}),
      events: importedThreadEvents({
        threadId,
        projectId: input.projectId,
        // Provider thread ids are global, so a deleted import keeps its own.
        providerThreadId:
          generation === 0
            ? providerThreadId
            : ProviderThreadId.make(`${providerThreadId}:${generation}`),
        thread,
        nativeThreadId,
        runtimeMode: input.runtimeMode,
      }),
    });
    if (committed.length === 0) return null;
    yield* persistRuntime;
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
      runtimeMode: yield* importRuntimeMode(input.projectId, project),
      generation,
    }).pipe(
      Effect.filterOrFail(
        (result) => result !== null,
        () => new AgentSessionNativeThreadOwnedError(),
      ),
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
    const runtimeMode = yield* importRuntimeMode(input.projectId, project);
    const runtimeRows = yield* runtimes
      .list()
      .pipe(
        Effect.mapError(
          (cause) => new AgentSessionScanError({ operation: "read-projects", cause }),
        ),
      );
    const completedSources = runtimeRows.flatMap((runtime) => {
      const payload = AgentSessionScanner.decodeImportedTranscriptPayload(runtime.runtimePayload);
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
          runtimeMode,
        }).pipe(
          Effect.map((result) => (result === null ? null : true)),
          Effect.catch((cause) =>
            Effect.logWarning("Could not import an agent session", {
              provider: outcome.thread.source,
              sessionId: outcome.thread.providerSessionId,
              cause,
            }).pipe(Effect.as(false)),
          ),
        );
        if (imported === true) {
          importedThreadIds.add(threadId);
          importedCount += 1;
        } else if (imported === false) {
          skippedCount += 1;
        }
      }),
    );

    return { importedCount, skippedCount } satisfies AgentSessionImportResult;
  });

  /**
   * Loading a native session replays its history only into the adapter's own
   * snapshot, so copy that snapshot into the thread as run-less history. The
   * `v1_import` origin keeps it in forks and marks the import done, so a call
   * after a failed read repairs the thread and any later call does nothing.
   */
  const importNativeHistory = Effect.fn("importNativeHistoryV2")(function* (input: {
    readonly threadId: ThreadId;
    readonly workspaceRoot: string;
  }) {
    const pendingThread = Effect.map(
      orchestrator.getThreadRecords(input.threadId, ["providerThreads", "runs"]),
      (records) =>
        isNativeHistoryPending({
          historyOrigin: records.thread.historyOrigin,
          hasRun: records.runs.length > 0,
        })
          ? records
          : null,
    );
    // Thread commands write whole thread rows, so hold their lock from the
    // re-read through the write to keep both this marker and their changes.
    const commit = (messages: ReadonlyArray<HistoryMessage>) =>
      threadCommands.withLock(
        input.threadId,
        Effect.gen(function* () {
          const current = yield* pendingThread;
          if (current === null) return 0;
          yield* eventSink.write({
            events: [
              ...messages.flatMap((message, index) =>
                messageEvents({ threadId: input.threadId, index, message }),
              ),
              {
                id: EventId.make(`${IMPORT_EVENT_PREFIX}:thread:${input.threadId}:native-history`),
                type: "thread.metadata-updated",
                threadId: input.threadId,
                providerInstanceId: current.thread.providerInstanceId,
                occurredAt: yield* DateTime.now,
                payload: { ...current.thread, historyOrigin: "v1_import" },
              },
            ],
          });
          return messages.length;
        }),
      );
    const records = yield* pendingThread;
    if (records === null) return 0;
    const { thread, providerThreads } = records;
    const providerThread = providerThreads.find(
      (candidate) => candidate.appThreadId === input.threadId && candidate.nativeThreadRef !== null,
    );
    const nativeThreadId = providerThread?.nativeThreadRef?.nativeId;
    if (providerThread === undefined || nativeThreadId == null) return 0;
    const providerSessionId = yield* idAllocator.allocate.providerSession({
      providerInstanceId: providerThread.providerInstanceId,
      threadId: input.threadId,
    });
    // The registry admits this open against sign-in changes, like any other open.
    const adapter = yield* registry.get(thread.modelSelection.instanceId);
    const snapshot = yield* adapter
      .openSession({
        threadId: input.threadId,
        providerSessionId,
        modelSelection: thread.modelSelection,
        runtimePolicy: {
          runtimeMode: thread.runtimeMode,
          interactionMode: thread.interactionMode,
          cwd: thread.worktreePath ?? input.workspaceRoot,
        },
        initialNativeThreadId: nativeThreadId,
        ...(providerThread.nativeMetadata?.itemIdentityVersion === undefined
          ? {}
          : {
              initialProviderItemIdentityVersion: providerThread.nativeMetadata.itemIdentityVersion,
            }),
      })
      .pipe(
        Effect.flatMap((session) => session.readThreadSnapshot({ providerThread })),
        Effect.timeout(NATIVE_HISTORY_READ_TIMEOUT),
        Effect.scoped,
      );
    const reasoningIds = new Set(snapshot.reasoningMessageIds);
    const messages = snapshot.messages.flatMap((message) =>
      (message.role === "user" || message.role === "assistant") && message.text.trim() !== ""
        ? [
            {
              role: reasoningIds.has(message.id) ? ("reasoning" as const) : message.role,
              text: message.text,
              createdAt: DateTime.formatIso(message.createdAt),
            },
          ]
        : [],
    );
    // Loading the session can take a while, and the thread is usable meanwhile.
    return yield* commit(messages);
  });

  return { importRecentAgentThreads, listSessions, importSession, importNativeHistory };
});

type AgentSessionImporterShape = Effect.Success<typeof make>;

export class AgentSessionImporter extends Context.Service<
  AgentSessionImporter,
  AgentSessionImporterShape
>()("t3/project/AgentSessionImporter") {}

export const layer = Layer.effect(AgentSessionImporter, make);
