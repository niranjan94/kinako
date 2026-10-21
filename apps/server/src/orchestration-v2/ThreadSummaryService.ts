import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import {
  CommandId,
  type ServerSettingsError,
  TextGenerationError,
  type ThreadId,
  type RunId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import {
  conversationSummaryCoveredRuns,
  renderConversationSummaryTranscript,
} from "./ConversationSummary.ts";
import type { OrchestratorV2Error } from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as RuntimePolicy from "./RuntimePolicy.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";

import { renderTurnRecapTranscript } from "./TurnRecap.ts";

const SUMMARY_FAILED_MESSAGE = "The summary could not be generated.";

export class ThreadSummaryGenerationError extends Schema.TaggedError<ThreadSummaryGenerationError>()(
  "ThreadSummaryGenerationError",
  { detail: Schema.String },
) {
  override get message(): string {
    return this.detail;
  }
}

const isThreadSummaryGenerationError = Schema.is(ThreadSummaryGenerationError);
const isTextGenerationError = Schema.is(TextGenerationError);

export class ThreadSummaryService extends Context.Service<
  ThreadSummaryService,
  {
    readonly executeRecap: (input: {
      readonly threadId: ThreadId;
      readonly runId: RunId;
    }) => Effect.Effect<void>;
    /**
     * Generates the summary for summarize request `requestId` and hands it to
     * the orchestrator. The last failed attempt records the failure instead.
     */
    readonly execute: (input: {
      readonly threadId: ThreadId;
      readonly requestId: CommandId;
      readonly willRetry: boolean;
    }) => Effect.Effect<
      void,
      | OrchestratorV2Error
      | ProjectStore.ProjectStoreV2Error
      | ProjectionStore.ProjectionStoreV2Error
      | RuntimePolicy.RuntimePolicyV2Error
      | ServerSettingsError
      | TextGenerationError
      | ThreadSummaryGenerationError
      | ThreadManagementService.ThreadManagementProviderInstanceDisabledError
    >;
  }
>()("t3/orchestration-v2/ThreadSummaryService") {}

const make = Effect.gen(function* () {
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const runtimePolicy = yield* RuntimePolicy.RuntimePolicyV2;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const textGeneration = yield* TextGeneration.TextGeneration;

  const generate = Effect.fn("ThreadSummaryService.generate")(function* (input: {
    readonly threadId: ThreadId;
    readonly requestId: CommandId;
  }) {
    const projection = yield* threads.getThreadRecords(input.threadId, ["runs"]);
    const request = projection.thread.summarize;
    if (
      request === null ||
      request === undefined ||
      request.requestId !== input.requestId ||
      request.failure !== undefined
    ) {
      return Option.none<string>();
    }
    const messageRun = projection.runs.find((run) => run.userMessageId === request.messageId);
    // Generate where the thread's provider runs.
    const cwd =
      (yield* runtimePolicy.resolve({
        thread: projection.thread,
        modelSelection: projection.thread.modelSelection,
      })).cwd ??
      Option.getOrUndefined(yield* projects.get(projection.thread.projectId))?.workspaceRoot;
    if (messageRun === undefined || cwd === undefined) {
      return yield* new ThreadSummaryGenerationError({ detail: SUMMARY_FAILED_MESSAGE });
    }
    const coveredRuns = conversationSummaryCoveredRuns(
      projection.runs,
      messageRun,
      request.direction,
    );
    const items = yield* projections.getTurnStartHistory(
      input.threadId,
      coveredRuns.map((run) => run.id),
    );
    const transcript = renderConversationSummaryTranscript(items);
    if (transcript.length === 0) {
      return yield* new ThreadSummaryGenerationError({
        detail: "There is no conversation to summarize.",
      });
    }
    const settings = resolveProjectSettings(
      yield* serverSettings.getSettings,
      projection.thread.projectId,
    ).settings;
    const summarize = (modelSelection: typeof projection.thread.modelSelection) =>
      textGeneration.generateConversationSummary({
        cwd,
        transcript,
        direction: request.direction,
        ...(request.instructions === undefined ? {} : { instructions: request.instructions }),
        modelSelection,
      });
    // The thread's own model knows the work best. Some providers cannot run
    // one-off generations, so fall back to the configured text generation model.
    const fallback = settings.textGenerationModelSelection;
    const result = yield* summarize(projection.thread.modelSelection).pipe(
      Effect.catchTags({
        TextGenerationError: (error) =>
          fallback.instanceId === projection.thread.modelSelection.instanceId &&
          fallback.model === projection.thread.modelSelection.model
            ? Effect.fail(error)
            : summarize(fallback),
      }),
    );
    return Option.some(result.summary);
  });

  const execute: ThreadSummaryService["Service"]["execute"] = Effect.fn(
    "ThreadSummaryService.execute",
  )(function* (input) {
    // Applying the summary is guarded too: a request left in flight blocks the
    // thread's next summary and, on web, its composer.
    yield* generate(input).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.void,
          onSome: (summary) =>
            threads
              .dispatch({
                type: "thread.summarize.complete",
                commandId: CommandId.make(`${input.requestId}:summary-complete`),
                threadId: input.threadId,
                requestId: input.requestId,
                summary,
              })
              .pipe(Effect.asVoid),
        }),
      ),
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause) || input.willRetry) return Effect.failCause(cause);
        const reason = Cause.squash(cause);
        const message =
          isThreadSummaryGenerationError(reason) || isTextGenerationError(reason)
            ? reason.detail
            : SUMMARY_FAILED_MESSAGE;
        return Effect.logWarning("Thread summary generation failed", {
          threadId: input.threadId,
          requestId: input.requestId,
          cause,
        }).pipe(
          Effect.andThen(
            threads.dispatch({
              type: "thread.summarize.fail",
              commandId: CommandId.make(`${input.requestId}:summary-failed`),
              threadId: input.threadId,
              requestId: input.requestId,
              message,
            }),
          ),
          Effect.asVoid,
        );
      }),
    );
  });

  const executeRecap = Effect.fn("ThreadSummaryService.executeRecap")(
    function* (input: { readonly threadId: ThreadId; readonly runId: RunId }) {
      const projection = yield* projections.getThreadRecords(
        input.threadId,
        ["runs", "turnItems"],
        { runIds: [input.runId], turnItemRunIds: [input.runId] },
      );
      const run = projection.runs[0];
      if (
        projection.thread.deletedAt !== null ||
        run === undefined ||
        run.recap !== undefined ||
        (run.status !== "completed" && run.status !== "failed")
      )
        return;
      const transcript = renderTurnRecapTranscript(projection.turnItems);
      if (transcript.length === 0) return;
      const settings = resolveProjectSettings(
        yield* serverSettings.getSettings,
        projection.thread.projectId,
      ).settings;
      const cwd =
        (yield* runtimePolicy.resolve({
          thread: projection.thread,
          modelSelection: settings.textGenerationModelSelection,
        })).cwd ??
        Option.getOrUndefined(yield* projects.get(projection.thread.projectId))?.workspaceRoot;
      if (cwd === undefined) return;
      const shell = yield* projections.getThreadShell(input.threadId);
      const finalMessage = projection.turnItems.findLast(
        (item) => item.type === "assistant_message",
      );
      const recap = yield* textGeneration.generateTurnRecap({
        cwd,
        transcript,
        finalAnswer:
          finalMessage?.type === "assistant_message" ? finalMessage.text.slice(0, 8_000) : "",
        backgroundWork: (shell?.latestRunId === run.id ? (shell.pendingBackgroundTasks ?? []) : [])
          .map((task) => `${task.kind}: ${task.description ?? task.taskId}`)
          .join("\n"),
        modelSelection: settings.textGenerationModelSelection,
      });
      yield* threads.dispatch({
        type: "run.recap.complete",
        commandId: CommandId.make(`command:run-recap.complete:${input.runId}`),
        threadId: input.threadId,
        runId: input.runId,
        recap,
      });
    },
    // A catch-up aid must not turn a successful run into a failure or consume repeated generations.
    Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.interrupt
        : Effect.logWarning("Turn recap generation failed", { cause }),
    ),
  );

  return ThreadSummaryService.of({ execute, executeRecap });
});

export const layer = Layer.effect(ThreadSummaryService, make);
