import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ProviderCapabilities,
  type OrchestrationV2ProviderSession,
  type OrchestrationV2ProviderThread,
  ProjectId,
  ProviderDriverKind,
  ProviderThreadId,
  ProviderTurnId,
  TextGenerationError,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import type { ConversationSummaryGenerationInput } from "@t3tools/provider-core/server/textGeneration";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as TextGeneration from "../../textGeneration/TextGeneration.ts";
import { ClaudeProviderCapabilitiesV2 } from "../Adapters/ClaudeAdapterV2.ts";
import { CommandPolicyCapabilityUnsupportedError } from "../CommandPolicy.ts";
import * as EffectWorker from "../EffectWorker.ts";
import * as Orchestrator from "../Orchestrator.ts";
import * as ProviderAdapterRegistry from "../ProviderAdapterRegistry.ts";
import { CLAUDE_MODEL_SELECTION } from "./fixtures/shared.ts";
import * as ProviderReplayHarness from "./ProviderReplayHarness.ts";

const isCapabilityUnsupported = Schema.is(CommandPolicyCapabilityUnsupportedError);
const threadId = ThreadId.make("thread:conversation-summary");
const projectId = ProjectId.make("project:conversation-summary");
const DRIVER = ProviderDriverKind.make("claudeAgent");
const SUMMARY = "Summary: the release marker is violet.";
const PROMPTS = {
  1: "The release marker is violet.",
  2: "Rename the release script.",
  3: "Now update the changelog.",
  4: "What is the release marker?",
  5: "Anything left to do?",
} as const;

interface CapturedTurn {
  readonly providerThreadId: ProviderThreadId;
  readonly nativeThreadId: string | null;
  readonly text: string;
}

