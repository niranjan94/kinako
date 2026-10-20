import { describe, expect, it } from "vite-plus/test";

import { deriveTurnRecap, turnRecapMessageExcerpt } from "./turnRecap.ts";

const run = (status: string) =>
  ({ runId: "run-1", status, assistantMessageId: "message-1" }) as never;

const baseInput = {
  working: false,
  latestRun: run("completed"),
  runtime: null,
  pendingRequests: null,
  messages: [{ id: "message-1", text: "Fixed the flaky test." }] as never,
  checkpoints: [],
};

describe("deriveTurnRecap", () => {
  it("recaps a completed turn with its final message and diff totals", () => {
    const recap = deriveTurnRecap({
      ...baseInput,
      checkpoints: [
        {
          runId: "run-1",
          files: [
            { path: "a.ts", kind: "modified", additions: 3, deletions: 1 },
            { path: "b.ts", kind: "added", additions: 10, deletions: 0 },
          ],
        },
      ] as never,
    });

    expect(recap).toEqual({
      runId: "run-1",
      outcome: "completed",
      request: null,
      finalMessage: { text: "Fixed the flaky test.", elided: false },
      changes: { fileCount: 2, additions: 13, deletions: 1 },
    });
  });

  it("puts a pending approval ahead of the run status", () => {
    const recap = deriveTurnRecap({
      ...baseInput,
      working: true,
      latestRun: run("running"),
      pendingRequests: {
        approvals: [{ requestKind: "command", detail: "pnpm test" }],
        userInputs: [{ questions: [{ question: "Which branch?" }] }],
      } as never,
    });

    expect(recap?.outcome).toBe("approval");
    expect(recap?.request).toBe("pnpm test");
  });

  it("falls back to the approval kind when the request has no detail", () => {
    const recap = deriveTurnRecap({
      ...baseInput,
      pendingRequests: { approvals: [{ requestKind: "file-change" }], userInputs: [] } as never,
    });

    expect(recap?.request).toBe("File change approval");
  });

  it("names the first pending question", () => {
    const recap = deriveTurnRecap({
      ...baseInput,
      latestRun: run("waiting"),
      pendingRequests: {
        approvals: [],
        userInputs: [{ questions: [{ question: "Which branch?" }, { question: "Rebase?" }] }],
      } as never,
    });

    expect(recap?.outcome).toBe("input");
    expect(recap?.request).toBe("Which branch?");
  });

  it("separates usage limits from other failures", () => {
    expect(deriveTurnRecap({ ...baseInput, latestRun: run("failed") })?.outcome).toBe("failed");
    expect(
      deriveTurnRecap({
        ...baseInput,
        latestRun: run("failed"),
        runtime: { lastErrorClass: "usage_limit" },
      })?.outcome,
    ).toBe("limited");
  });

  it("has no recap while working or after the user stopped the turn", () => {
    for (const status of ["running", "interrupted", "cancelled", "rolled_back"]) {
      expect(deriveTurnRecap({ ...baseInput, latestRun: run(status) })).toBeNull();
    }
    expect(deriveTurnRecap({ ...baseInput, latestRun: null })).toBeNull();
    expect(deriveTurnRecap({ ...baseInput, working: true })).toBeNull();
  });
});

describe("turnRecapMessageExcerpt", () => {
  it("keeps the opening prose paragraph as plain text", () => {
    expect(
      turnRecapMessageExcerpt(
        "```ts\nconst x = 1;\n```\n\n## Done\n**Updated** the [parser](src/parser.ts) and `lexer`.\n\nMore detail.",
      ),
    ).toEqual({ text: "Updated the parser and lexer.", elided: true });
  });

  it("marks a single short paragraph as the whole message", () => {
    expect(turnRecapMessageExcerpt("**Done.** Tests pass.")).toEqual({
      text: "Done. Tests pass.",
      elided: false,
    });
  });

  it("skips a heading-only opening paragraph", () => {
    expect(turnRecapMessageExcerpt("## Summary\n\n- Renamed the flag\n- Added tests")?.text).toBe(
      "Renamed the flag Added tests",
    );
    expect(turnRecapMessageExcerpt("# All done")?.text).toBe("All done");
  });

  it("caps long paragraphs", () => {
    const excerpt = turnRecapMessageExcerpt("word ".repeat(200));
    expect(excerpt?.text.length).toBe(280);
    expect(excerpt?.text.endsWith("…")).toBe(true);
    expect(excerpt?.elided).toBe(true);
  });

  it("returns null for messages without prose", () => {
    expect(turnRecapMessageExcerpt("```\ncode only\n```")).toBeNull();
    expect(turnRecapMessageExcerpt("   ")).toBeNull();
  });
});
