import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { threadComposerContext } from "../../lib/composerContext";
import { parseBtwComposerQuestion, withParentThreadReference } from "./sideQuestionCommand";

describe("parseBtwComposerQuestion", () => {
  it("reads the question after /btw", () => {
    expect(parseBtwComposerQuestion("  /btw  why is this slow?\nsecond line ")).toBe(
      "why is this slow?\nsecond line",
    );
    expect(parseBtwComposerQuestion("/BTW what changed")).toBe("what changed");
  });

  it("treats a bare /btw as a request to reopen", () => {
    expect(parseBtwComposerQuestion("/btw")).toBe("");
    expect(parseBtwComposerQuestion("/btw   ")).toBe("");
  });

  it("ignores other text and non-turn submissions", () => {
    expect(parseBtwComposerQuestion("/btwx question")).toBeNull();
    expect(parseBtwComposerQuestion("please /btw question")).toBeNull();
    expect(parseBtwComposerQuestion("/btw question", "pending-user-input")).toBeNull();
    expect(parseBtwComposerQuestion("/btw question", "queued-message")).toBeNull();
  });
});

describe("withParentThreadReference", () => {
  const parent = threadComposerContext(
    { environmentId: EnvironmentId.make("env"), threadId: ThreadId.make("parent") },
    "Parent thread",
  );

  it("appends the parent thread reference once", () => {
    const text = withParentThreadReference("why?", parent);
    expect(text).toMatch(/^why\? \[Parent thread\]\(t3-context:/);
    expect(withParentThreadReference(text, parent)).toBe(text);
  });
});
