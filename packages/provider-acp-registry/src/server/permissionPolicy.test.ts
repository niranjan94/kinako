import { assert, describe, it } from "@effect/vitest";

import { acpRegistryPermissionDisposition } from "./permissionPolicy.ts";

const request = (kind: "execute" | "edit" | "read") => ({
  sessionId: "session-1",
  toolCall: { toolCallId: `${kind}-1`, title: kind, kind },
  options: [{ optionId: "allow", name: "Allow", kind: "allow_once" as const }],
});

describe("acpRegistryPermissionDisposition", () => {
  it("asks under Auto for anything Supervised asks about, and still allows reads", () => {
    const auto = { runtimeMode: "auto" as const, cwd: "/workspace" };
    assert.equal(acpRegistryPermissionDisposition(auto, request("execute")), "ask");
    assert.equal(acpRegistryPermissionDisposition(auto, request("edit")), "ask");
    assert.equal(acpRegistryPermissionDisposition(auto, request("read")), "allow");
    assert.equal(
      acpRegistryPermissionDisposition({ ...auto, runtimeMode: "full-access" }, request("execute")),
      "allow",
    );
  });
});
