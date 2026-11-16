import { describe, expect, it } from "@effect/vitest";

import { codexSandboxPaths } from "./CodexSandbox.ts";

describe("codexSandboxPaths", () => {
  it.each([
    {
      name: "a user install inside CODEX_HOME",
      homes: ["/home/user/.codex"],
      executable: "/home/user/.codex/packages/standalone/releases/0.169.0/bin/codex",
      selfInvocationRoot: undefined,
      expected: [
        ["/home/user/.codex", "read-write"],
        ["/home/user/.codex/packages/standalone/releases/0.169.0/bin", "read-only"],
      ],
    },
    {
      name: "a managed shadow home with its shared home and a dev checkout",
      homes: ["/home/user/.kinako/userdata/providers/codex/work/shadow", "/home/user/.codex"],
      executable: "/home/user/.kinako/tools/codex/0.169.0/codex",
      selfInvocationRoot: "/home/user/code/kinako",
      expected: [
        ["/home/user/.kinako/userdata/providers/codex/work/shadow", "read-write"],
        ["/home/user/.codex", "read-write"],
        ["/home/user/.kinako/tools/codex/0.169.0", "read-only"],
        ["/home/user/code/kinako", "read-only"],
      ],
    },
  ])("lists $name", ({ homes, executable, selfInvocationRoot, expected }) => {
    expect(
      codexSandboxPaths({ homes, executable, selfInvocationRoot }).map(({ path, access }) => [
        path,
        access,
      ]),
    ).toEqual(expected);
  });
});
