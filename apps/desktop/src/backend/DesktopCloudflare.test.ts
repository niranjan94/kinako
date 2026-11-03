import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientResponse } from "effect/http";

import * as DesktopConfig from "../app/DesktopConfig.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as ElectronSafeStorage from "../electron/ElectronSafeStorage.ts";
import * as DesktopCloudflare from "./DesktopCloudflare.ts";

const environmentId = EnvironmentId.make("environment-1");
const ROUTE_HOSTNAME = /^kn-[a-z2-7]{26}\.example\.com$/;

interface IngressRule {
  readonly hostname?: string;
  readonly service: string;
}

/** Enough of Cloudflare's API for one account with one zone. */
const makeFakeCloudflare = (dnsRecordDeleted: Deferred.Deferred<void>) => {
  const tunnels = new Map<string, string>();
  const configs = new Map<string, ReadonlyArray<IngressRule>>();
  let dns: Array<{ id: string; name: string; content: string; proxied: boolean }> = [];
  let nextId = 1;
  const handle = (method: string, url: URL, body: unknown): unknown => {
    const path = url.pathname.replace("/client/v4", "");
    if (method === "GET" && path === "/zones") {
      return [{ id: "zone-1", name: "example.com", account: { id: "acct-1", name: "Acme" } }];
    }
    const tunnelPath = /^\/accounts\/acct-1\/cfd_tunnel(?:\/([^/]+))?(?:\/(\w+))?$/.exec(path);
    if (tunnelPath) {
      const [, tunnelId, child] = tunnelPath;
      if (!tunnelId && method === "GET") {
        const name = url.searchParams.get("name");
        return [...tunnels].flatMap(([id, tunnelName]) =>
          name === null || name === tunnelName ? [{ id, name: tunnelName }] : [],
        );
      }
      if (!tunnelId && method === "POST") {
        const id = `tunnel-${nextId++}`;
        tunnels.set(id, (body as { name: string }).name);
        return { id, name: tunnels.get(id) };
      }
      if (tunnelId && child === "configurations" && method === "GET") {
        return { config: { ingress: configs.get(tunnelId) ?? [] } };
      }
      if (tunnelId && child === "configurations" && method === "PUT") {
        configs.set(tunnelId, (body as { config: { ingress: IngressRule[] } }).config.ingress);
        return {};
      }
      if (tunnelId && child === "token") return `connector-${tunnelId}`;
      if (tunnelId && child === "connections" && method === "DELETE") return null;
      if (tunnelId && !child && method === "DELETE") {
        tunnels.delete(tunnelId);
        configs.delete(tunnelId);
        return null;
      }
    }
    const dnsPath = /^\/zones\/zone-1\/dns_records(?:\/([^/]+))?$/.exec(path);
    if (dnsPath) {
      const [, recordId] = dnsPath;
      if (method === "GET") {
        return dns.filter((record) => record.name === url.searchParams.get("name"));
      }
      if (method === "POST") {
        const record = body as { name: string; content: string; proxied: boolean };
        dns.push({ id: `record-${nextId++}`, ...record });
        return {};
      }
      if (method === "DELETE") {
        dns = dns.filter((record) => record.id !== recordId);
        Deferred.doneUnsafe(dnsRecordDeleted, Effect.void);
        return null;
      }
    }
    throw new Error(`Unexpected Cloudflare request: ${method} ${path}`);
  };
  const client = HttpClient.make((request) => {
    const body =
      request.body._tag === "Uint8Array"
        ? JSON.parse(new TextDecoder().decode(request.body.body))
        : undefined;
    const result = handle(request.method, new URL(request.url), body);
    return Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        new Response(JSON.stringify({ success: true, errors: [], result }), {
          headers: { "content-type": "application/json" },
        }),
      ),
    );
  });
  return { client, tunnels, configs, dns: () => dns };
};

const layerSafeStorage = Layer.succeed(ElectronSafeStorage.ElectronSafeStorage, {
  isEncryptionAvailable: Effect.succeed(true),
  encryptString: (value) => Effect.succeed(new TextEncoder().encode(value)),
  decryptString: (value) => Effect.succeed(new TextDecoder().decode(value)),
  selectedStorageBackend: Effect.succeedNone,
} satisfies ElectronSafeStorage.ElectronSafeStorage["Service"]);

