import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { resolveUserDataPath } from "./DesktopUserData.ts";

it.effect("never carries Windows credential keys over from an upstream T3 Code profile", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "kinako-profile-" });
    for (const upstream of ["t3code", "t3code-v2"]) {
      yield* fs.makeDirectory(path.join(directory, upstream), { recursive: true });
      yield* fs.writeFileString(path.join(directory, upstream, "Local State"), "upstream keys");
    }

    const userData = yield* resolveUserDataPath({
      appDataDirectory: directory,
      isDevelopment: false,
    });

    assert.equal(userData, path.join(directory, "kinako"));
    assert.isFalse(yield* fs.exists(userData));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
