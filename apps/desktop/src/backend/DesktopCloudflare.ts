import {
  DesktopCloudflareZoneSchema,
  type DesktopCloudflareProvisionedRoute,
  type DesktopCloudflareProvisionInput,
  type DesktopCloudflareState,
  type DesktopCloudflareTunnel,
  type DesktopCloudflareVerifyInput,
  type DesktopCloudflareZone,
  type EnvironmentId,
  PublicRouteHostname,
} from "@t3tools/contracts";
import {
  makePublicRouteHostname,
  PUBLIC_ROUTE_TUNNEL_PREFIX,
  publicRouteTunnelName,
} from "@t3tools/shared/cloudflarePublicRoute";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Base64 from "effect/encoding/Base64";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as ElectronSafeStorage from "../electron/ElectronSafeStorage.ts";

const API_BASE = "https://api.cloudflare.com/client/v4";
const REQUEST_TIMEOUT = Duration.seconds(20);
const VERIFY_TIMEOUT = Duration.seconds(10);
// Long enough for clients to learn the new hostname from the host before the old one stops answering.
const ROTATION_GRACE = Duration.minutes(10);
const CLEANUP_INTERVAL = Duration.minutes(1);

export class DesktopCloudflareError extends Schema.TaggedError<DesktopCloudflareError>()(
  "DesktopCloudflareError",
  {
    message: Schema.String,
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {}

const fail = (message: string) => (cause?: unknown) =>
  new DesktopCloudflareError({ message, ...(cause === undefined ? {} : { cause }) });

const PendingCleanup = Schema.Struct({
  accountId: Schema.String,
  zoneId: Schema.String,
  tunnelId: Schema.String,
  hostname: Schema.String,
  deleteAfterMillis: Schema.Number,
});
type PendingCleanup = typeof PendingCleanup.Type;

const StoredAccount = Schema.Struct({
  token: Schema.String,
  zone: Schema.NullOr(DesktopCloudflareZoneSchema),
  pendingCleanups: Schema.Array(PendingCleanup),
});
type StoredAccount = typeof StoredAccount.Type;
const StoredAccountJson = Schema.fromJsonString(StoredAccount);
const StoredDocumentJson = Schema.fromJsonString(
  Schema.Struct({ version: Schema.Literal(1), encryptedAccount: Schema.String }),
);
const decodeStoredAccount = Schema.decodeEffect(StoredAccountJson);
const encodeStoredAccount = Schema.encodeEffect(StoredAccountJson);
const decodeStoredDocument = Schema.decodeEffect(StoredDocumentJson);
const encodeStoredDocument = Schema.encodeEffect(StoredDocumentJson);

const ApiEnvelope = Schema.Struct({
  success: Schema.Boolean,
  errors: Schema.Array(Schema.Struct({ code: Schema.Number, message: Schema.String })),
  result: Schema.Unknown,
});
const ZoneResult = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  account: Schema.Struct({ id: Schema.String, name: Schema.String }),
});
const TunnelResult = Schema.Struct({ id: Schema.String, name: Schema.String });
const IngressRule = Schema.Struct({
  hostname: Schema.optional(Schema.String),
  service: Schema.String,
});
type IngressRule = typeof IngressRule.Type;
const TunnelConfigurationResult = Schema.Struct({
  config: Schema.optional(
    Schema.NullOr(
      Schema.Struct({ ingress: Schema.optional(Schema.NullOr(Schema.Array(IngressRule))) }),
    ),
  ),
});
const DnsRecordResult = Schema.Struct({ id: Schema.String, content: Schema.String });
const DescriptorResult = Schema.Struct({ environmentId: Schema.String });

const isPublicRouteHostname = Schema.is(PublicRouteHostname);
const tunnelTarget = (tunnelId: string) => `${tunnelId}.cfargotunnel.com`;
const NOT_FOUND = "http_status:404";

