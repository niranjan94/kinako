import { describe, expect, it } from "vite-plus/test";
import {
  EventId,
  MessageId,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2TurnItem,
  ProviderInstanceId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { renderTurnRecapTranscript, turnRecapEffects } from "./TurnRecap.ts";

const at = DateTime.makeUnsafe("2026-10-21T00:00:00.000Z");
const threadId = ThreadId.make("recap:thread");
const runId = RunId.make("recap:run");
const itemBase = {
  title: null,
  threadId,
  runId,
  nodeId: null,
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  ordinal: 1,
  status: "completed" as const,
  startedAt: at,
  completedAt: at,
  updatedAt: at,
};
const user: OrchestrationV2TurnItem = {
  ...itemBase,
  id: TurnItemId.make("recap:user"),
  type: "user_message",
  createdBy: "user",
  creationSource: "web",
  messageId: MessageId.make("recap:user"),
  inputIntent: "turn_start",
  text: "Fix the SQLite completion failure.",
  attachments: [],
};
const command: OrchestrationV2TurnItem = {
  ...itemBase,
  ordinal: 2,
  id: TurnItemId.make("recap:command"),
  type: "command_execution",
  input: "vp test run completion.test.ts",
  exitCode: 1,
  output: "SQLite completion test FAILED",
  status: "failed",
};
const answer: OrchestrationV2TurnItem = {
  ...itemBase,
  ordinal: 3,
  id: TurnItemId.make("recap:answer"),
  type: "assistant_message",
  messageId: MessageId.make("recap:answer"),
  streaming: false,
  text: "Not yet. Reran the failed check; watching PR #56.",
};

describe("turn recap evidence", () => {
  it("includes the request, failed checks, and final answer in turn order", () => {
    const transcript = renderTurnRecapTranscript([answer, user, command]);
    expect(transcript).toContain("Exit code: 1");
    expect(transcript).toContain("SQLite completion test FAILED");
    expect(transcript.indexOf(user.text)).toBeLessThan(transcript.indexOf(command.input));
    expect(transcript.indexOf(command.input)).toBeLessThan(transcript.indexOf(answer.text));
  });
  it("bounds large outputs while retaining the request and final answer", () => {
    const transcript = renderTurnRecapTranscript([
      user,
      ...Array.from({ length: 30 }, (_, i) => ({
        ...command,
        ordinal: i + 2,
        id: TurnItemId.make(`recap:output:${i}`),
        output: "x".repeat(20_000) + "CHECK FAILED",
      })),
      { ...answer, ordinal: 33 },
    ]);
    expect(transcript.length).toBeLessThanOrEqual(40_000);
    expect(transcript).toContain(user.text);
    expect(transcript).toContain(answer.text);
    expect(transcript).toContain("CHECK FAILED");
    expect(transcript).toContain("[earlier evidence omitted]");
  });

  it.each(["mcp", "claude"] as const)(
    "keeps checks and screenshot descriptions instead of %s image bytes",
    (format) => {
      const data = "A".repeat(1_000_000);
      const image =
        format === "mcp"
          ? { type: "image", mimeType: "image/png", data }
          : { type: "image", source: { type: "base64", media_type: "image/png", data } };
      const screenshots: OrchestrationV2TurnItem[] = Array.from({ length: 8 }, (_, index) => ({
        ...itemBase,
        id: TurnItemId.make(`recap:screenshot:${index}`),
        ordinal: 2 + index * 2,
        type: "dynamic_tool",
        toolName: "preview_screenshot",
        input: {},
        output: { content: [{ type: "text", text: `Visual check ${index} passed.` }, image] },
      }));
      const transcript = renderTurnRecapTranscript([
        user,
        ...screenshots,
        { ...command, ordinal: 9 },
        { ...answer, ordinal: 19 },
      ]);
      expect(transcript).not.toContain("AAAA");
      expect(transcript).not.toContain("[truncated]");
      expect(transcript).not.toContain("[earlier evidence omitted]");
      expect(transcript).toContain('"mimeType":"image/png"');
      for (let index = 0; index < 8; index++) {
        expect(transcript).toContain(`Visual check ${index} passed.`);
      }
      expect(transcript).toContain("SQLite completion test FAILED");
      expect(transcript).toContain(user.text);
      expect(transcript).toContain(answer.text);
      expect(image.source?.data ?? image.data).toBe(data);
    },
  );
});

describe("turn recap scheduling", () => {
  const event: Extract<OrchestrationV2DomainEvent, { type: "run.updated" }> = {
    id: EventId.make("recap:event"),
    threadId,
    runId,
    occurredAt: at,
    type: "run.updated",
    payload: {
      id: runId,
      threadId,
      ordinal: 1,
      status: "completed",
      requestedAt: at,
      startedAt: at,
      completedAt: at,
      providerInstanceId: ProviderInstanceId.make("codex"),
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "test" },
      providerThreadId: null,
      userMessageId: MessageId.make("recap:user"),
      rootNodeId: null,
      activeAttemptId: null,
      checkpointId: null,
      contextHandoffId: null,
    },
  };
  it("schedules once per run identity for completed and failed turns", () => {
    const completed = turnRecapEffects([event]);
    const failed = turnRecapEffects([
      { ...event, payload: { ...event.payload, status: "failed" } },
    ]);
    expect(completed).toHaveLength(1);
    expect(failed).toHaveLength(1);
    expect(failed[0]?.id).toBe(completed[0]?.id);
  });
  it("does not backfill imported history or summarize cancelled and unfinished turns", () => {
    expect(turnRecapEffects([{ ...event, type: "run.created" }])).toEqual([]);
    expect(
      turnRecapEffects([
        { ...event, payload: { ...event.payload, status: "failed", startedAt: null } },
      ]),
    ).toEqual([]);
    for (const status of [
      "running",
      "waiting",
      "interrupted",
      "cancelled",
      "rolled_back",
    ] as const) {
      expect(turnRecapEffects([{ ...event, payload: { ...event.payload, status } }])).toEqual([]);
    }
  });
});
