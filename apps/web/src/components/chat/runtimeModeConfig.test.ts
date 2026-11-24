import { describe, expect, it } from "vite-plus/test";

import { draftSupportedRuntimeModes, resolveCompatibleRuntimeMode } from "./runtimeModeConfig";

describe("draftSupportedRuntimeModes", () => {
  const supervisedOnly = {
    instanceId: "fx",
    supportedRuntimeModes: ["approval-required"],
  } as const;
  const noAuto = {
    instanceId: "muse",
    supportedRuntimeModes: ["approval-required", "full-access"],
  } as const;
  const everyMode = { instanceId: "codex" };
  const providers = [supervisedOnly, noAuto, everyMode];

  it.each([
    { label: "one provider that supports it", selections: [supervisedOnly, noAuto] },
    { label: "a provider that reports no modes", selections: [supervisedOnly, everyMode] },
  ])("shows Full access when a multi-model draft includes $label", ({ selections }) => {
    const modes = draftSupportedRuntimeModes(
      supervisedOnly.supportedRuntimeModes,
      selections,
      providers,
    );
    expect(resolveCompatibleRuntimeMode("full-access", modes).mode).toBe("full-access");
  });

  it("falls back only when no selected provider can run the mode", () => {
    const modes = draftSupportedRuntimeModes(undefined, [supervisedOnly, noAuto], providers);
    expect(resolveCompatibleRuntimeMode("auto", modes).mode).toBe("approval-required");
  });
});

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