export class DesktopCloudflare extends Context.Service<
  DesktopCloudflare,
  {
    readonly getState: Effect.Effect<DesktopCloudflareState, DesktopCloudflareError>;
    readonly connect: (
      token: string,
    ) => Effect.Effect<ReadonlyArray<DesktopCloudflareZone>, DesktopCloudflareError>;
    readonly listZones: Effect.Effect<ReadonlyArray<DesktopCloudflareZone>, DesktopCloudflareError>;
    readonly selectZone: (
      zoneId: string,
    ) => Effect.Effect<DesktopCloudflareState, DesktopCloudflareError>;
    readonly disconnect: Effect.Effect<DesktopCloudflareState, DesktopCloudflareError>;
    readonly provision: (
      input: DesktopCloudflareProvisionInput,
    ) => Effect.Effect<DesktopCloudflareProvisionedRoute, DesktopCloudflareError>;
    readonly rotate: (
      input: DesktopCloudflareProvisionInput,
    ) => Effect.Effect<DesktopCloudflareProvisionedRoute, DesktopCloudflareError>;
    readonly remove: (environmentId: EnvironmentId) => Effect.Effect<void, DesktopCloudflareError>;
    readonly removeTunnel: (tunnelId: string) => Effect.Effect<void, DesktopCloudflareError>;
    readonly listTunnels: Effect.Effect<
      ReadonlyArray<DesktopCloudflareTunnel>,
      DesktopCloudflareError
    >;
    readonly verify: (input: DesktopCloudflareVerifyInput) => Effect.Effect<boolean>;
  }
>()("@t3tools/desktop/backend/DesktopCloudflare") {}