function makeAdapter(input: {
  readonly capabilities: OrchestrationV2ProviderCapabilities;
  readonly turns: Ref.Ref<ReadonlyArray<CapturedTurn>>;
  readonly rollbacks: Ref.Ref<number>;
}): ProviderAdapter.ProviderAdapterV2["Service"] {
  const unimplemented = (detail: string) =>
    Effect.fail(new ProviderAdapter.ProviderAdapterProtocolError({ driver: DRIVER, detail }));
  return {
    instanceId: CLAUDE_MODEL_SELECTION.instanceId,
    driver: DRIVER,
    getCapabilities: () => Effect.succeed(input.capabilities),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
    openSession: (sessionInput) =>
      Effect.gen(function* () {
        const events = yield* PubSub.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
        const nativeThreads = yield* Ref.make(0);
        const now = yield* DateTime.now;
        const providerSession: OrchestrationV2ProviderSession = {
          id: sessionInput.providerSessionId,
          driver: DRIVER,
          providerInstanceId: CLAUDE_MODEL_SELECTION.instanceId,
          status: "ready",
          cwd: sessionInput.runtimePolicy.cwd ?? process.cwd(),
          model: CLAUDE_MODEL_SELECTION.model,
          capabilities: input.capabilities,
          createdAt: now,
          updatedAt: now,
          lastError: null,
        };
        const runtime: ProviderAdapter.ProviderAdapterV2SessionRuntime = {
          instanceId: CLAUDE_MODEL_SELECTION.instanceId,
          driver: DRIVER,
          providerSessionId: sessionInput.providerSessionId,
          providerSession,
          events: Stream.fromPubSub(events),
          ensureThread: (threadInput) =>
            Effect.gen(function* () {
              const createdAt = yield* DateTime.now;
              const generation = yield* Ref.getAndUpdate(nativeThreads, (value) => value + 1);
              const nativeThreadId = `${sessionInput.providerSessionId}:${generation}`;
              return {
                id: ProviderThreadId.make(`provider-thread:${nativeThreadId}`),
                driver: DRIVER,
                providerInstanceId: CLAUDE_MODEL_SELECTION.instanceId,
                providerSessionId: sessionInput.providerSessionId,
                appThreadId: threadInput.threadId,
                ownerNodeId: null,
                nativeThreadRef: { driver: DRIVER, nativeId: nativeThreadId, strength: "strong" },
                nativeConversationHeadRef: null,
                status: "idle",
                firstRunOrdinal: null,
                lastRunOrdinal: null,
                handoffIds: [],
                forkedFrom: null,
                createdAt,
                updatedAt: createdAt,
              } satisfies OrchestrationV2ProviderThread;
            }),
          resumeThread: ({ providerThread }) => Effect.succeed(providerThread),
          startTurn: (turnInput) =>
            Effect.gen(function* () {
              yield* Ref.update(input.turns, (turns) => [
                ...turns,
                {
                  providerThreadId: turnInput.providerThread.id,
                  nativeThreadId: turnInput.providerThread.nativeThreadRef?.nativeId ?? null,
                  text: turnInput.message.text,
                },
              ]);
              const eventTime = yield* DateTime.now;
              const providerTurnId = ProviderTurnId.make(
                `provider-turn:${turnInput.threadId}:${turnInput.runOrdinal}`,
              );
              const providerEvents: ReadonlyArray<ProviderAdapter.ProviderAdapterV2Event> = [
                {
                  type: "provider_turn.updated",
                  driver: DRIVER,
                  providerTurn: {
                    id: providerTurnId,
                    providerThreadId: turnInput.providerThread.id,
                    nodeId: turnInput.rootNodeId,
                    runAttemptId: turnInput.attemptId,
                    nativeTurnRef: {
                      driver: DRIVER,
                      nativeId: `native-turn:${turnInput.threadId}:${turnInput.runOrdinal}`,
                      strength: "strong",
                    },
                    ordinal: turnInput.runOrdinal,
                    status: "completed",
                    startedAt: eventTime,
                    completedAt: eventTime,
                  },
                },
                {
                  type: "turn_item.updated",
                  driver: DRIVER,
                  turnItem: {
                    id: TurnItemId.make(
                      `turn-item:${turnInput.threadId}:${turnInput.runOrdinal}:assistant`,
                    ),
                    threadId: turnInput.threadId,
                    runId: turnInput.runId,
                    nodeId: turnInput.rootNodeId,
                    providerThreadId: turnInput.providerThread.id,
                    providerTurnId,
                    nativeItemRef: null,
                    parentItemId: null,
                    ordinal: turnInput.runOrdinal * 100 + 1,
                    status: "completed",
                    title: null,
                    startedAt: eventTime,
                    completedAt: eventTime,
                    updatedAt: eventTime,
                    type: "assistant_message",
                    messageId: MessageId.make(
                      `message:${turnInput.threadId}:${turnInput.runOrdinal}:assistant`,
                    ),
                    text: `Answer ${turnInput.runOrdinal}`,
                    streaming: false,
                  },
                },
                {
                  type: "turn.terminal",
                  driver: DRIVER,
                  providerThreadId: turnInput.providerThread.id,
                  providerTurnId,
                  runOrdinal: turnInput.runOrdinal,
                  status: "completed",
                  failure: null,
                  threadDisposition: "reusable",
                },
              ];
              for (const event of providerEvents) yield* PubSub.publish(events, event);
            }),
          steerTurn: () => Effect.void,
          interruptTurn: () => Effect.void,
          respondToRuntimeRequest: () => Effect.void,
          readThreadSnapshot: () => unimplemented("readThreadSnapshot is unused"),
          rollbackThread: ({ providerThread }) =>
            Ref.update(input.rollbacks, (count) => count + 1).pipe(
              Effect.as({ providerThread, providerTurns: [], messages: [], runtimeRequests: [] }),
            ),
          forkThread: () => unimplemented("forkThread is unused"),
        };
        return runtime;
      }),
  };
}