const withCloudflare = <A, E>(
  body: (
    fake: ReturnType<typeof makeFakeCloudflare>,
    dnsRecordDeleted: Deferred.Deferred<void>,
  ) => Effect.Effect<A, E, DesktopCloudflare.DesktopCloudflare>,
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const baseDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-desktop-cloudflare-" });
    const dnsRecordDeleted = yield* Deferred.make<void>();
    const fake = makeFakeCloudflare(dnsRecordDeleted);
    const layerEnvironment = DesktopEnvironment.layer({
      dirname: "/repo/apps/desktop/src",
      homeDirectory: baseDir,
      platform: "darwin",
      processArch: "arm64",
      appVersion: "1.2.3",
      appPath: "/repo",
      isPackaged: true,
      resourcesPath: "/missing/resources",
      runningUnderArm64Translation: false,
    }).pipe(
      Layer.provide(
        Layer.mergeAll(NodeServices.layer, DesktopConfig.layerTest({ T3CODE_HOME: baseDir })),
      ),
    );
    return yield* body(fake, dnsRecordDeleted).pipe(
      Effect.provide(
        DesktopCloudflare.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              layerEnvironment,
              layerSafeStorage,
              NodeServices.layer,
              NodeCrypto.layer,
              Layer.succeed(HttpClient.HttpClient, fake.client),
            ),
          ),
        ),
      ),
    );
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped);

describe("DesktopCloudflare", () => {
  it.effect("provisions a tunnel with a 404 catch-all and a proxied CNAME, then adopts it", () =>
    withCloudflare((fake) =>
      Effect.gen(function* () {
        const cloudflare = yield* DesktopCloudflare.DesktopCloudflare;
        expect(yield* cloudflare.connect(" token ")).toHaveLength(1);
        expect((yield* cloudflare.getState).zone?.name).toBe("example.com");

        const route = yield* cloudflare.provision({ environmentId, originPort: 3773 });
        expect(route.hostname).toMatch(ROUTE_HOSTNAME);
        expect(route.connectorToken).toBe(`connector-${route.tunnelId}`);
        expect([...fake.tunnels.values()]).toEqual(["kinako-environment-1"]);
        expect(fake.configs.get(route.tunnelId)).toEqual([
          { hostname: route.hostname, service: "http://127.0.0.1:3773" },
          { service: "http_status:404" },
        ]);
        expect(fake.dns()).toMatchObject([
          { name: route.hostname, content: `${route.tunnelId}.cfargotunnel.com`, proxied: true },
        ]);

        expect(yield* cloudflare.provision({ environmentId, originPort: 3773 })).toEqual(route);
        expect(fake.tunnels.size).toBe(1);
        expect(fake.dns()).toHaveLength(1);
      }),
    ),
  );

  it.effect("keeps a rotated hostname through its grace period, then removes everything", () =>
    withCloudflare((fake, dnsRecordDeleted) =>
      Effect.gen(function* () {
        const cloudflare = yield* DesktopCloudflare.DesktopCloudflare;
        yield* cloudflare.connect("token");
        const first = yield* cloudflare.provision({ environmentId, originPort: 3773 });
        const rotated = yield* cloudflare.rotate({ environmentId, originPort: 3773 });

        expect(rotated.hostname).toMatch(ROUTE_HOSTNAME);
        expect(rotated.hostname).not.toBe(first.hostname);
        expect(rotated.tunnelId).toBe(first.tunnelId);
        expect(fake.configs.get(first.tunnelId)?.map((rule) => rule.hostname)).toEqual([
          rotated.hostname,
          first.hostname,
          undefined,
        ]);

        yield* TestClock.adjust(Duration.minutes(11));
        // Retiring drops the ingress rule first and the DNS record last.
        yield* Deferred.await(dnsRecordDeleted);
        expect(fake.configs.get(first.tunnelId)?.map((rule) => rule.hostname)).toEqual([
          rotated.hostname,
          undefined,
        ]);
        expect(fake.dns().map((record) => record.name)).toEqual([rotated.hostname]);
        expect((yield* cloudflare.listTunnels).map((tunnel) => tunnel.environmentId)).toEqual([
          "environment-1",
        ]);

        // Takes the cleanup's lock, so it also waits for the retirement to be recorded.
        yield* cloudflare.remove(environmentId);
        expect(fake.tunnels.size).toBe(0);
        expect(fake.dns()).toEqual([]);
      }),
    ),
  );
});
