import {
  PublicRouteError,
  PublicRouteHostname,
  type PublicRouteEnableInput,
  type PublicRouteStatus,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ManagedEndpointRuntime from "../cloud/ManagedEndpointRuntime.ts";
import * as ServerConfig from "../config.ts";
import * as ManagedLimits from "../policy/managedLimits.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import { forkParked } from "../serverActivation.ts";

export const PUBLIC_ROUTE_SECRET = "public-route-connector";

// Picks up a finished background install of cloudflared and a dropped edge connection.
const STATUS_REFRESH_INTERVAL = Duration.seconds(15);
// Cloudflare can refuse a just-created tunnel's connector while its token propagates.
export const NEW_TUNNEL_REJECTION_GRACE = Duration.minutes(2);

const StoredPublicRoute = Schema.Struct({
  hostname: PublicRouteHostname,
  tunnelId: Schema.String,
  connectorToken: Schema.String,
});
type StoredPublicRoute = typeof StoredPublicRoute.Type;
const StoredPublicRouteJson = Schema.fromJsonString(StoredPublicRoute);
const decodeStoredPublicRoute = Schema.decodeUnknownOption(StoredPublicRouteJson);
const encodeStoredPublicRoute = Schema.encodeSync(StoredPublicRouteJson);

export class PublicRoute extends Context.Service<
  PublicRoute,
  {
    readonly enable: (
      input: PublicRouteEnableInput,
    ) => Effect.Effect<PublicRouteStatus, PublicRouteError>;
    readonly disable: () => Effect.Effect<PublicRouteStatus, PublicRouteError>;
    readonly getStatus: Effect.Effect<PublicRouteStatus>;
    readonly status: Stream.Stream<PublicRouteStatus>;
    /** The HTTPS base URL clients can learn, while a route is configured. */
    readonly publicBaseUrl: Effect.Effect<string | null>;
  }
>()("t3/publicRoute/PublicRoute") {}

const storageError = (message: string) => (cause: unknown) =>
  new PublicRouteError({ reason: "storage", message, cause });

/** @public */
export const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const secretStore = yield* ServerSecretStore.ServerSecretStore;
  // A runtime of its own: T3 Connect's instance is reset by relinks and reports to the relay.
  const runtime = yield* ManagedEndpointRuntime.make;
  // A route exposes the host to the internet as T3 Connect does, and the runtime refuses both alike.
  const policy = yield* ManagedPolicy.ManagedPolicy;
  const allowedByPolicy = ManagedLimits.allowsConnect(policy);
  const policyRefusal = new ManagedLimits.ManagedPolicyRefusedError({
    organization: policy.document?.organization ?? "Your organization",
    action: "public routes",
  }).message;
  const routeRef = yield* Ref.make<StoredPublicRoute | null>(null);
  const lastApplyRef =
    yield* Ref.make<ManagedEndpointRuntime.CloudManagedEndpointRuntimeStatus | null>(null);
  const offStatus = (
    detail: Pick<PublicRouteStatus, "state" | "hostname" | "tunnelId" | "detail"> = {
      state: "off",
      hostname: null,
      tunnelId: null,
      detail: null,
    },
  ): PublicRouteStatus => ({ ...detail, originPort: config.port });
  const statusRef = yield* SubscriptionRef.make<PublicRouteStatus>(offStatus());
  const mutations = yield* Semaphore.make(1);
  const rejectionGraceUntilRef = yield* Ref.make(0);

  const computeStatus = Effect.gen(function* () {
    const route = yield* Ref.get(routeRef);
    if (route === null) {
      const current = yield* SubscriptionRef.get(statusRef);
      return current.state === "rejected" ? current : offStatus();
    }
    const base = { hostname: route.hostname, tunnelId: route.tunnelId, originPort: config.port };
    if (!allowedByPolicy) {
      return { ...base, state: "failed", detail: policyRefusal } satisfies PublicRouteStatus;
    }
    const facts = yield* runtime.inspectConnector;
    if (facts !== null) {
      return {
        ...base,
        state: (facts.readyConnections ?? 0) > 0 ? "live" : "connecting",
        detail: null,
      } satisfies PublicRouteStatus;
    }
    const lastApply = yield* Ref.get(lastApplyRef);
    if (lastApply?.status === "failed") {
      return {
        ...base,
        state: lastApply.failure === "not-installed" ? "cloudflared-missing" : "failed",
        detail: lastApply.reason,
      } satisfies PublicRouteStatus;
    }
    return { ...base, state: "connecting", detail: null } satisfies PublicRouteStatus;
  });

  const refresh = Effect.gen(function* () {
    const next = yield* computeStatus;
    const current = yield* SubscriptionRef.get(statusRef);
    if (
      next.state !== current.state ||
      next.hostname !== current.hostname ||
      next.tunnelId !== current.tunnelId ||
      next.detail !== current.detail
    ) {
      yield* SubscriptionRef.set(statusRef, next);
    }
  });

  const startConnector = (route: StoredPublicRoute) =>
    runtime
      .applyConfig({
        providerKind: "cloudflare_tunnel",
        connectorToken: route.connectorToken,
        tunnelId: route.tunnelId,
      })
      .pipe(Effect.flatMap((applied) => Ref.set(lastApplyRef, applied)));

  const stopConnector = runtime
    .applyConfig(null)
    .pipe(Effect.flatMap((applied) => Ref.set(lastApplyRef, applied)));

  const enable = Effect.fn("PublicRoute.enable")(function* (input: PublicRouteEnableInput) {
    if (!allowedByPolicy) {
      return yield* new PublicRouteError({ reason: "managed_by_policy", message: policyRefusal });
    }
    const route: StoredPublicRoute = {
      hostname: input.hostname,
      tunnelId: input.tunnelId,
      connectorToken: Redacted.value(input.connectorToken),
    };
    return yield* mutations.withPermits(1)(
      Effect.gen(function* () {
        yield* secretStore
          .set(PUBLIC_ROUTE_SECRET, new TextEncoder().encode(encodeStoredPublicRoute(route)))
          .pipe(Effect.mapError(storageError("Could not store the tunnel connector.")));
        yield* Ref.set(routeRef, route);
        yield* Ref.set(
          rejectionGraceUntilRef,
          (yield* Clock.currentTimeMillis) + Duration.toMillis(NEW_TUNNEL_REJECTION_GRACE),
        );
        yield* startConnector(route);
        yield* refresh;
        yield* Effect.logInfo("public route enabled", {
          hostname: route.hostname,
          tunnelId: route.tunnelId,
        });
        return yield* SubscriptionRef.get(statusRef);
      }),
    );
  });

  const clearRoute = Effect.gen(function* () {
    yield* stopConnector;
    yield* Ref.set(routeRef, null);
    yield* secretStore
      .remove(PUBLIC_ROUTE_SECRET)
      .pipe(Effect.mapError(storageError("Could not delete the stored tunnel connector.")));
  });

  const disable = Effect.fn("PublicRoute.disable")(function* () {
    return yield* mutations.withPermits(1)(
      Effect.gen(function* () {
        yield* clearRoute;
        yield* SubscriptionRef.set(statusRef, offStatus());
        yield* Effect.logInfo("public route disabled");
        return offStatus();
      }),
    );
  });

  // The desktop deletes the tunnel when it cannot reach this host, so a rejection means the route is gone.
  const dropRejectedRoute = (rejected: { readonly tunnelId?: string | undefined }) =>
    mutations.withPermits(1)(
      Effect.gen(function* () {
        const route = yield* Ref.get(routeRef);
        if (route === null || route.tunnelId !== rejected.tunnelId) return;
        if ((yield* Clock.currentTimeMillis) < (yield* Ref.get(rejectionGraceUntilRef))) {
          yield* SubscriptionRef.set(statusRef, {
            state: "connecting",
            hostname: route.hostname,
            tunnelId: route.tunnelId,
            originPort: config.port,
            detail: "Cloudflare has not accepted the new tunnel yet.",
          });
          return;
        }
        yield* clearRoute.pipe(
          Effect.catch((error) =>
            Effect.logWarning("could not clear a rejected public route", { cause: error }),
          ),
        );
        yield* SubscriptionRef.set(
          statusRef,
          offStatus({
            state: "rejected",
            hostname: route.hostname,
            tunnelId: route.tunnelId,
            detail: "Cloudflare rejected the tunnel connector, so this host stopped it.",
          }),
        );
        yield* Effect.logWarning("public route rejected by Cloudflare; connector removed", {
          hostname: route.hostname,
          tunnelId: route.tunnelId,
        });
      }),
    );

  yield* forkParked(
    Effect.gen(function* () {
      const stored = yield* secretStore.get(PUBLIC_ROUTE_SECRET).pipe(
        Effect.map(
          Option.flatMap((bytes) => decodeStoredPublicRoute(new TextDecoder().decode(bytes))),
        ),
        Effect.orElseSucceed(() => Option.none<StoredPublicRoute>()),
      );
      if (Option.isSome(stored)) {
        yield* mutations.withPermits(1)(
          Ref.set(routeRef, stored.value).pipe(
            Effect.andThen(startConnector(stored.value)),
            Effect.andThen(refresh),
          ),
        );
      }
      yield* Effect.all(
        [
          runtime.tunnelRejected.pipe(Stream.runForEach(dropRejectedRoute)),
          Stream.merge(runtime.readinessChanged, Stream.tick(STATUS_REFRESH_INTERVAL)).pipe(
            Stream.runForEach(() => mutations.withPermits(1)(refresh)),
          ),
        ],
        { concurrency: "unbounded", discard: true },
      );
    }),
  );

  return PublicRoute.of({
    enable,
    disable,
    getStatus: SubscriptionRef.get(statusRef),
    status: SubscriptionRef.changes(statusRef),
    publicBaseUrl: Ref.get(routeRef).pipe(
      Effect.map((route) => (route === null ? null : `https://${route.hostname}/`)),
    ),
  });
});

export const layer = Layer.effect(PublicRoute, make);
