import { assert, describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { codexHomes, codexSandboxPaths } from "./CodexSandbox.ts";

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

it.effect("finds the shared home a shadow home links its shared directories into", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fileSystem.realPath(
      yield* fileSystem.makeTempDirectoryScoped({ prefix: "kinako-codex-homes-" }),
    );
    const shared = path.join(root, "shared");
    const shadow = path.join(root, "shadow");
    yield* fileSystem.makeDirectory(path.join(shared, "sessions"), { recursive: true });
    yield* fileSystem.makeDirectory(shadow);
    yield* fileSystem.symlink(path.join(shared, "sessions"), path.join(shadow, "sessions"));
    yield* fileSystem.writeFileString(path.join(shadow, "auth.json"), "{}");

    assert.deepEqual(yield* codexHomes(shadow), [shadow, shared]);
    assert.deepEqual(yield* codexHomes(shared), [shared]);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
