import type {
  AuthAccessSnapshot,
  AuthAccessStreamEvent,
  AuthAccessStreamSnapshotEvent,
  AuthCreatePairingCredentialInput,
  AuthRevokeClientSessionInput,
  AuthRevokePairingLinkInput,
} from "@t3tools/contracts";
import { WS_METHODS } from "@t3tools/contracts";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { HttpClient } from "effect/http";
import { Atom } from "effect/reactivity";

import * as RemoteEnvironmentAuthorization from "../authorization/service.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import * as ManagedRelay from "../relay/managedRelay.ts";
import { subscribe } from "../rpc/client.ts";
import { executeAuthenticatedEnvironmentHttpRequest } from "./environmentHttpAuth.ts";
import { createEnvironmentCommand, createEnvironmentSubscriptionAtomFamily } from "./runtime.ts";

export const EMPTY_AUTH_ACCESS_SNAPSHOT: AuthAccessSnapshot = {
  pairingLinks: [],
  clientSessions: [],
};

function upsertByKey<A>(
  values: ReadonlyArray<A>,
  next: A,
  key: (value: A) => string,
): ReadonlyArray<A> {
  const nextKey = key(next);
  return [...values.filter((value) => key(value) !== nextKey), next];
}

export function applyAuthAccessStreamEvent(
  current: AuthAccessSnapshot,
  event: AuthAccessStreamEvent,
): AuthAccessSnapshot {
  switch (event.type) {
    case "snapshot":
      return event.payload;
    case "pairingLinkUpserted":
      return {
        ...current,
        pairingLinks: upsertByKey(current.pairingLinks, event.payload, (value) => value.id),
      };
    case "pairingLinkRemoved":
      return {
        ...current,
        pairingLinks: current.pairingLinks.filter((value) => value.id !== event.payload.id),
      };
    case "clientUpserted":
      return {
        ...current,
        clientSessions: upsertByKey(
          current.clientSessions,
          event.payload,
          (value) => value.sessionId,
        ),
      };
    case "clientRemoved":
      return {
        ...current,
        clientSessions: current.clientSessions.filter(
          (value) => value.sessionId !== event.payload.sessionId,
        ),
      };
  }
}

function projectAuthAccessSnapshot(
  current: AuthAccessSnapshot,
  event: AuthAccessStreamEvent,
): readonly [AuthAccessSnapshot, ReadonlyArray<AuthAccessStreamEvent>] {
  const snapshot = applyAuthAccessStreamEvent(current, event);
  const projected: AuthAccessStreamSnapshotEvent = {
    version: 1,
    revision: event.revision,
    type: "snapshot",
    payload: snapshot,
  };
  return [snapshot, [projected]];
}

export class AuthAccessConnectionNotReadyError extends Data.TaggedError(
  "AuthAccessConnectionNotReadyError",
)<{
  readonly message: string;
}> {}

const AUTH_ACCESS_REQUEST_TIMEOUT_MS = 10_000;

type AuthAccessRequest<A, E, R> = Pick<
  Parameters<typeof executeAuthenticatedEnvironmentHttpRequest<"auth", A, E, R>>[0],
  "url" | "request"
>;

/** Run an access-management request against the current environment with its credentials. */
const requestAuthAccess = <A, E, R>(input: AuthAccessRequest<A, E, R>) =>
  Effect.gen(function* () {
    const supervisor = yield* EnvironmentSupervisor.EnvironmentSupervisor;
    const prepared = yield* SubscriptionRef.get(supervisor.prepared);
    const client = yield* Effect.serviceOption(HttpClient.HttpClient);
    if (Option.isNone(prepared) || Option.isNone(client)) {
      return yield* new AuthAccessConnectionNotReadyError({
        message: "The environment connection is not ready.",
      });
    }
    return yield* executeAuthenticatedEnvironmentHttpRequest({
      ...input,
      prepared: prepared.value,
      signer: yield* Effect.serviceOption(ManagedRelay.ManagedRelayDpopSigner),
      remoteAuthorization: yield* Effect.serviceOption(
        RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization,
      ),
      group: "auth",
      method: "POST",
      timeoutMs: AUTH_ACCESS_REQUEST_TIMEOUT_MS,
    }).pipe(Effect.provideService(HttpClient.HttpClient, client.value));
  });

export function createAuthEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    accessChanges: createEnvironmentSubscriptionAtomFamily(runtime, {
      label: "environment-data:server:auth-access-changes",
      subscribe: (_input: null) =>
        subscribe(WS_METHODS.subscribeAuthAccess, {}).pipe(
          Stream.mapAccum(() => EMPTY_AUTH_ACCESS_SNAPSHOT, projectAuthAccessSnapshot),
        ),
    }),
    createPairingLink: createEnvironmentCommand(runtime, {
      label: "environment-data:server:auth-create-pairing-link",
      execute: (input: AuthCreatePairingCredentialInput) =>
        requestAuthAccess({
          url: (urls) => urls.pairingCredential(),
          request: ({ client, headers }) => client.pairingCredential({ headers, payload: input }),
        }),
    }),
    revokePairingLink: createEnvironmentCommand(runtime, {
      label: "environment-data:server:auth-revoke-pairing-link",
      execute: (input: AuthRevokePairingLinkInput) =>
        requestAuthAccess({
          url: (urls) => urls.revokePairingLink(),
          request: ({ client, headers }) => client.revokePairingLink({ headers, payload: input }),
        }),
    }),
    revokeClient: createEnvironmentCommand(runtime, {
      label: "environment-data:server:auth-revoke-client",
      execute: (input: AuthRevokeClientSessionInput) =>
        requestAuthAccess({
          url: (urls) => urls.revokeClient(),
          request: ({ client, headers }) => client.revokeClient({ headers, payload: input }),
        }),
    }),
    revokeOtherClients: createEnvironmentCommand(runtime, {
      label: "environment-data:server:auth-revoke-other-clients",
      execute: (_input: null) =>
        requestAuthAccess({
          url: (urls) => urls.revokeOtherClients(),
          request: ({ client, headers }) => client.revokeOtherClients({ headers }),
        }),
    }),
  };
}
