import {
  MessageId,
  OrchestrationV2ConversationSummaryDirection,
  OrchestrationV2DispatchCommandResult,
  OrchestratorMcpFailure,
  OrchestratorMcpSuggestFollowUpInput,
  OrchestratorMcpSuggestFollowUpResult,
  ThreadId,
  TrimmedNonEmptyString,
  TurnItemId,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as OrchestratorMcpService from "../../OrchestratorMcpService.ts";

const commandTool = {
  success: OrchestrationV2DispatchCommandResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    Crypto.Crypto,
  ],
};

const ThreadSummarizeTool = Tool.make("t3_thread_summarize", {
  ...commandTool,
  description:
    "Replace part of a thread's provider context with a summary to free context window space. Files and checkpoints are not changed. direction=from_here summarizes messageId and every turn after it, rewinding the provider to before that message; up_to_here summarizes every turn before messageId on a fresh provider conversation and keeps the rest verbatim. Take messageId from a user message in t3_thread_read. instructions steer what the summary keeps. The thread must be idle, so a thread cannot summarize itself during its own turn. Acceptance means the summary is being written; a compaction item titled Summarized conversation appears when it is applied.",
  parameters: Schema.Struct({
    threadId: Schema.optional(ThreadId),
    messageId: MessageId,
    direction: OrchestrationV2ConversationSummaryDirection,
    instructions: Schema.optional(TrimmedNonEmptyString),
  }),
}).annotate(Tool.Destructive, true);

const ThreadSummaryRestoreTool = Tool.make("t3_thread_summary_restore", {
  ...commandTool,
  description:
    "Undo an up_to_here summary by switching back to the provider conversation that holds the full context. turnItemId is its Summarized conversation item from t3_thread_read. Turns taken since the summary are handed over. Omit threadId for this thread.",
  parameters: Schema.Struct({
    threadId: Schema.optional(ThreadId),
    turnItemId: TurnItemId,
  }),
}).annotate(Tool.Destructive, true);

const SuggestFollowUpTool = Tool.make("t3_suggest_follow_up", {
  description:
    "Record follow-up work you noticed but are not doing in this turn (missing tests, a related bug, a cleanup elsewhere) as a card in this thread. The user can start it as a new thread in one click or dismiss it. Call it once per distinct follow-up, and only for work worth its own thread; do not use it for steps you are about to do yourself. The new thread starts without this thread's context, so the prompt must stand alone. Returns immediately; nothing waits on the user.",
  parameters: OrchestratorMcpSuggestFollowUpInput,
  success: OrchestratorMcpSuggestFollowUpResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    OrchestratorMcpService.OrchestratorMcpService,
  ],
})
  .annotate(Tool.Title, "Suggest a follow-up thread")
  .annotate(Tool.Destructive, false);

export const ForkToolkit = Toolkit.make(
  ThreadSummarizeTool,
  ThreadSummaryRestoreTool,
  SuggestFollowUpTool,
);
