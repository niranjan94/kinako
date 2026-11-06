import { AuthSessionId, EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { Atom, AtomRegistry } from "effect/reactivity";

import * as ConnectionOnboarding from "../connection/onboarding.ts";
import {
  AVAILABLE_CONNECTION_STATE,
  BearerConnectionTarget,
  ConnectionBlockedError,
  type PreparedConnection,
  type SupervisorConnectionState,
} from "../connection/model.ts";
import * as EnvironmentRegistry from "../connection/registry.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import * as RpcHttp from "../rpc/http.ts";
import type { RpcSession } from "../rpc/session.ts";
import {
  addRouteOverConnection,
  applyAuthAccessStreamEvent,
  createAuthEnvironmentAtoms,
  EMPTY_AUTH_ACCESS_SNAPSHOT,
} from "./auth.ts";
import { runAtomCommand, squashAtomCommandFailure } from "./runtime.ts";

describe("applyAuthAccessStreamEvent", () => {
  it("accumulates rapid pairing-link and client updates into one snapshot", () => {
    const pairingLink = {
      id: "pairing-link",
      scopes: ["orchestration:read"],
      subject: "subject",
      label: "Phone",
      createdAt: DateTime.makeUnsafe("2036-04-07T00:00:00.000Z"),
      expiresAt: DateTime.makeUnsafe("2036-04-07T00:05:00.000Z"),
    } as const;
    const clientSession = {
      sessionId: AuthSessionId.make("session-client"),
      subject: "subject",
      scopes: ["orchestration:read"],
      method: "browser-session-cookie",
      client: {
        label: "Phone",
        deviceType: "mobile",
      },
      issuedAt: DateTime.makeUnsafe("2036-04-07T00:00:00.000Z"),
      expiresAt: DateTime.makeUnsafe("2036-05-07T00:00:00.000Z"),
      lastConnectedAt: null,
      connected: true,
      current: false,
    } as const;

    const withPairingLink = applyAuthAccessStreamEvent(EMPTY_AUTH_ACCESS_SNAPSHOT, {
      version: 1,
      revision: 1,
      type: "pairingLinkUpserted",
      payload: pairingLink,
    });
    const withClient = applyAuthAccessStreamEvent(withPairingLink, {
      version: 1,
      revision: 2,
      type: "clientUpserted",
      payload: clientSession,
    });

    expect(withClient).toEqual({
      pairingLinks: [pairingLink],
      clientSessions: [clientSession],
    });
  });

  it("applies removals without disturbing unrelated access state", () => {
    const snapshot = applyAuthAccessStreamEvent(
      {
        pairingLinks: [
          {
            id: "pairing-link",
            scopes: ["orchestration:read"],
            subject: "subject",
            label: "Phone",
            createdAt: DateTime.makeUnsafe("2036-04-07T00:00:00.000Z"),
            expiresAt: DateTime.makeUnsafe("2036-04-07T00:05:00.000Z"),
          },
        ],
        clientSessions: [],
      },
      {
        version: 1,
        revision: 2,
        type: "pairingLinkRemoved",
        payload: { id: "pairing-link" },
      },
    );

    expect(snapshot).toEqual(EMPTY_AUTH_ACCESS_SNAPSHOT);
  });
});

const REMOTE_ID = EnvironmentId.make("remote");
const LOCAL_ID = EnvironmentId.make("local");

const preparedBearerConnection = (environmentId: EnvironmentId): PreparedConnection => {
  const target = new BearerConnectionTarget({
    environmentId,
    label: environmentId,
    connectionId: `${environmentId}-connection`,
  });
  return {
    environmentId,
    label: environmentId,
    httpBaseUrl: `https://${environmentId}.test`,
    socketUrl: `wss://${environmentId}.test/ws`,
    httpAuthorization: { _tag: "Bearer", token: `${environmentId}-token` },
    target,
  };
};

const makeAccessHarness = Effect.fn(function* (options: { readonly remotePrepared: boolean }) {
  const calls: Array<{ readonly url: string; readonly init: RequestInit }> = [];
  const fetchFn: typeof fetch = async (request, init) => {
    calls.push({ url: String(request), init: init ?? {} });
    if (String(request).endsWith("/revoke")) return Response.json({ revoked: true });
    return Response.json({
      id: "pairing-link-1",
      credential: "pairing-token",
      label: "Phone",
      expiresAt: "2036-04-07T00:05:00.000Z",
    });
  };
  const supervisors = new Map<
    EnvironmentId,
    EnvironmentSupervisor.EnvironmentSupervisor["Service"]
  >();
  for (const environmentId of [REMOTE_ID, LOCAL_ID]) {
    const prepared = preparedBearerConnection(environmentId);
    supervisors.set(
      environmentId,
      EnvironmentSupervisor.EnvironmentSupervisor.of({
        target: prepared.target,
        state: yield* SubscriptionRef.make<SupervisorConnectionState>({
          ...AVAILABLE_CONNECTION_STATE,
          phase: "connected" as const,
        }),
        session: yield* SubscriptionRef.make(Option.none<RpcSession>()),
        prepared: yield* SubscriptionRef.make(
          environmentId === REMOTE_ID && !options.remotePrepared
            ? Option.none<PreparedConnection>()
            : Option.some(prepared),
        ),
        connect: Effect.void,
        disconnect: Effect.void,
        retryNow: Effect.void,
      }),
    );
  }
  const environments = EnvironmentRegistry.EnvironmentRegistry.of({
    run: (id, effect) =>
      Effect.provideService(
        effect,
        EnvironmentSupervisor.EnvironmentSupervisor,
        supervisors.get(id)!,
      ),
    followStream: (id, stream) =>
      Stream.provideService(
        stream,
        EnvironmentSupervisor.EnvironmentSupervisor,
        supervisors.get(id)!,
      ),
  } as EnvironmentRegistry.EnvironmentRegistry["Service"]);
  const registry = AtomRegistry.make();
  yield* Effect.addFinalizer(() => Effect.sync(() => registry.dispose()));
  const layer = Layer.merge(
    Layer.succeed(EnvironmentRegistry.EnvironmentRegistry, environments),
    RpcHttp.layerRemoteHttpClient(fetchFn),
  );
  const auth = createAuthEnvironmentAtoms(Atom.runtime(layer));
  return { auth, calls, layer, registry };
});

describe("auth access commands", () => {
  it.effect("creates a pairing link on the commanded environment with its credential", () =>
    Effect.gen(function* () {
      const { auth, calls, registry } = yield* makeAccessHarness({ remotePrepared: true });

      const result = yield* Effect.promise(() =>
        runAtomCommand(registry, auth.createPairingCredential, {
          environmentId: REMOTE_ID,
          input: { label: "Phone", scopes: ["orchestration:read"] },
        }),
      );

      expect(result._tag).toBe("Success");
      expect(result._tag === "Success" && result.value.credential).toBe("pairing-token");
      expect(calls).toHaveLength(1);
      expect(calls[0]!.url).toBe("https://remote.test/api/auth/pairing-token");
      expect(new Headers(calls[0]!.init.headers).get("authorization")).toBe("Bearer remote-token");
    }).pipe(Effect.scoped),
  );

  it.effect("fails without a request while the environment connection is not ready", () =>
    Effect.gen(function* () {
      const { auth, calls, registry } = yield* makeAccessHarness({ remotePrepared: false });

      const result = yield* Effect.promise(() =>
        runAtomCommand(
          registry,
          auth.revokeOtherClients,
          { environmentId: REMOTE_ID, input: null },
          { reportFailure: false },
        ),
      );

      expect(result._tag).toBe("Failure");
      expect(result._tag === "Failure" && squashAtomCommandFailure(result)).toBeInstanceOf(
        RpcHttp.RemoteEnvironmentAuthFetchError,
      );
      expect(calls).toEqual([]);
    }).pipe(Effect.scoped),
  );

  it.effect(
    "pairs a new route with a code minted over the connection, revoking it on failure",
    () =>
      Effect.gen(function* () {
        const { calls, layer } = yield* makeAccessHarness({ remotePrepared: true });
        const pairings: Array<ConnectionOnboarding.PairingConnectionInput> = [];
        const onboarding = ConnectionOnboarding.ConnectionOnboarding.of({
          registerPairing: (input) => {
            pairings.push(input);
            return Effect.fail(
              new ConnectionBlockedError({ reason: "configuration", detail: "unreachable" }),
            );
          },
          registerSsh: () => Effect.die("unused"),
          updateBearer: () => Effect.die("unused"),
        });

        const exit = yield* addRouteOverConnection({
          environmentId: REMOTE_ID,
          host: "10.0.0.5:3873",
          grantedScopes: ["orchestration:read", "review:write"],
        }).pipe(
          Effect.provide(layer),
          Effect.provideService(ConnectionOnboarding.ConnectionOnboarding, onboarding),
          Effect.exit,
        );

        expect(exit._tag).toBe("Failure");
        expect(pairings).toEqual([
          { host: "10.0.0.5:3873", pairingCode: "pairing-token", expectedEnvironmentId: REMOTE_ID },
        ]);
        expect(calls.map((call) => call.url)).toEqual([
          "https://remote.test/api/auth/pairing-token",
          "https://remote.test/api/auth/pairing-links/revoke",
        ]);
        expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
          label: "Route",
          scopes: ["orchestration:read"],
        });
        expect(JSON.parse(String(calls[1]!.init.body))).toEqual({ id: "pairing-link-1" });
      }).pipe(Effect.scoped),
  );
});
