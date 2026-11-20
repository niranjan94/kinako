// @effect-diagnostics nodeBuiltinImport:off - the home directory has no Effect service.
import {
  CommandId,
  hostAutoBaseRuntimeMode,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2RuntimeRequest,
  type OrchestrationV2TurnItem,
  resolveThreadAdditionalDirectoryPath,
  type RuntimeRequestId,
  type ThreadId,
} from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { resolveAutoReviewModelSelection } from "@t3tools/shared/serverSettings";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FiberMap from "effect/FiberMap";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as NodeOS from "node:os";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import { forkParked } from "../serverActivation.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ApprovalClassifier from "./ApprovalClassifier.ts";
import { evaluateRules } from "./autoApprovalRules.ts";
import { buildReviewBundle } from "./reviewBundle.ts";

type ApprovalItem = Extract<OrchestrationV2TurnItem, { type: "approval_request" }>;
type Verdict = { readonly outcome: "approved" | "escalated"; readonly reason: string };

// Claude and ACP adapters emit the request before its card; a request whose card never comes is
// still reviewed, just without the card's options.
const CARD_GRACE = "3 seconds";
const RECENT_RUNS = 8;

/** Answers approvals on `host-auto` threads from rules and a reviewer model, or hands them over. */
export class AutoApprovalReactor extends Context.Service<
  AutoApprovalReactor,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    /** Reviews one held request now; exposed so tests need no event stream. */
    readonly review: (threadId: ThreadId, requestId: RuntimeRequestId) => Effect.Effect<void>;
  }
>()("t3/autoReview/AutoApprovalReactor") {}

