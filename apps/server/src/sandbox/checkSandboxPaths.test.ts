import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";
import { checkSandboxPaths } from "./checkSandboxPaths.ts";

const layer = Layer.mergeAll(
  ProcessRunner.layer,
  ServerConfig.layerTest(process.cwd(), { prefix: "kinako-sandbox-check-" }),
).pipe(Layer.provideMerge(NodeServices.layer));

it.live("reports the listed paths the sandbox leaves out or warns about, with their lists", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const config = yield* ServerConfig.ServerConfig;
    const home = yield* fileSystem.realPath(
      yield* fileSystem.makeTempDirectoryScoped({ prefix: "kinako-sandbox-check-home-" }),
    );
    yield* fileSystem.makeDirectory(path.join(home, "cache"), { recursive: true });
    yield* fileSystem.makeDirectory(path.join(home, ".ssh"), { recursive: true });
    yield* fileSystem.makeDirectory(path.join(config.baseDir, "secrets"), { recursive: true });

    const result = yield* checkSandboxPaths({
      readWritePaths: ["relative/cache", "~", "~/cache", "~/missing", "~/.gradle"],
      readOnlyPaths: ["~/a*/b", path.join(config.baseDir, "secrets"), "~/.ssh"],
    }).pipe(
      Effect.provideService(HostProcess.Platform, "linux"),
      Effect.provideService(HostProcess.HomeDirectory, home),
    );

    const realBase = yield* fileSystem.realPath(config.baseDir);
    assert.deepEqual(
      result.rejected.map(({ path, list, reason }) => ({ path, list, reason })),
      [
        {
          path: "relative/cache",
          list: "read-write",
          reason: "Not an absolute or home-relative path.",
        },
        {
          path: path.join(home, "a*/b"),
          list: "read-only",
          reason: "Only the last path segment may hold a wildcard.",
        },
        { path: home, list: "read-write", reason: "Exposes the whole home directory." },
        {
          path: path.join(realBase, "secrets"),
          list: "read-only",
          reason: `Inside ${realBase}, which always stays hidden.`,
        },
      ],
    );
    // A missing default such as ~/.gradle is expected, so only ~/missing warns.
    assert.deepEqual(result.warnings, [
      {
        path: path.join(home, "missing"),
        list: "read-write",
        reason: "Does not exist yet, so it is skipped.",
      },
      {
        path: path.join(home, ".ssh"),
        list: "read-only",
        reason: "May expose credentials kept in ~/.ssh.",
      },
    ]);
  }).pipe(Effect.scoped, Effect.provide(layer)),
);
