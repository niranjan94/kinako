import { describe, expect, it } from "vite-plus/test";

import {
  isRuntimeModeOffered,
  sandboxedRuntimeModeDenial,
  sandboxUnavailableReason,
} from "./runtimeModes.ts";

const SANDBOXING = ["approval-required", "sandboxed-full-access", "full-access"] as const;

describe("isRuntimeModeOffered", () => {
  it("lists sandboxed full access only for providers that name it", () => {
    expect(isRuntimeModeOffered("sandboxed-full-access", "auto", SANDBOXING)).toBe(true);
    expect(isRuntimeModeOffered("sandboxed-full-access", "auto", undefined)).toBe(false);
    expect(isRuntimeModeOffered("sandboxed-full-access", "auto", ["approval-required"])).toBe(
      false,
    );
    expect(isRuntimeModeOffered("auto", "auto", undefined)).toBe(true);
  });

  it("keeps a stored sandboxed full access listed when the provider cannot run it", () => {
    expect(
      isRuntimeModeOffered("sandboxed-full-access", "sandboxed-full-access", ["full-access"]),
    ).toBe(true);
    expect(isRuntimeModeOffered("auto", "auto", ["full-access"])).toBe(false);
  });
});

describe("sandboxedRuntimeModeDenial", () => {
  it("disables the mode with the server's reason when the sandbox is unavailable", () => {
    const status = { available: false, reason: "bwrap was not found on PATH." };
    expect(sandboxedRuntimeModeDenial("sandboxed-full-access", SANDBOXING, status)).toBe(
      "The sandbox is unavailable on this environment: bwrap was not found on PATH.",
    );
    expect(sandboxedRuntimeModeDenial("full-access", SANDBOXING, status)).toBeUndefined();
  });

  it("says a provider without the mode runs the thread as Supervised", () => {
    expect(
      sandboxedRuntimeModeDenial("sandboxed-full-access", ["full-access"], { available: true }),
    ).toBe("This provider cannot run sandboxed full access, so the thread runs as Supervised.");
  });

  it("allows the mode when the provider names it and the sandbox runs", () => {
    expect(
      sandboxedRuntimeModeDenial("sandboxed-full-access", SANDBOXING, { available: true }),
    ).toBeUndefined();
    // Servers without the mode send no status and never list it.
    expect(sandboxUnavailableReason(undefined)).toBeUndefined();
  });
});
