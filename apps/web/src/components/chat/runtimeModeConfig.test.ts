import { describe, expect, it } from "vite-plus/test";

import { resolveCompatibleRuntimeMode } from "./runtimeModeConfig";

describe("resolveCompatibleRuntimeMode", () => {
  it("trades Auto for host review at the same rank, else falls back to the first mode", () => {
    const kiro = ["approval-required", "host-auto", "full-access"] as const;
    const cursor = ["approval-required", "auto-accept-edits", "auto", "full-access"] as const;
    expect(resolveCompatibleRuntimeMode("auto", kiro).mode).toBe("host-auto");
    expect(resolveCompatibleRuntimeMode("host-auto", cursor).mode).toBe("auto");
    expect(resolveCompatibleRuntimeMode("auto-accept-edits", kiro).mode).toBe("approval-required");
    expect(resolveCompatibleRuntimeMode("host-auto", undefined).mode).toBe("host-auto");
  });
});
