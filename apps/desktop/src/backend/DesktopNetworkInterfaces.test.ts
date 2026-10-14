import { assert, describe, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/process";
import { beforeEach, vi } from "vite-plus/test";

const { networkInterfacesMock } = vi.hoisted(() => ({
  networkInterfacesMock: vi.fn(),
}));

vi.mock("node:os", () => ({
  networkInterfaces: networkInterfacesMock,
}));

import * as DesktopNetworkInterfaces from "./DesktopNetworkInterfaces.ts";

function layerSpawnerWithStdout(stdout: string) {
  return Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make(() =>
      Effect.succeed(
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
      ),
    ),
  );
}

const layerFor = (platform: NodeJS.Platform, spawnerStdout = "", hostname = "tardis") =>
  DesktopNetworkInterfaces.layer.pipe(
    Layer.provide(Layer.succeed(HostProcess.Platform, platform)),
    Layer.provide(Layer.succeed(HostProcess.Hostname, hostname)),
    Layer.provide(layerSpawnerWithStdout(spawnerStdout)),
  );

const layerTest = layerFor("linux");

describe("DesktopNetworkInterfaces", () => {
  beforeEach(() => {
    networkInterfacesMock.mockReset();
  });

  it.effect("names the mDNS host after the OS hostname off macOS", () =>
    Effect.gen(function* () {
      const service = yield* DesktopNetworkInterfaces.DesktopNetworkInterfaces;
      assert.equal(yield* service.readMdnsHostName, "build-box.local");
    }).pipe(Effect.provide(layerFor("linux", "", "Build-Box.example.com"))),
  );

  it.effect("names the mDNS host after LocalHostName on macOS", () =>
    Effect.gen(function* () {
      const service = yield* DesktopNetworkInterfaces.DesktopNetworkInterfaces;
      assert.equal(yield* service.readMdnsHostName, "tardis-2.local");
    }).pipe(Effect.provide(layerFor("darwin", "tardis-2\n"))),
  );

  it.effect("reads network interfaces through the service", () => {
    const interfaces = {
      en0: [
        {
          address: "192.168.1.10",
          family: "IPv4",
          internal: false,
        },
      ],
    };
    networkInterfacesMock.mockReturnValueOnce(interfaces);

    return Effect.gen(function* () {
      const service = yield* DesktopNetworkInterfaces.DesktopNetworkInterfaces;
      assert.strictEqual(yield* service.read, interfaces);
    }).pipe(Effect.provide(layerTest));
  });

  it.effect("preserves network interface read failures as structured defects", () => {
    const cause = new Error("network interface probe failed");
    networkInterfacesMock.mockImplementationOnce(() => {
      throw cause;
    });

    return Effect.gen(function* () {
      const service = yield* DesktopNetworkInterfaces.DesktopNetworkInterfaces;
      const exit = yield* Effect.exit(service.read);

      assert.equal(exit._tag, "Failure");
      if (exit._tag === "Failure") {
        const error = Cause.squash(exit.cause);
        assert.instanceOf(error, DesktopNetworkInterfaces.DesktopNetworkInterfacesReadError);
        assert.equal(error.platform, "linux");
        assert.strictEqual(error.cause, cause);
        assert.equal(error.message, "Failed to read desktop network interfaces on linux.");
      }
    }).pipe(Effect.provide(layerTest));
  });
});
