import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Redacted from "effect/Redacted";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { HttpClient } from "effect/http";
import * as RelayClient from "@t3tools/shared/relayClient";
import type { ManagedPolicyDocument } from "@t3tools/contracts";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import * as PublicRoute from "./PublicRoute.ts";

const HOSTNAME = "kn-abcdefghijklmnopqrstuvwxyz.example.com";
const REJECTED_LINE =
  '2026-10-06T12:00:00Z ERR Register tunnel error from server side error="Unauthorized: Tunnel not found" connIndex=0\n';

const makeFixture = Effect.fnUntraced(function* (stored?: string, policy?: ManagedPolicyDocument) {
  const secrets = new Map<string, Uint8Array>();
  if (stored !== undefined) {
    secrets.set(PublicRoute.PUBLIC_ROUTE_SECRET, new TextEncoder().encode(stored));
  }
  const spawned: Array<ChildProcess.StandardCommand> = [];
  const killed: Array<number> = [];
  const output = yield* Queue.unbounded<Uint8Array>();
  const spawner = ChildProcessSpawner.make((command) =>
    Effect.gen(function* () {
      if (!ChildProcess.isStandardCommand(command)) throw new Error("Expected standard command.");
      spawned.push(command);
      const pid = 900 + spawned.length;
      let running = true;
      const handle = ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(pid),
        exitCode: Effect.never,
        isRunning: Effect.sync(() => running),
        kill: () =>
          Effect.sync(() => {
            running = false;
            killed.push(pid);
          }),
        unref: Effect.succeed(Effect.void),
        stdin: Sink.drain,
        stdout: Stream.empty,
        stderr: Stream.empty,
        all: Stream.fromQueue(output),
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      });
      yield* Effect.addFinalizer(() => handle.kill().pipe(Effect.ignore));
      return handle;
    }),
  );
  const layer = PublicRoute.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Layer.succeed(
          HttpClient.HttpClient,
          HttpClient.make(() => Effect.die("unused")),
        ),
        Layer.succeed(
          RelayClient.RelayClient,
          RelayClient.RelayClient.of({
            resolve: Effect.succeed({
              status: "available",
              executablePath: "cloudflared",
              source: "path",
              version: RelayClient.CLOUDFLARED_VERSION,
            }),
            install: Effect.die("unused"),
            installWithProgress: () => Effect.die("unused"),
            pruneManagedVersions: Effect.void,
          }),
        ),
        Layer.mock(ServerSecretStore.ServerSecretStore)({
          get: (name) => Effect.succeed(Option.fromNullishOr(secrets.get(name))),
          set: (name, value) => Effect.sync(() => void secrets.set(name, value)),
          remove: (name) => Effect.sync(() => void secrets.delete(name)),
        }),
        ManagedPolicy.layerTest(policy),
        ServerConfig.layerTest(process.cwd(), { prefix: "t3-public-route-test-" }),
      ).pipe(Layer.provideMerge(NodeServices.layer)),
    ),
  );
  return { secrets, spawned, killed, output, layer };
});

describe("PublicRoute", () => {
  it.effect("stores the connector on enable and removes it on disable", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      yield* Effect.gen(function* () {
        const publicRoute = yield* PublicRoute.PublicRoute;
        const enabled = yield* publicRoute.enable({
          hostname: HOSTNAME,
          tunnelId: "tunnel-1",
          connectorToken: Redacted.make("connector-token"),
        });

        expect(enabled).toMatchObject({
          state: "connecting",
          hostname: HOSTNAME,
          tunnelId: "tunnel-1",
        });
        expect(fixture.spawned.map((command) => command.options.env?.TUNNEL_TOKEN)).toEqual([
          "connector-token",
        ]);
        expect(fixture.secrets.has(PublicRoute.PUBLIC_ROUTE_SECRET)).toBe(true);
        expect(yield* publicRoute.publicBaseUrl).toBe(`https://${HOSTNAME}/`);

        const disabled = yield* publicRoute.disable();
        expect(disabled).toMatchObject({ state: "off", hostname: null, tunnelId: null });
        expect(fixture.killed).toEqual([901]);
        expect(fixture.secrets.has(PublicRoute.PUBLIC_ROUTE_SECRET)).toBe(false);
        expect(yield* publicRoute.publicBaseUrl).toBeNull();
      }).pipe(Effect.provide(fixture.layer));
    }),
  );

  it.effect("refuses to enable when the managed policy does not allow T3 Connect", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture(undefined, {
        schemaVersion: 1,
        organization: "Acme",
        limits: { connect: false },
      });
      yield* Effect.gen(function* () {
        const publicRoute = yield* PublicRoute.PublicRoute;
        const refused = yield* Effect.flip(
          publicRoute.enable({
            hostname: HOSTNAME,
            tunnelId: "tunnel-1",
            connectorToken: Redacted.make("connector-token"),
          }),
        );
        expect(refused).toMatchObject({
          reason: "managed_by_policy",
          message: "Acme's policy does not allow public routes.",
        });
        expect(fixture.spawned).toEqual([]);
        expect(fixture.secrets.has(PublicRoute.PUBLIC_ROUTE_SECRET)).toBe(false);
      }).pipe(Effect.provide(fixture.layer));
    }),
  );

  it.effect("restores a stored connector and drops it when Cloudflare rejects the tunnel", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture(
        JSON.stringify({
          hostname: HOSTNAME,
          tunnelId: "tunnel-1",
          connectorToken: "stored-token",
        }),
      );
      yield* Effect.gen(function* () {
        const publicRoute = yield* PublicRoute.PublicRoute;
        const restored = yield* publicRoute.status.pipe(
          Stream.filter((status) => status.state === "connecting"),
          Stream.runHead,
        );
        expect(Option.getOrThrow(restored).hostname).toBe(HOSTNAME);
        expect(fixture.spawned.map((command) => command.options.env?.TUNNEL_TOKEN)).toEqual([
          "stored-token",
        ]);

        yield* Queue.offer(fixture.output, new TextEncoder().encode(REJECTED_LINE.repeat(4)));
        const rejected = yield* publicRoute.status.pipe(
          Stream.filter((status) => status.state === "rejected"),
          Stream.runHead,
        );

        expect(Option.getOrThrow(rejected)).toMatchObject({
          hostname: HOSTNAME,
          tunnelId: "tunnel-1",
        });
        expect(fixture.secrets.has(PublicRoute.PUBLIC_ROUTE_SECRET)).toBe(false);
        expect(yield* publicRoute.publicBaseUrl).toBeNull();
      }).pipe(Effect.provide(fixture.layer));
    }),
  );
});
