import { CommandId } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as Scheduler from "../scheduling/Scheduler.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const crypto = yield* Crypto.Crypto;
    const scheduler = yield* Scheduler.Scheduler;
    yield* scheduler.register(
      "snooze-wake",
      Effect.gen(function* () {
        const now = yield* DateTime.now;
        const threads = yield* projections.getSnoozeWakeCandidates(now);
        for (const thread of threads) {
          if (thread.snoozedUntil == null) continue;
          yield* orchestrator
            .dispatch({
              type: "thread.snooze.wake-announce",
              // The persisted marker deduplicates successful announcements. A fresh
              // command lets a previously early-woken snooze be rescheduled to this time.
              commandId: CommandId.make(`snooze-wake:${thread.id}:${yield* crypto.randomUUIDv4()}`),
              threadId: thread.id,
              wakeAt: thread.snoozedUntil,
            })
            .pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("snooze-wake.dispatch-failed", { threadId: thread.id, cause }),
              ),
            );
        }
      }),
    );
  }),
);
