import {
  getPromptControlledTraits,
  getTraitSelectChange,
} from "@t3tools/client-runtime/model-traits";
import {
  ProviderInstanceId,
  type ManagedPolicySummary,
  type ProviderOptionDescriptor,
  type RuntimeMode,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  applyProviderOptionSelection,
  resolveProviderOptionDescriptors,
  withImplicitFastModeSelection,
} from "../../lib/providerOptions";
import { sandboxedRuntimeModeDenial } from "@t3tools/client-runtime/runtime-modes";

import {
  compatibleRuntimeModeForChoices,
  RUNTIME_MODE_CHOICES,
  resolveNewThreadRuntimeMode,
  runtimeModeChoicesForSupportedModes,
  selectableChoices,
  withManagedRuntimeModeLimits,
  withRuntimeModeDenials,
} from "./thread-settings-options";

const policy = (organization: string, maxRuntimeMode?: RuntimeMode): ManagedPolicySummary => ({
  organization,
  lockedSettings: [],
  ...(maxRuntimeMode === undefined ? {} : { limits: { maxRuntimeMode } }),
});

describe("managed runtime mode limits", () => {
  it("disables modes above the strictest target's ceiling with that target's reason", () => {
    const choices = withManagedRuntimeModeLimits(RUNTIME_MODE_CHOICES, [
      policy("Wide Corp", "auto"),
      undefined,
      policy("Narrow Corp", "auto-accept-edits"),
    ]);

    expect(choices.map((choice) => [choice.mode, choice.disabledReason])).toEqual([
      ["approval-required", undefined],
      ["auto-accept-edits", undefined],
      ["auto", "Narrow Corp limits threads to Auto-accept edits."],
      ["sandboxed-full-access", "Wide Corp limits threads to Auto."],
      ["full-access", "Wide Corp limits threads to Auto."],
    ]);
  });

  it("drops a new thread's draft mode above the ceiling for the default", () => {
    const capped = policy("Corp", "auto");
    expect(resolveNewThreadRuntimeMode("full-access", "auto", capped)).toBe("auto");
    expect(resolveNewThreadRuntimeMode("approval-required", "auto", capped)).toBe(
      "approval-required",
    );
    expect(resolveNewThreadRuntimeMode(undefined, "auto", capped)).toBe("auto");
    expect(resolveNewThreadRuntimeMode("full-access", "auto", undefined)).toBe("full-access");
  });
});

describe("sandboxed full access choices", () => {
  it("keeps a sandboxed thread labelled as such when its provider runs it as Supervised", () => {
    const supported = ["approval-required", "full-access"] as const;
    const choices = withRuntimeModeDenials(
      runtimeModeChoicesForSupportedModes(supported, "sandboxed-full-access"),
      (mode) => sandboxedRuntimeModeDenial(mode, supported, { available: true }),
    );
    expect(compatibleRuntimeModeForChoices("sandboxed-full-access", choices)).toBe(
      "sandboxed-full-access",
    );
    expect(choices.find((choice) => choice.mode === "sandboxed-full-access")).toMatchObject({
      label: "Sandboxed full access",
      disabledReason:
        "This provider cannot run sandboxed full access, so the thread runs as Supervised.",
    });
    expect(
      runtimeModeChoicesForSupportedModes(supported, "auto").map((choice) => choice.mode),
    ).toEqual(["approval-required", "full-access"]);
  });

  it("disables it with the server's reason and keeps a managed reason first", () => {
    const supported = ["auto", "sandboxed-full-access", "full-access"] as const;
    const deny = (mode: RuntimeMode) =>
      sandboxedRuntimeModeDenial(mode, supported, { available: false, reason: "No bwrap." });
    const choices = runtimeModeChoicesForSupportedModes(supported, "auto");
    expect(
      withRuntimeModeDenials(choices, deny).map((choice) => [choice.mode, choice.disabledReason]),
    ).toEqual([
      ["auto", undefined],
      ["sandboxed-full-access", "The sandbox is unavailable on this environment: No bwrap."],
      ["full-access", undefined],
    ]);
    const managed = withManagedRuntimeModeLimits(choices, [policy("Corp", "auto")]);
    expect(
      withRuntimeModeDenials(managed, deny).find(
        (choice) => choice.mode === "sandboxed-full-access",
      )?.disabledReason,
    ).toBe("Corp limits threads to Auto.");
  });
});

const effortDescriptor: Extract<ProviderOptionDescriptor, { type: "select" }> = {
  id: "effort",
  label: "Reasoning",
  type: "select",
  options: [
    { id: "low", label: "Low" },
    { id: "medium", label: "Medium", isDefault: true },
    { id: "high", label: "High" },
    { id: "ultrathink", label: "Ultrathink" },
    { id: "ultracode", label: "Ultracode" },
  ],
  currentValue: "high",
  promptInjectedValues: ["ultrathink"],
};

describe("fast mode switch", () => {
  // regression: #29729 Cursor reports Fast on by default, but its picker shows an unset fastMode as off
  it("shows an unset fast mode as off, saves it as off and turns it on when toggled", () => {
    const capabilities = {
      optionDescriptors: [
        { id: "fastMode", label: "Fast", type: "boolean", currentValue: true } as const,
      ],
    };
    const selection = { instanceId: ProviderInstanceId.make("cursor"), model: "composer-2.5" };
    const descriptors = resolveProviderOptionDescriptors({ capabilities, selections: undefined });
    const shown = descriptors.find((descriptor) => descriptor.id === "fastMode")?.currentValue;

    expect({
      shown,
      saved: withImplicitFastModeSelection(selection, [
        { instanceId: selection.instanceId, models: [{ slug: selection.model, capabilities }] },
      ]).options,
      afterToggle: applyProviderOptionSelection(descriptors, { id: "fastMode", value: !shown }),
    }).toEqual({
      shown: false,
      saved: [{ id: "fastMode", value: false }],
      afterToggle: [{ id: "fastMode", value: true }],
    });
  });
});

describe("selectableChoices", () => {
  // regression: #21406 bring model controls in line with web
  it("leaves out prompt-injected choices and keeps workflow choices in declared order", () => {
    expect(selectableChoices(effortDescriptor).map((choice) => choice.id)).toEqual([
      "low",
      "medium",
      "high",
      "ultracode",
    ]);
  });
});

describe("prompt-controlled reasoning", () => {
  it("removes the prefix when choosing a regular effort and saves Ultracode as an option", () => {
    const descriptors = [effortDescriptor];
    const prompt = "Ultrathink:\nsolve it";
    expect(
      getTraitSelectChange(
        { ...getPromptControlledTraits(descriptors, prompt), descriptors },
        effortDescriptor,
        prompt,
        "ultracode",
      ),
    ).toEqual({ prompt: "solve it", modelOptions: [{ id: "effort", value: "ultracode" }] });
  });

  it("keeps body-controlled Ultrathink locked", () => {
    const descriptors = [effortDescriptor];
    const prompt = "please ultrathink about this";
    const selected = { ...getPromptControlledTraits(descriptors, prompt), descriptors };
    expect(selected.ultrathinkInBodyText).toBe(true);
    expect(getTraitSelectChange(selected, effortDescriptor, prompt, "low")).toBeNull();
  });
});
