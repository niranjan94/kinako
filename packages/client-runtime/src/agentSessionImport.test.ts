import { describe, expect, it } from "vite-plus/test";

import { isAgentSessionRecentlyActive } from "./agentSessionImport.ts";

describe("isAgentSessionRecentlyActive", () => {
  const nowMs = Date.parse("2026-10-13T12:00:00.000Z");

  it("flags a session written in the last few minutes", () => {
    expect(isAgentSessionRecentlyActive({ updatedAt: "2026-10-13T11:58:00.000Z" }, nowMs)).toBe(
      true,
    );
  });

  it("does not flag an older session", () => {
    expect(isAgentSessionRecentlyActive({ updatedAt: "2026-10-13T11:50:00.000Z" }, nowMs)).toBe(
      false,
    );
  });
});
