import { assert, describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import { spawnClaudeProcessGroup } from "../../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import * as ProcessRunner from "../../processRunner.ts";
import * as Bubblewrap from "../../sandbox/Bubblewrap.ts";
import { claudeSandboxPaths } from "./ClaudeSandbox.ts";

describe("claudeSandboxPaths", () => {
  it.each([
    {
      platform: "linux" as const,
      configDir: "/home/user/.claude",
      executable: "/home/user/.local/share/claude/versions/2.1.0",
      expected: [
        ["/home/user/.claude", "read-write"],
        ["/home/user/.claude.json", "read-write"],
        ["/home/user/.local/state/claude", "read-write"],
        ["/home/user/.local/share/claude", "read-only"],
        ["/home/user/.local/bin", "read-only"],
        ["/home/user/.config/anthropic", "read-only"],
        ["/home/user/.local/share/claude/versions", "read-only"],
      ],
    },
    {
      platform: "darwin" as const,
      configDir: "/Users/user/claude-config",
      executable: "/opt/homebrew/bin/claude",
      expected: [
        ["/Users/user/claude-config", "read-write"],
        ["/Users/user/.claude.json", "read-write"],
        ["/Users/user/.local/state/claude", "read-write"],
        ["/Users/user/.local/share/claude", "read-only"],
        ["/Users/user/.local/bin", "read-only"],
        ["/Users/user/.config/anthropic", "read-only"],
        ["/opt/homebrew/bin", "read-only"],
        ["/Users/user/Library/Keychains", "read-only"],
        ["/Users/user/Library/Keychains/login.keychain-db", "read-write"],
        ["/Users/user/Library/Preferences/com.apple.security.plist", "read-only"],
      ],
    },
  ])("lists Claude's paths on $platform", ({ platform, configDir, executable, expected }) => {
    const home = platform === "darwin" ? "/Users/user" : "/home/user";
    expect(
      claudeSandboxPaths({ platform, home, configDir, executable }).map(({ path, access }) => [
        path,
        access,
      ]),
    ).toEqual(expected);
  });
});

const services = ProcessRunner.layer.pipe(Layer.provideMerge(NodeServices.layer));

// Hosts without a working bwrap check the other half of the contract: wrap refuses.
it.live("stops a sandboxed CLI with the SDK's SIGTERM and leaves no process behind", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const runner = yield* ProcessRunner.ProcessRunner;
    const bubblewrap = yield* Bubblewrap.Bubblewrap;
    const environment = yield* HostProcess.Environment;
    const cwd = yield* fileSystem.realPath(
      yield* fileSystem.makeTempDirectoryScoped({ prefix: "kinako-claude-stop-" }),
    );
    const script = path.join(cwd, "fake-claude.sh");
    yield* fileSystem.writeFileString(
      script,
      [
        "sleep 300 &",
        `trap 'kill $!; echo graceful > marker; exit 0' TERM`,
        "echo ready",
        "wait",
      ].join("\n"),
    );
    const wrapped = bubblewrap.wrap({
      command: "/bin/sh",
      args: [script],
      policy: {
        platform: "linux",
        cwd,
        entries: [{ path: cwd, access: "read-write", kind: "directory", source: "cwd" }],
        rejected: [],
      },
    });
    const availability = yield* bubblewrap.availability;
    if (availability._tag === "Unavailable") {
      assert.equal((yield* Effect.flip(wrapped)).reason, availability.reason);
      return;
    }

    const command = yield* wrapped;
    const child = spawnClaudeProcessGroup(
      {
        command: command.command,
        args: [...command.args],
        cwd,
        env: environment,
        signal: yield* Effect.abortSignal,
      },
      undefined,
      undefined,
      undefined,
      undefined,
      true,
    );
    const exited = Effect.callback<void>((resume) => {
      child.once("exit", () => resume(Effect.void));
    });
    yield* Effect.callback<void>((resume) => {
      child.stdout.once("data", () => resume(Effect.void));
    });
    const group = yield* runner.run({ command: "ps", args: ["-o", "pid=", "-g", `${child.pid}`] });
    const recorded = group.stdout
      .split("\n")
      .map((line) => Number(line.trim()))
      .filter((pid) => pid > 0);
    // The CLI, the sleep it started, bwrap and its init, and the group watcher.
    assert.isAtLeast(recorded.length, 4);

    child.kill("SIGTERM");
    yield* exited;

    assert.equal((yield* fileSystem.readFileString(path.join(cwd, "marker"))).trim(), "graceful");
    // A killed process can stay a zombie until its reaper runs; that is not a survivor.
    const survivors: Array<number> = [];
    for (const pid of recorded) {
      const stat = yield* fileSystem
        .readFileString(`/proc/${pid}/stat`)
        .pipe(Effect.orElseSucceed(() => ""));
      const state = stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3);
      if (stat !== "" && state !== "Z") survivors.push(pid);
    }
    assert.deepEqual(survivors, []);
  }).pipe(Effect.scoped, Effect.provide(Bubblewrap.layer.pipe(Layer.provideMerge(services)))),
);
