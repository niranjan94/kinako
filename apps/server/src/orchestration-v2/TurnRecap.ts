import {
  CommandId,
  type OrchestrationV2DomainEvent,
  type RunId,
  type ThreadId,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import { omitToolOutputImageData } from "@t3tools/shared/toolOutput";

import * as Schema from "effect/Schema";

import type { PendingOrchestrationEffectV2 } from "./EffectOutbox.ts";

export function turnRecapEffect(threadId: ThreadId, runId: RunId): PendingOrchestrationEffectV2 {
  return {
    id: `effect:run-recap.generate:${runId}`,
    commandId: CommandId.make(`command:run-recap.generate:${runId}`),
    threadId,
    request: { type: "run-recap.generate", runId },
  };
}

export function turnRecapEffects(
  events: ReadonlyArray<OrchestrationV2DomainEvent>,
): Array<PendingOrchestrationEffectV2> {
  return events.flatMap((event) =>
    event.type === "run.updated" &&
    event.payload.recap === undefined &&
    // Workspace preparation can retry the same run; it has no agent work to recap yet.
    event.payload.startedAt !== null &&
    (event.payload.status === "completed" || event.payload.status === "failed")
      ? [turnRecapEffect(event.threadId, event.payload.id)]
      : [],
  );
}

const encodeEvidence = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

function recapEvidence(item: OrchestrationV2TurnItem): string | null {
  switch (item.type) {
    case "user_message":
    case "assistant_message":
      return item.text;
    case "command_execution":
      return `${item.input}\nExit code: ${item.exitCode ?? "unknown"}\n${item.output ?? ""}`;
    case "dynamic_tool":
      return `${item.toolName ?? "Tool"}\n${item.input === undefined ? "" : encodeEvidence(item.input)}\n${item.output === undefined ? "" : encodeEvidence(omitToolOutputImageData(item.output))}`;
    case "checkpoint":
      return encodeEvidence(item.files);
    case "error":
      return encodeEvidence(item.failure);
    case "subagent":
      return `${item.prompt}\n${item.result ?? item.progress ?? "No result yet."}`;
    case "todo_list":
      return encodeEvidence(item.steps);
    default:
      return null;
  }
}

export function renderTurnRecapTranscript(items: ReadonlyArray<OrchestrationV2TurnItem>): string {
  const entries = items
    .toSorted((a, b) => a.ordinal - b.ordinal)
    .flatMap((item) => {
      const evidence = recapEvidence(item);
      if (!evidence?.trim()) return [];
      const bounded =
        evidence.length <= 6_000
          ? evidence
          : `${evidence.slice(0, 2_000)}\n[truncated]\n${evidence.slice(-4_000)}`;
      return [`${item.type} (${item.status}):\n${bounded}`];
    });
  const transcript = entries.join("\n\n");
  return transcript.length <= 40_000
    ? transcript
    : `${transcript.slice(0, 8_000)}\n[earlier evidence omitted]\n${transcript.slice(-31_900)}`;
}
