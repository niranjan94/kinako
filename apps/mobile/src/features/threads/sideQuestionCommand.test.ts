import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { threadComposerContext } from "../../lib/composerContext";
import { withParentThreadReference } from "./sideQuestionCommand";

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
