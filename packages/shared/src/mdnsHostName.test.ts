import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/process";

import * as HostProcess from "./HostProcess.ts";
import { readMdnsHostName, toMdnsHostName } from "./mdnsHostName.ts";

const spawnerAnswering = (stdout: string) =>
  ChildProcessSpawner.make((command) =>
    command._tag === "StandardCommand" && command.command === "/usr/sbin/scutil"
      ? Effect.succeed(
          ChildProcessSpawner.makeHandle({
            pid: ChildProcessSpawner.ProcessId(1),
            exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
            isRunning: Effect.succeed(false),
            kill: () => Effect.void,
            unref: Effect.succeed(Effect.void),
            stdin: Sink.drain,
            stdout: Stream.make(new TextEncoder().encode(stdout)),
            stderr: Stream.empty,
            all: Stream.empty,
            getInputFd: () => Sink.drain,
            getOutputFd: () => Stream.empty,
          }),
        )
      : Effect.die(`unexpected command ${command._tag}`),
  );

const readFor = (platform: NodeJS.Platform, hostname: string, scutilStdout = "") =>
  readMdnsHostName.pipe(
    Effect.provideService(HostProcess.Platform, platform),
    Effect.provideService(HostProcess.Hostname, hostname),
    Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawnerAnswering(scutilStdout)),
  );

describe("mdnsHostName", () => {
  it("keeps the first DNS label, lowercased", () => {
    assert.equal(toMdnsHostName("Build-Box.example.com"), "build-box.local");
    assert.equal(toMdnsHostName("tardis.local"), "tardis.local");
  });

  it("rejects names that are not a valid DNS label", () => {
    assert.equal(toMdnsHostName(""), null);
    assert.equal(toMdnsHostName("Niranjan's Mac"), null);
    assert.equal(toMdnsHostName("-bad"), null);
  });

  it.effect("uses the OS hostname off macOS", () =>
    Effect.gen(function* () {
      assert.equal(yield* readFor("linux", "build-box"), "build-box.local");
    }),
  );

  it.effect("uses the Bonjour LocalHostName on macOS, not the OS hostname", () =>
    Effect.gen(function* () {
      assert.equal(yield* readFor("darwin", "tardis", "tardis-2\n"), "tardis-2.local");
    }),
  );

  it.effect("reports no name when LocalHostName is unreadable", () =>
    Effect.gen(function* () {
      assert.equal(yield* readFor("darwin", "tardis", ""), null);
    }),
  );
});
