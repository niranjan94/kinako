import { expect, it } from "vite-plus/test";

import { resolveCompatibleRuntimeMode, resolveRuntimeModeOptions } from "./runtimeModeConfig";

const sandboxing = ["approval-required", "auto", "sandboxed-full-access", "full-access"] as const;

it("labels a sandboxed thread as such, disabled with why, wherever it cannot run", () => {
  const unsupported = resolveCompatibleRuntimeMode("sandboxed-full-access", ["full-access"]);
  expect(unsupported.mode).toBe("sandboxed-full-access");
  const [option] = resolveRuntimeModeOptions(
    unsupported.modes.filter((mode) => mode === "sandboxed-full-access"),
    undefined,
    { supportedRuntimeModes: ["full-access"], sandbox: { available: true } },
  );
  expect(option).toMatchObject({
    label: "Sandboxed full access",
    disabledReason:
      "This provider cannot run sandboxed full access, so the thread runs as Supervised.",
  });

  const unavailable = resolveRuntimeModeOptions(
    resolveCompatibleRuntimeMode("auto", sandboxing).modes,
    undefined,
    { supportedRuntimeModes: sandboxing, sandbox: { available: false, reason: "No bwrap." } },
  );
  expect(
    unavailable.map((entry) => [
      entry.mode,
      "disabledReason" in entry ? entry.disabledReason : undefined,
    ]),
  ).toEqual([
    ["approval-required", undefined],
    ["auto", undefined],
    ["sandboxed-full-access", "The sandbox is unavailable on this environment: No bwrap."],
    ["full-access", undefined],
  ]);
});

it("lists sandboxed full access only for providers that name it", () => {
  expect(resolveCompatibleRuntimeMode("auto", undefined).modes).not.toContain(
    "sandboxed-full-access",
  );
  expect(resolveCompatibleRuntimeMode("auto", sandboxing).modes).toContain("sandboxed-full-access");
});

it("ranks the administrator's ceiling above the sandbox reason", () => {
  const [option] = resolveRuntimeModeOptions(
    ["sandboxed-full-access"],
    { organization: "Example", lockedSettings: [], limits: { maxRuntimeMode: "auto" } },
    { supportedRuntimeModes: sandboxing, sandbox: { available: false, reason: "No bwrap." } },
  );
  expect(option).toMatchObject({ disabledReason: expect.stringContaining("Example") });
});