/** @public */
export const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const safeStorage = yield* ElectronSafeStorage.ElectronSafeStorage;
  const httpClient = yield* HttpClient.HttpClient;
  const crypto = yield* Crypto.Crypto;
  const storePath = path.join(environment.stateDir, "cloudflare.json");
  const lock = yield* Semaphore.make(1);

  const encryptionAvailable = safeStorage.isEncryptionAvailable.pipe(
    Effect.orElseSucceed(() => false),
  );

  const readAccount = Effect.gen(function* () {
    const exists = yield* fileSystem
      .exists(storePath)
      .pipe(Effect.mapError(fail("Could not read the stored Cloudflare account.")));
    if (!exists) return null;
    const document = yield* fileSystem
      .readFileString(storePath)
      .pipe(
        Effect.flatMap(decodeStoredDocument),
        Effect.mapError(fail("The stored Cloudflare account could not be read.")),
      );
    const encrypted = yield* Effect.fromResult(Base64.decode(document.encryptedAccount)).pipe(
      Effect.mapError(fail("The stored Cloudflare account could not be read.")),
    );
    return yield* safeStorage
      .decryptString(encrypted)
      .pipe(
        Effect.flatMap(decodeStoredAccount),
        Effect.mapError(fail("The stored Cloudflare account could not be decrypted.")),
      );
  });

  const writeAccount = Effect.fn("DesktopCloudflare.writeAccount")(function* (
    account: StoredAccount | null,
  ) {
    if (account === null) {
      return yield* fileSystem
        .remove(storePath, { force: true })
        .pipe(Effect.mapError(fail("Could not delete the stored Cloudflare account.")));
    }
    if (!(yield* encryptionAvailable)) {
      return yield* fail(
        "This system has no secure storage, so the Cloudflare token cannot be saved.",
      )();
    }
    const encryptedAccount = Base64.encode(
      yield* encodeStoredAccount(account).pipe(
        Effect.flatMap(safeStorage.encryptString),
        Effect.mapError(fail("Could not encrypt the Cloudflare token.")),
      ),
    );
    const document = yield* encodeStoredDocument({
      version: 1,
      encryptedAccount,
    }).pipe(Effect.mapError(fail("Could not save the Cloudflare account.")));
    const tempPath = `${storePath}.${process.pid}.tmp`;
    yield* fileSystem
      .makeDirectory(environment.stateDir, { recursive: true })
      .pipe(
        Effect.andThen(fileSystem.writeFileString(tempPath, `${document}\n`)),
        Effect.andThen(fileSystem.rename(tempPath, storePath)),
        Effect.ensuring(fileSystem.remove(tempPath, { force: true }).pipe(Effect.ignore)),
        Effect.mapError(fail("Could not save the Cloudflare account.")),
      );
  });

  const api = Effect.fn("DesktopCloudflare.api")(function* <A>(
    token: string,
    method: "GET" | "POST" | "PUT" | "DELETE",
    route: string,
    schema: Schema.Decoder<A>,
    body?: unknown,
  ) {
    let request = HttpClientRequest.make(method)(`${API_BASE}${route}`).pipe(
      HttpClientRequest.bearerToken(token),
      HttpClientRequest.acceptJson,
    );
    if (body !== undefined) {
      request = yield* HttpClientRequest.bodyJson(request, body).pipe(
        Effect.mapError(fail("Could not encode a Cloudflare request.")),
      );
    }
    const envelope = yield* httpClient
      .execute(request)
      .pipe(
        Effect.flatMap(HttpClientResponse.schemaBodyJson(ApiEnvelope)),
        Effect.timeout(REQUEST_TIMEOUT),
        Effect.mapError(fail("Cloudflare could not be reached.")),
      );
    if (!envelope.success) {
      const detail = envelope.errors.map((error) => error.message).join("; ");
      const authorization = envelope.errors.some((error) =>
        [9109, 10000, 10001].includes(error.code),
      );
      return yield* fail(
        authorization
          ? `Cloudflare refused the token: ${detail}. Check that it has the permissions listed in Settings.`
          : `Cloudflare: ${detail || "the request failed."}`,
      )();
    }
    return yield* Schema.decodeUnknownEffect(schema)(envelope.result).pipe(
      Effect.mapError(fail("Cloudflare sent an unexpected response.")),
    );
  });

  const fetchZones = (token: string) =>
    api(token, "GET", "/zones?status=active&per_page=50", Schema.Array(ZoneResult)).pipe(
      Effect.map((zones) =>
        zones.map((zone) => ({
          id: zone.id,
          name: zone.name,
          accountId: zone.account.id,
          accountName: zone.account.name,
        })),
      ),
    );

  const requireAccount = Effect.gen(function* () {
    const account = yield* readAccount;
    if (account === null) return yield* fail("Connect a Cloudflare account first.")();
    return account;
  });

  const requireZone = Effect.gen(function* () {
    const account = yield* requireAccount;
    if (account.zone === null) return yield* fail("Choose a Cloudflare domain first.")();
    return { account, zone: account.zone };
  });

  const findTunnel = (token: string, accountId: string, name: string) =>
    api(
      token,
      "GET",
      `/accounts/${accountId}/cfd_tunnel?is_deleted=false&name=${encodeURIComponent(name)}`,
      Schema.Array(TunnelResult),
    ).pipe(Effect.map((tunnels) => tunnels.find((tunnel) => tunnel.name === name) ?? null));

  const readIngress = (token: string, accountId: string, tunnelId: string) =>
    api(
      token,
      "GET",
      `/accounts/${accountId}/cfd_tunnel/${tunnelId}/configurations`,
      TunnelConfigurationResult,
    ).pipe(
      Effect.map((result) =>
        (result.config?.ingress ?? []).filter((rule) => rule.hostname !== undefined),
      ),
    );

  const writeIngress = (
    token: string,
    accountId: string,
    tunnelId: string,
    rules: ReadonlyArray<IngressRule>,
  ) =>
    api(
      token,
      "PUT",
      `/accounts/${accountId}/cfd_tunnel/${tunnelId}/configurations`,
      Schema.Unknown,
      { config: { ingress: [...rules, { service: NOT_FOUND }] } },
    );

  const dnsRecordsFor = (token: string, zoneId: string, hostname: string, tunnelId: string) =>
    api(
      token,
      "GET",
      `/zones/${zoneId}/dns_records?type=CNAME&name=${encodeURIComponent(hostname)}`,
      Schema.Array(DnsRecordResult),
    ).pipe(
      Effect.map((records) =>
        records.filter((record) => record.content === tunnelTarget(tunnelId)),
      ),
    );

  const ensureDnsRecord = Effect.fn("DesktopCloudflare.ensureDnsRecord")(function* (
    token: string,
    zoneId: string,
    hostname: string,
    tunnelId: string,
  ) {
    if ((yield* dnsRecordsFor(token, zoneId, hostname, tunnelId)).length > 0) return;
    yield* api(token, "POST", `/zones/${zoneId}/dns_records`, Schema.Unknown, {
      type: "CNAME",
      name: hostname,
      content: tunnelTarget(tunnelId),
      proxied: true,
      ttl: 1,
    });
  });

  const deleteDnsRecords = Effect.fn("DesktopCloudflare.deleteDnsRecords")(function* (
    token: string,
    zoneId: string,
    hostname: string,
    tunnelId: string,
  ) {
    for (const record of yield* dnsRecordsFor(token, zoneId, hostname, tunnelId)) {
      yield* api(token, "DELETE", `/zones/${zoneId}/dns_records/${record.id}`, Schema.Unknown);
    }
  });

  const connectorToken = (token: string, accountId: string, tunnelId: string) =>
    api(token, "GET", `/accounts/${accountId}/cfd_tunnel/${tunnelId}/token`, Schema.String);

  const newHostname = (zone: DesktopCloudflareZone) =>
    crypto.randomBytes(16).pipe(
      Effect.map((bytes) => makePublicRouteHostname(zone.name, bytes)),
      Effect.mapError(fail("Could not generate a hostname.")),
      Effect.filterOrFail(isPublicRouteHostname, () =>
        fail(`${zone.name} cannot hold a public route hostname.`)(),
      ),
    );

  // Universal SSL covers one label under the zone only.
  const isRouteHostname = (hostname: string, zone: DesktopCloudflareZone) =>
    hostname.startsWith("kn-") &&
    hostname.endsWith(`.${zone.name}`) &&
    !hostname.slice(0, -zone.name.length - 1).includes(".");

  const pendingHostnames = (account: StoredAccount, tunnelId: string) =>
    account.pendingCleanups.filter((entry) => entry.tunnelId === tunnelId).map((e) => e.hostname);

  const provisionLocked = Effect.fn("DesktopCloudflare.provisionLocked")(function* (
    input: DesktopCloudflareProvisionInput,
    rotate: boolean,
  ) {
    const { account, zone } = yield* requireZone;
    const { token } = account;
    const name = publicRouteTunnelName(input.environmentId);
    const existingTunnel = yield* findTunnel(token, zone.accountId, name);
    if (rotate && existingTunnel === null) {
      return yield* fail("This environment has no public route to rotate.")();
    }
    const tunnel =
      existingTunnel ??
      (yield* api(token, "POST", `/accounts/${zone.accountId}/cfd_tunnel`, TunnelResult, {
        name,
        config_src: "cloudflare",
      }));
    const retiring = pendingHostnames(account, tunnel.id);
    const current = (yield* readIngress(token, zone.accountId, tunnel.id))
      .map((rule) => rule.hostname ?? "")
      .find((hostname) => isRouteHostname(hostname, zone) && !retiring.includes(hostname));
    const hostname = rotate || current === undefined ? yield* newHostname(zone) : current;
    const service = `http://127.0.0.1:${input.originPort}`;
    const nextRetiring = rotate && current !== undefined ? [...retiring, current] : retiring;
    yield* ensureDnsRecord(token, zone.id, hostname, tunnel.id);
    yield* writeIngress(
      token,
      zone.accountId,
      tunnel.id,
      [hostname, ...nextRetiring].map((routeHostname) => ({ hostname: routeHostname, service })),
    );
    if (rotate && current !== undefined) {
      const now = yield* Clock.currentTimeMillis;
      yield* writeAccount({
        ...account,
        pendingCleanups: [
          ...account.pendingCleanups,
          {
            accountId: zone.accountId,
            zoneId: zone.id,
            tunnelId: tunnel.id,
            hostname: current,
            deleteAfterMillis: now + Duration.toMillis(ROTATION_GRACE),
          },
        ],
      });
    }
    return {
      hostname,
      tunnelId: tunnel.id,
      connectorToken: yield* connectorToken(token, zone.accountId, tunnel.id),
    } satisfies DesktopCloudflareProvisionedRoute;
  });

  const deleteTunnel = Effect.fn("DesktopCloudflare.deleteTunnel")(function* (
    account: StoredAccount,
    zone: DesktopCloudflareZone,
    tunnelId: string,
  ) {
    const { token } = account;
    const rules = yield* readIngress(token, zone.accountId, tunnelId).pipe(
      Effect.orElseSucceed(() => []),
    );
    const hostnames = new Set([
      ...rules.flatMap((rule) => (rule.hostname ? [rule.hostname] : [])),
      ...pendingHostnames(account, tunnelId),
    ]);
    for (const hostname of hostnames) {
      yield* deleteDnsRecords(token, zone.id, hostname, tunnelId);
    }
    // Deleting a tunnel with live connectors fails; dropping them closes it at the edge.
    yield* api(
      token,
      "DELETE",
      `/accounts/${zone.accountId}/cfd_tunnel/${tunnelId}/connections`,
      Schema.Unknown,
    );
    yield* api(
      token,
      "DELETE",
      `/accounts/${zone.accountId}/cfd_tunnel/${tunnelId}`,
      Schema.Unknown,
    );
    yield* writeAccount({
      ...account,
      pendingCleanups: account.pendingCleanups.filter((entry) => entry.tunnelId !== tunnelId),
    });
  });

  const runDueCleanups = Effect.gen(function* () {
    const account = yield* readAccount;
    if (account === null || account.pendingCleanups.length === 0) return;
    const now = yield* Clock.currentTimeMillis;
    const due = account.pendingCleanups.filter((entry) => entry.deleteAfterMillis <= now);
    const finished: Array<PendingCleanup> = [];
    for (const entry of due) {
      const done = yield* Effect.gen(function* () {
        const rules = yield* readIngress(account.token, entry.accountId, entry.tunnelId);
        yield* writeIngress(
          account.token,
          entry.accountId,
          entry.tunnelId,
          rules.filter((rule) => rule.hostname !== entry.hostname),
        );
        yield* deleteDnsRecords(account.token, entry.zoneId, entry.hostname, entry.tunnelId);
        return true;
      }).pipe(
        Effect.catch((error) =>
          Effect.logWarning("could not retire a rotated public route hostname", {
            hostname: entry.hostname,
            error,
          }).pipe(Effect.as(false)),
        ),
      );
      if (done) finished.push(entry);
    }
    if (finished.length > 0) {
      yield* writeAccount({
        ...account,
        pendingCleanups: account.pendingCleanups.filter((entry) => !finished.includes(entry)),
      });
    }
  });

  yield* lock
    .withPermits(1)(runDueCleanups)
    .pipe(
      Effect.catch((error) => Effect.logWarning("public route cleanup failed", { error })),
      Effect.repeat(Schedule.spaced(CLEANUP_INTERVAL)),
      Effect.forkScoped,
    );

  const getState = Effect.gen(function* () {
    const account = yield* readAccount.pipe(Effect.orElseSucceed(() => null));
    return {
      encryptionAvailable: yield* encryptionAvailable,
      connected: account !== null,
      zone: account?.zone ?? null,
    } satisfies DesktopCloudflareState;
  });

  const locked = lock.withPermits(1);

  const connect = Effect.fn("DesktopCloudflare.connect")(function* (token: string) {
    const trimmed = token.trim();
    if (trimmed.length === 0) return yield* fail("Paste a Cloudflare API token.")();
    const zones = yield* fetchZones(trimmed);
    if (zones.length === 0) {
      return yield* fail(
        "This token cannot see any active domain. Give it Zone · Zone · Read on the domain to use.",
      )();
    }
    yield* writeAccount({
      token: trimmed,
      zone: zones.length === 1 ? zones[0]! : null,
      pendingCleanups: [],
    });
    return zones;
  }, locked);

  const selectZone = Effect.fn("DesktopCloudflare.selectZone")(function* (zoneId: string) {
    const account = yield* requireAccount;
    const zone = (yield* fetchZones(account.token)).find((entry) => entry.id === zoneId);
    if (zone === undefined) return yield* fail("That domain is not available to the token.")();
    yield* writeAccount({ ...account, zone });
    return yield* getState;
  }, locked);

  const provision = Effect.fn("DesktopCloudflare.provision")(function* (
    input: DesktopCloudflareProvisionInput,
  ) {
    return yield* provisionLocked(input, false);
  }, locked);

  const rotate = Effect.fn("DesktopCloudflare.rotate")(function* (
    input: DesktopCloudflareProvisionInput,
  ) {
    return yield* provisionLocked(input, true);
  }, locked);

  const remove = Effect.fn("DesktopCloudflare.remove")(function* (environmentId: EnvironmentId) {
    const { account, zone } = yield* requireZone;
    const tunnel = yield* findTunnel(
      account.token,
      zone.accountId,
      publicRouteTunnelName(environmentId),
    );
    if (tunnel !== null) yield* deleteTunnel(account, zone, tunnel.id);
  }, locked);

  const removeTunnel = Effect.fn("DesktopCloudflare.removeTunnel")(function* (tunnelId: string) {
    const { account, zone } = yield* requireZone;
    yield* deleteTunnel(account, zone, tunnelId);
  }, locked);

  const listTunnels = Effect.gen(function* () {
    const { account, zone } = yield* requireZone;
    const tunnels = yield* api(
      account.token,
      "GET",
      `/accounts/${zone.accountId}/cfd_tunnel?is_deleted=false&per_page=100`,
      Schema.Array(TunnelResult),
    );
    return tunnels
      .filter((tunnel) => tunnel.name.startsWith(PUBLIC_ROUTE_TUNNEL_PREFIX))
      .map((tunnel) => ({
        tunnelId: tunnel.id,
        name: tunnel.name,
        environmentId: tunnel.name.slice(PUBLIC_ROUTE_TUNNEL_PREFIX.length),
      }));
  });

  const verify = Effect.fn("DesktopCloudflare.verify")(function* (
    input: DesktopCloudflareVerifyInput,
  ) {
    return yield* httpClient.get(`https://${input.hostname}/.well-known/t3/environment`).pipe(
      Effect.flatMap(HttpClientResponse.schemaBodyJson(DescriptorResult)),
      Effect.timeout(VERIFY_TIMEOUT),
      Effect.map((descriptor) => descriptor.environmentId === input.environmentId),
      Effect.orElseSucceed(() => false),
    );
  });

  return DesktopCloudflare.of({
    getState,
    connect,
    listZones: requireAccount.pipe(Effect.flatMap((account) => fetchZones(account.token))),
    selectZone,
    disconnect: locked(writeAccount(null).pipe(Effect.andThen(getState))),
    provision,
    rotate,
    remove,
    removeTunnel,
    listTunnels,
    verify,
  });
});

export const layer = Layer.effect(DesktopCloudflare, make);