const make = Effect.gen(function* () {
  const engine = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const providers = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const classifier = yield* ApprovalClassifier.ApprovalClassifier;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const homeDir = NodeOS.homedir();

  /** The real path, resolving symlinks in its nearest existing ancestor; undefined fails closed. */
  const canonical = Effect.fnUntraced(function* (target: string, cwd: string) {
    let candidate = path.resolve(
      cwd,
      target.startsWith("~") ? path.join(homeDir, target.slice(1)) : target,
    );
    const missing: Array<string> = [];
    while (true) {
      const real = yield* fileSystem.realPath(candidate).pipe(Effect.option);
      if (Option.isSome(real)) return path.resolve(real.value, ...missing);
      const exists = yield* fileSystem.exists(candidate).pipe(Effect.orElseSucceed(() => true));
      // Present but unreadable: a dangling link or a permissions problem.
      if (exists) return undefined;
      const parent = path.dirname(candidate);
      if (parent === candidate) return undefined;
      missing.unshift(path.basename(candidate));
      candidate = parent;
    }
  });

  const decide = Effect.fn("AutoApprovalReactor.decide")(function* (
    threadId: ThreadId,
    request: OrchestrationV2RuntimeRequest,
  ) {
    const thread = yield* projections.getThread(threadId);
    const settings = resolveProjectSettings(
      yield* settingsService.getSettings,
      thread.projectId,
    ).settings;
    const cwd =
      thread.worktreePath ??
      Option.getOrUndefined(yield* projects.get(thread.projectId))?.workspaceRoot;
    if (cwd === undefined) {
      return {
        outcome: "escalated",
        reason: "The thread's workspace could not be found.",
      } as const;
    }
    const additionalDirectories = (thread.additionalDirectories ?? []).map(
      resolveThreadAdditionalDirectoryPath,
    );
    const instance = yield* providers.getInstance(thread.modelSelection.instanceId);
    const snapshot = instance === undefined ? undefined : yield* instance.snapshot.getSnapshot;
    const driver = snapshot?.driver ?? thread.modelSelection.instanceId;
    const baseMode = hostAutoBaseRuntimeMode(driver, snapshot?.supportedRuntimeModes);
    const { turnItems: cards } = yield* projections.getThreadRecords(threadId, ["turnItems"], {
      turnItemRequestIds: [request.id],
    });
    const card = cards.find((item): item is ApprovalItem => item.type === "approval_request");

    const roots = (yield* Effect.forEach([cwd, ...additionalDirectories], (root) =>
      canonical(root, cwd),
    )).filter((root) => root !== undefined);
    const requested = request.inspection?.paths ?? [];
    const paths = yield* Effect.forEach(requested, (target) => canonical(target, cwd));
    const rules = evaluateRules({
      request,
      command:
        request.inspection?.command ?? (request.kind === "command" ? card?.prompt : undefined),
      paths,
      options: card?.options,
      fullAccessOverride: card?.fullAccessOverride,
      roots,
      homeDir,
      baseMode,
    });
    if (rules.type === "allow") return { outcome: "approved", reason: rules.reason } as const;
    if (rules.type === "escalate") return { outcome: "escalated", reason: rules.reason } as const;
    if (settings.autoReviewRulesOnly) {
      return {
        outcome: "escalated",
        reason: "No rule covers this, and review is set to rules only.",
      } as const;
    }

    const { runs } = yield* projections.getThreadRecords(threadId, ["runs"], {
      latestRunLimit: RECENT_RUNS,
    });
    const runIds = runs.map((run) => run.id);
    const records = yield* projections.getThreadRecords(
      threadId,
      ["messages", "runtimeRequests", "plans"],
      { messageRunIds: runIds },
    );
    const node = yield* projections.getThreadRecords(threadId, ["nodes"], {
      nodeIds: [request.nodeId],
    });
    const runId = node.nodes[0]?.runId ?? null;
    const { turnItems } =
      runId === null
        ? { turnItems: [] }
        : yield* projections.getThreadRecords(threadId, ["turnItems"], { turnItemRunId: runId });
    const parentThreadId = thread.lineage.parentThreadId;
    const delegatedTask =
      parentThreadId === null
        ? undefined
        : (yield* projections.getThreadRecords(parentThreadId, ["subagents"], {
            subagentChildThreadIds: [threadId],
          })).subagents[0]?.prompt;
    const bundle = buildReviewBundle({
      thread,
      records: { ...records, turnItems },
      request,
      approvalItem: card,
      delegatedTask,
      cwd,
      additionalDirectories,
      paths: requested.flatMap((target, index) => {
        const resolved = paths[index];
        return resolved === undefined
          ? []
          : [
              {
                path: target,
                insideWorkspace: roots.some(
                  (root) => !path.relative(root, resolved).startsWith(".."),
                ),
              },
            ];
      }),
      provider: driver,
      baseMode,
    });
    const verdict = yield* classifier.classify({
      bundle,
      selection: resolveAutoReviewModelSelection(
        settings,
        snapshot === undefined ? undefined : [snapshot],
      ),
      settings,
      cwd,
    });
    return {
      outcome: verdict.decision === "allow" ? "approved" : "escalated",
      reason: verdict.reason,
    } as const;
  });

  const review: AutoApprovalReactor["Service"]["review"] = Effect.fn("AutoApprovalReactor.review")(
    function* (threadId, requestId) {
      const request = yield* projections.getRuntimeRequest(threadId, requestId);
      if (request?.status !== "pending" || request.autoReview?.state !== "reviewing") return;
      // Any failure hands the request to the user rather than leaving it held.
      const verdict: Verdict = yield* decide(threadId, request).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("host review failed", { threadId, requestId, cause }).pipe(
            Effect.as({ outcome: "escalated", reason: "The review could not finish." } as const),
          ),
        ),
      );
      yield* engine.dispatch({
        type: "runtime-request.auto-review",
        commandId: CommandId.make(`server:auto-review:${threadId}:${requestId}`),
        threadId,
        requestId,
        outcome: verdict.outcome,
        reason: verdict.reason,
      });
    },
    (effect, threadId, requestId) =>
      effect.pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("recording a host review verdict failed", {
            threadId,
            requestId,
            cause,
          }),
        ),
      ),
  );

  const start: AutoApprovalReactor["Service"]["start"] = Effect.fn("AutoApprovalReactor.start")(
    function* () {
      // One review per request: a newer trigger replaces only a review still waiting for its card.
      const reviews = yield* FiberMap.make<RuntimeRequestId>();
      const waitingForCard = yield* Ref.make(new Set<RuntimeRequestId>());
      const settle = (id: RuntimeRequestId) =>
        Ref.update(waitingForCard, (current) => {
          const next = new Set(current);
          next.delete(id);
          return next;
        });

      // Per-event dispatch; each review has its own span.
      const onEvent = Effect.fnUntraced(function* (event: OrchestrationV2DomainEvent) {
        if (event.type === "runtime-request.updated") {
          const request = event.payload;
          if (request.status !== "pending" || request.autoReview?.state !== "reviewing") {
            yield* settle(request.id);
            yield* FiberMap.remove(reviews, request.id);
            return;
          }
          if (yield* FiberMap.has(reviews, request.id)) return;
          const { turnItems } = yield* projections.getThreadRecords(event.threadId, ["turnItems"], {
            turnItemRequestIds: [request.id],
          });
          if (turnItems.some((item) => item.type === "approval_request")) {
            yield* FiberMap.run(reviews, request.id, review(event.threadId, request.id));
            return;
          }
          yield* Ref.update(waitingForCard, (current) => new Set(current).add(request.id));
          yield* FiberMap.run(
            reviews,
            request.id,
            Effect.sleep(CARD_GRACE).pipe(
              Effect.andThen(settle(request.id)),
              Effect.andThen(review(event.threadId, request.id)),
            ),
          );
          return;
        }
        if (event.type === "turn-item.updated" && event.payload.type === "approval_request") {
          const requestId = event.payload.requestId;
          if (!(yield* Ref.get(waitingForCard)).has(requestId)) return;
          yield* settle(requestId);
          yield* FiberMap.run(reviews, requestId, review(event.threadId, requestId));
        }
      });

      yield* forkParked(
        Stream.runForEach(engine.streamDomainEvents, (event) =>
          onEvent(event).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("host review could not follow an event", {
                threadId: event.threadId,
                cause,
              }),
            ),
          ),
        ).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("host review event stream failed", { cause }),
          ),
        ),
      );
    },
  );

  return AutoApprovalReactor.of({ start, review });
});

export const layer = Layer.effect(AutoApprovalReactor, make);
