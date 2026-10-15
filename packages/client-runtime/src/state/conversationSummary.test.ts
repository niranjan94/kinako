import { describe, expect, it } from "vite-plus/test";

import {
  conversationSummaryFromHereMessageIds,
  conversationSummaryUpToHereMessageIds,
} from "./conversationSummary.ts";

describe("conversationSummaryUpToHereMessageIds", () => {
  const userMessage = (id: string, runId: string) => ({ id, role: "user", runId });
  const run = (id: string, ordinal: number, status: string) => ({ id, ordinal, status });

  it("offers messages with an earlier turn still in the conversation", () => {
    const eligible = conversationSummaryUpToHereMessageIds({
      messages: [
        userMessage("first", "run-1"),
        userMessage("second", "run-2"),
        userMessage("rewound", "run-3"),
        { id: "reply", role: "assistant", runId: "run-2" },
      ],
      runs: [
        run("run-1", 1, "completed"),
        run("run-2", 2, "completed"),
        run("run-3", 3, "rolled_back"),
      ],
    } as never);
    expect([...eligible]).toEqual(["second"]);
  });

  it("starts from the first turn that ran", () => {
    const eligible = conversationSummaryUpToHereMessageIds({
      messages: [
        userMessage("never-ran", "run-1"),
        userMessage("first-ran", "run-2"),
        userMessage("next", "run-3"),
      ],
      runs: [
        run("run-1", 1, "rolled_back"),
        run("run-2", 2, "completed"),
        run("run-3", 3, "failed"),
      ],
    } as never);
    expect([...eligible]).toEqual(["next"]);
  });
});

describe("conversationSummaryFromHereMessageIds", () => {
  const userMessage = (id: string, runId: string) => ({ id, role: "user", runId });
  const run = (id: string, ordinal: number, status: string) => ({ id, ordinal, status });
  const checkpoint = (appRunOrdinal: number | null, status = "ready") => ({
    appRunOrdinal,
    ordinalWithinScope: appRunOrdinal ?? 0,
    status,
  });

  it("offers messages with a ready checkpoint before their turn", () => {
    const eligible = conversationSummaryFromHereMessageIds({
      messages: [
        userMessage("first", "run-1"),
        userMessage("second", "run-2"),
        userMessage("third", "run-3"),
      ],
      runs: [
        run("run-1", 1, "completed"),
        run("run-2", 2, "completed"),
        run("run-3", 3, "completed"),
      ],
      checkpoints: [checkpoint(null), checkpoint(1, "stale"), checkpoint(2)],
    } as never);
    expect([...eligible]).toEqual(["first", "third"]);
  });
});
