import { describe, expect, it } from "vite-plus/test";

import { hostResourceHistoryPaths } from "./hostResources.ts";

describe("hostResourceHistoryPaths", () => {
  it("draws one step per bucket and breaks the line at gaps", () => {
    expect(hostResourceHistoryPaths([0.25, 0.5, null, 1])).toEqual({
      line: "M0 75L1 75L1 50L2 50M3 0L4 0",
      area: "M0 100L0 75L1 75L1 50L2 50L2 100ZM3 100L3 0L4 0L4 100Z",
    });
    expect(hostResourceHistoryPaths([null, null])).toEqual({ line: "", area: "" });
  });
});