function makeTextGeneration(
  requests: Ref.Ref<ReadonlyArray<ConversationSummaryGenerationInput>>,
  fail = false,
): TextGeneration.TextGeneration["Service"] {
  const unused = (operation: string) => () =>
    Effect.die(new Error(`${operation} is unused in conversation summary tests`));
  return TextGeneration.TextGeneration.of({
    generateCommitMessage: unused("generateCommitMessage"),
    generatePrContent: unused("generatePrContent"),
    generateBranchName: unused("generateBranchName"),
    generateThreadTitle: unused("generateThreadTitle"),
    generateReviewGuide: unused("generateReviewGuide"),
    generateConversationSummary: (input) =>
      Ref.update(requests, (existing) => [...existing, input]).pipe(
        Effect.andThen(
          fail
            ? Effect.fail(
                new TextGenerationError({
                  operation: "generateConversationSummary",
                  detail: "The model is unavailable.",
                }),
              )
            : Effect.succeed({ summary: SUMMARY }),
        ),
      ),
  });
}

interface Harness {
  readonly turns: Ref.Ref<ReadonlyArray<CapturedTurn>>;
  readonly rollbacks: Ref.Ref<number>;
  readonly summaryRequests: Ref.Ref<ReadonlyArray<ConversationSummaryGenerationInput>>;
}

const runWithHarness = <A, E>(
  name: string,
  options: {
    readonly capabilities?: OrchestrationV2ProviderCapabilities;
    readonly failGeneration?: boolean;
  },
  body: (
    harness: Harness,
  ) => Effect.Effect<A, E, Orchestrator.OrchestratorV2 | EffectWorker.OrchestrationEffectWorkerV2>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const cwd = yield* checkpointWorkspace(name);
      const harness: Harness = {
        turns: yield* Ref.make<ReadonlyArray<CapturedTurn>>([]),
        rollbacks: yield* Ref.make(0),
        summaryRequests: yield* Ref.make<ReadonlyArray<ConversationSummaryGenerationInput>>([]),
      };
      const layerRegistry = ProviderAdapterRegistry.layerFromAdapters([
        makeAdapter({
          capabilities: options.capabilities ?? ClaudeProviderCapabilitiesV2,
          turns: harness.turns,
          rollbacks: harness.rollbacks,
        }),
      ]);
      return yield* body(harness).pipe(
        Effect.provide(
          ProviderReplayHarness.layerWithRegistry(
            {
              name,
              runtimePolicyOverride: {
                cwd,
                approvalPolicy: "never",
                sandboxPolicy: { type: "readOnly" },
              },
            },
            layerRegistry,
            {
              textGeneration: makeTextGeneration(
                harness.summaryRequests,
                options.failGeneration === true,
              ),
            },
          ),
        ),
      );
    }),
  );

const awaitStoredEvent = (predicate: (event: OrchestrationV2DomainEvent) => boolean) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
    yield* orchestrator.streamStoredEvents.pipe(
      Stream.filter(({ event }) => event.threadId === threadId && predicate(event)),
      Stream.runHead,
    );
    yield* worker.drain();
  });

const createThread = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  yield* orchestrator.dispatch({
    type: "thread.create",
    commandId: CommandId.make("summary:create"),
    threadId,
    projectId,
    createdBy: "user",
    creationSource: "web",
    title: "Conversation summary",
    modelSelection: CLAUDE_MODEL_SELECTION,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
  });
});

const messageId = (ordinal: keyof typeof PROMPTS) => MessageId.make(`summary:message:${ordinal}`);

const send = (ordinal: keyof typeof PROMPTS) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make(`summary:send:${ordinal}`),
      threadId,
      messageId: messageId(ordinal),
      createdBy: "user",
      creationSource: "web",
      text: PROMPTS[ordinal],
      attachments: [],
      modelSelection: CLAUDE_MODEL_SELECTION,
      dispatchMode: { type: "start_immediately" },
    });
    yield* awaitStoredEvent(
      (event) =>
        event.type === "run.updated" &&
        event.payload.ordinal === ordinal &&
        event.payload.status === "completed",
    );
  });

const summarize = (
  ordinal: keyof typeof PROMPTS,
  direction: "from_here" | "up_to_here",
  instructions?: string,
) =>
  Orchestrator.OrchestratorV2.use((orchestrator) =>
    orchestrator.dispatch({
      type: "thread.summarize",
      commandId: CommandId.make(`summary:summarize:${ordinal}:${direction}`),
      threadId,
      messageId: messageId(ordinal),
      direction,
      ...(instructions === undefined ? {} : { instructions }),
    }),
  );

