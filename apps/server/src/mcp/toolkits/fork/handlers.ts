import type { CommandId, OrchestrationV2Command, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as OrchestratorMcpService from "../../OrchestratorMcpService.ts";
import { dispatchFailure, newCommandId, readThread } from "../../threadAccess.ts";
import { ForkToolkit } from "./tools.ts";

const dispatch = Effect.fn("mcp.dispatchForkThreadCommand")(function* (
  threadId: ThreadId | undefined,
  command: (common: { commandId: CommandId; threadId: ThreadId }) => OrchestrationV2Command,
) {
  const { threads, projection } = yield* readThread(threadId);
  const result = yield* threads
    .dispatch(command({ commandId: yield* newCommandId(), threadId: projection.thread.id }))
    .pipe(Effect.mapError(dispatchFailure));
  return { sequence: result.sequence };
});

const writesThread = <P extends { readonly threadId?: ThreadId | undefined }, A, E, R>(
  handle: (params: P) => Effect.Effect<A, E, R>,
) => McpToolAccess.writesThreads((params: P) => [params.threadId], handle);

export const layer = McpToolAccess.toLayer(ForkToolkit, {
  t3_thread_summarize: writesThread((input) =>
    dispatch(input.threadId, (common) => ({
      type: "thread.summarize",
      ...common,
      messageId: input.messageId,
      direction: input.direction,
      ...(input.instructions === undefined ? {} : { instructions: input.instructions }),
    })),
  ),
  t3_thread_summary_restore: writesThread((input) =>
    dispatch(input.threadId, (common) => ({
      type: "thread.summary.restore",
      ...common,
      turnItemId: input.turnItemId,
    })),
  ),
  t3_suggest_follow_up: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const service = yield* OrchestratorMcpService.OrchestratorMcpService;
      return yield* service.suggestFollowUp(scope, input);
    }),
  ),
});