const awaitMarker = awaitStoredEvent(
  (event) => event.type === "turn-item.updated" && event.payload.type === "compaction",
);

const projection = Orchestrator.OrchestratorV2.use((orchestrator) =>
  orchestrator.getThreadProjection(threadId),
);

const marker = Effect.map(projection, (current) =>
  current.turnItems.find(
    (item): item is Extract<typeof item, { readonly type: "compaction" }> =>
      item.type === "compaction",
  ),
);

describe("orchestration v2 conversation summary", () => {
  it.live("summarizes from a message: rewinds the provider, keeps files and checkpoints", () =>
    runWithHarness("summary-from-here", {}, (harness) =>
      Effect.gen(function* () {
        yield* createThread;
        yield* send(1);
        yield* send(2);
        yield* send(3);
        yield* summarize(2, "from_here", "Keep the script name.");
        yield* awaitMarker;
        yield* awaitStoredEvent(
          (event) =>
            event.type === "run.updated" &&
            event.payload.ordinal === 3 &&
            event.payload.status === "rolled_back",
        );

        const [request] = yield* Ref.get(harness.summaryRequests);
        assert.equal(request?.direction, "from_here");
        assert.equal(request?.instructions, "Keep the script name.");
        assert.include(request?.transcript ?? "", PROMPTS[2]);
        assert.include(request?.transcript ?? "", PROMPTS[3]);
        assert.notInclude(request?.transcript ?? "", PROMPTS[1]);

        const current = yield* projection;
        assert.deepEqual(
          current.runs.map((run) => [run.ordinal, run.status]),
          [
            [1, "completed"],
            [2, "rolled_back"],
            [3, "rolled_back"],
          ],
        );
        assert.equal(yield* Ref.get(harness.rollbacks), 1);
        assert.isNull(current.thread.summarize ?? null);
        // Files were kept, so the checkpoints that describe them stay usable.
        assert.isTrue(
          current.checkpoints
            .filter((checkpoint) => (checkpoint.appRunOrdinal ?? 0) >= 2)
            .every((checkpoint) => checkpoint.status === "ready"),
        );
        const summaryItem = yield* marker;
        assert.equal(summaryItem?.summary, SUMMARY);
        assert.equal(summaryItem?.range?.direction, "from_here");
        assert.deepEqual(
          summaryItem?.range?.coveredRunIds,
          current.runs.filter((run) => run.ordinal >= 2).map((run) => run.id),
        );
        assert.equal(summaryItem?.runId, current.runs[0]?.id);
        // Summarized turns stay readable for the collapsed view under the marker.
        const history = yield* Orchestrator.OrchestratorV2.use((orchestrator) =>
          orchestrator.getRunHistory({ threadId, runIds: summaryItem?.range?.coveredRunIds ?? [] }),
        );
        assert.isTrue(
          history.some((item) => item.type === "user_message" && item.text === PROMPTS[2]),
        );

        yield* send(4);
        const turns = yield* Ref.get(harness.turns);
        assert.include(turns.at(-1)?.text ?? "", SUMMARY);
        assert.include(turns.at(-1)?.text ?? "", PROMPTS[4]);
        assert.equal(turns.at(-1)?.nativeThreadId, turns[0]?.nativeThreadId);
      }),
    ),
  );

  it.live("summarizes up to a message on a fresh provider thread, then restores", () =>
    runWithHarness("summary-up-to-here", {}, (harness) =>
      Effect.gen(function* () {
        yield* createThread;
        yield* send(1);
        yield* send(2);
        yield* send(3);
        const before = yield* projection;
        yield* summarize(3, "up_to_here");
        yield* awaitMarker;

        const [request] = yield* Ref.get(harness.summaryRequests);
        assert.equal(request?.direction, "up_to_here");
        assert.include(request?.transcript ?? "", PROMPTS[1]);
        assert.notInclude(request?.transcript ?? "", PROMPTS[3]);

        const summarized = yield* projection;
        assert.isTrue(summarized.runs.every((run) => run.status === "completed"));
        assert.equal(yield* Ref.get(harness.rollbacks), 0);
        assert.notEqual(
          summarized.thread.activeProviderThreadId,
          before.thread.activeProviderThreadId,
        );
        const summaryItem = yield* marker;
        assert.equal(summaryItem?.range?.direction, "up_to_here");
        assert.equal(
          summaryItem?.range?.previousProviderThreadId,
          before.thread.activeProviderThreadId,
        );
        assert.equal(
          summaryItem?.range?.summaryProviderThreadId,
          summarized.thread.activeProviderThreadId,
        );

        yield* send(4);
        const afterSummary = (yield* Ref.get(harness.turns)).at(-1);
        assert.notEqual(
          afterSummary?.nativeThreadId,
          (yield* Ref.get(harness.turns))[0]?.nativeThreadId,
        );
        assert.include(afterSummary?.text ?? "", SUMMARY);
        // The selected message and everything after it are carried verbatim.
        assert.include(afterSummary?.text ?? "", PROMPTS[3]);
        assert.notInclude(afterSummary?.text ?? "", PROMPTS[1]);

        yield* Orchestrator.OrchestratorV2.use((orchestrator) =>
          orchestrator.dispatch({
            type: "thread.summary.restore",
            commandId: CommandId.make("summary:restore"),
            threadId,
            turnItemId: summaryItem!.id,
          }),
        );
        const restored = yield* projection;
        assert.equal(restored.thread.activeProviderThreadId, before.thread.activeProviderThreadId);
        assert.isDefined((yield* marker)?.range?.restoredAt);

        yield* send(5);
        const afterRestore = (yield* Ref.get(harness.turns)).at(-1);
        assert.equal(
          afterRestore?.nativeThreadId,
          (yield* Ref.get(harness.turns))[0]?.nativeThreadId,
        );
        // The turn taken on the summary thread is handed back to the full one.
        assert.include(afterRestore?.text ?? "", PROMPTS[4]);
        assert.notInclude(afterRestore?.text ?? "", SUMMARY);
      }),
    ),
  );

  it.live("rejects summarizing from a message when the provider cannot rewind", () =>
    runWithHarness(
      "summary-unsupported",
      {
        capabilities: {
          ...ClaudeProviderCapabilitiesV2,
          threads: { ...ClaudeProviderCapabilitiesV2.threads, canRollbackThread: false },
        },
      },
      (harness) =>
        Effect.gen(function* () {
          yield* createThread;
          yield* send(1);
          yield* send(2);
          const rejected = yield* Effect.flip(summarize(2, "from_here"));
          const policyFailure = "cause" in rejected ? rejected.cause : undefined;
          assert.isTrue(isCapabilityUnsupported(policyFailure));
          assert.equal(
            isCapabilityUnsupported(policyFailure) && policyFailure.capability,
            "rollback",
          );
          const nothingBefore = yield* Effect.flip(summarize(1, "up_to_here"));
          assert.equal(
            "cause" in nothingBefore ? nothingBefore.cause : undefined,
            "There is nothing before this message to summarize.",
          );
          assert.lengthOf(yield* Ref.get(harness.summaryRequests), 0);
          assert.isNull((yield* projection).thread.summarize ?? null);
        }),
    ),
  );

  it.live("records a failed summary and leaves the conversation untouched", () =>
    runWithHarness("summary-failure", { failGeneration: true }, (harness) =>
      Effect.gen(function* () {
        yield* createThread;
        yield* send(1);
        yield* send(2);
        yield* summarize(2, "from_here");
        yield* awaitStoredEvent(
          (event) =>
            event.type === "thread.metadata-updated" &&
            event.payload.summarize?.failure !== undefined,
        );
        const current = yield* projection;
        assert.equal(current.thread.summarize?.failure, "The model is unavailable.");
        assert.isTrue(current.runs.every((run) => run.status === "completed"));
        assert.equal(yield* Ref.get(harness.rollbacks), 0);
        assert.isUndefined(yield* marker);
        assert.isAbove((yield* Ref.get(harness.summaryRequests)).length, 0);
      }),
    ),
  );
});
