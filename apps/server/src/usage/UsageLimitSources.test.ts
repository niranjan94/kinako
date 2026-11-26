import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  resolveProjectProviderInstanceEnabled,
  SecretProviderId,
  ServerConfigStreamEvent,
  UsageLimitSourceId,
  type ServerProviderUsageWindow,
  type UsageLimitSourceSnapshot,
} from "@t3tools/contracts";
import * as SecretResolver from "@t3tools/secret-provider-core/server/SecretResolver";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientResponse } from "effect/http";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as BackgroundPolicy from "../background/BackgroundPolicy.ts";
import * as ServerConfig from "../config.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as UsageLimitSources from "./UsageLimitSources.ts";

const encodeConfigEvent = Schema.encodeSync(ServerConfigStreamEvent);

it.effect("keeps malformed source URLs encodable for config subscribers", () =>
  Effect.gen(function* () {
    const sources = yield* UsageLimitSources.make;
    yield* sources.refresh;
    const snapshots = yield* sources.current;
    expect(snapshots.map((source) => source.label)).toEqual([
      "local-hub",
      "opaque-hub",
      "Named hub",
      "hub.test:8317",
      "Usage limit source",
    ]);
    // Only an http(s) hub URL names an endpoint an agent can be sent to.
    expect(snapshots.map((source) => source.origin)).toEqual([
      undefined,
      undefined,
      undefined,
      "https://hub.test:8317",
      undefined,
    ]);
    expect(snapshots[3]?.endpoint).toBe("https://hub.test:8317/team-a");
    expect(() =>
      encodeConfigEvent({
        version: 1,
        type: "usageLimitSourcesUpdated",
        payload: { sources: snapshots },
      }),
    ).not.toThrow();
    expect(snapshots.every((source) => source.error === "No management key configured.")).toBe(
      true,
    );
  }).pipe(
    Effect.provide([
      Layer.succeed(SecretResolver.SecretResolver, {
        label: (provider) => Effect.succeed(provider),
        read: (references) => Effect.succeed(references.map(() => undefined)),
        invalidate: () => Effect.void,
      }),
      ServerSettings.layerTest({
        usageLimitSources: {
          [UsageLimitSourceId.make("local-hub")]: {
            kind: "cliproxy",
            url: "localhost:8317",
            managementKey: "",
            enabled: true,
          },
          [UsageLimitSourceId.make("opaque-hub")]: {
            kind: "cliproxy",
            url: "file:///tmp/hub",
            managementKey: "",
            enabled: true,
          },
          [UsageLimitSourceId.make("named-hub")]: {
            kind: "cliproxy",
            url: "localhost:8317",
            label: "Named hub",
            managementKey: "",
            enabled: true,
          },
          [UsageLimitSourceId.make("valid-hub")]: {
            kind: "cliproxy",
            url: "https://hub.test:8317/team-a/management.html",
            managementKey: "",
            enabled: true,
          },
          [UsageLimitSourceId.make(" ")]: {
            kind: "cliproxy",
            url: "localhost:8317",
            managementKey: "",
            enabled: true,
          },
        },
      }),
      Layer.mock(BackgroundPolicy.BackgroundPolicy)({
        shouldRunScopeWork: () => Effect.succeed(false),
      }),
      Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make(() => Effect.die("Unexpected network request")),
      ),
      NodeCrypto.layer,
      Sqlite.layerMemory,
    ]),
  ),
);

it.effect("publishes validated HTTP quotas as display-only accounts", () => {
  const window = { id: "monthly", kind: "monthly", label: "Monthly", usedPercent: 35 };
  const accounts = [
    { id: "account", label: "External plan", providerInstanceId: "work-codex", windows: [window] },
  ];
  let usedPercent = 35;
  let oversized = false;
  const client = HttpClient.make((request, url) =>
    Effect.sync(() => {
      expect(url.href).toBe("https://quota.test/v1");
      expect(request.headers.authorization).toBe("Bearer test-token");
      return HttpClientResponse.fromWeb(
        request,
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode(
                  JSON.stringify({
                    version: 1,
                    accounts: [{ ...accounts[0], windows: [{ ...window, usedPercent }] }],
                  }),
                ),
              );
              if (oversized) controller.enqueue(new Uint8Array(1024 * 1024).fill(32));
              controller.close();
            },
          }),
        ),
      );
    }),
  );
  return Effect.gen(function* () {
    const sources = yield* UsageLimitSources.make;
    yield* sources.refresh;
    const [snapshot] = yield* sources.current;
    expect(snapshot).toMatchObject({ kind: "http", accounts: [], quotaAccounts: accounts });
    expect(snapshot?.origin).toBeUndefined();
    usedPercent = 101;
    yield* sources.refresh;
    const [failed] = yield* sources.current;
    expect(failed).toMatchObject({ accounts: [], error: "Could not read the HTTP quota source." });
    expect(failed?.quotaAccounts).toBeUndefined();
    usedPercent = 35;
    oversized = true;
    yield* sources.refresh;
    expect((yield* sources.current)[0]).toMatchObject({
      accounts: [],
      error: "Could not read the HTTP quota source.",
    });
  }).pipe(
    Effect.provide([
      Layer.succeed(SecretResolver.SecretResolver, {
        label: (provider) => Effect.succeed(provider),
        read: (references) => Effect.succeed(references.map(() => undefined)),
        invalidate: () => Effect.void,
      }),
      ServerSettings.layerTest({
        usageLimitSources: {
          [UsageLimitSourceId.make("quota")]: {
            kind: "http",
            url: "https://quota.test/v1",
            managementKey: "test-token",
            enabled: true,
          },
        },
      }),
      Layer.mock(BackgroundPolicy.BackgroundPolicy)({
        shouldRunScopeWork: () => Effect.succeed(false),
      }),
      Layer.succeed(HttpClient.HttpClient, client),
      NodeCrypto.layer,
      Sqlite.layerMemory,
    ]),
  );
});

it.effect("reads a management key from its secret provider", () => {
  const authorizations: Array<string | undefined> = [];
  const keySource = (reference: string) => ({
    provider: SecretProviderId.make("homelab"),
    reference,
  });
  return Effect.gen(function* () {
    const sources = yield* UsageLimitSources.make;
    const snapshots = yield* sources.streamChanges.pipe(
      Stream.filter((next) => next.length > 0),
      Stream.runHead,
      Effect.flatMap(Effect.fromOption),
    );
    expect(snapshots.map(({ id, error }) => ({ id, error }))).toEqual([
      { id: "resolved-hub", error: undefined },
      {
        id: "unresolved-hub",
        error: "Could not read the management key from its secret provider.",
      },
    ]);
    expect(authorizations).toEqual(["Bearer resolved-key"]);
  }).pipe(
    Effect.provide([
      ServerSettings.layerTest({
        usageLimitSources: {
          [UsageLimitSourceId.make("resolved-hub")]: {
            kind: "cliproxy",
            url: "https://resolved.test",
            managementKey: keySource("cliproxy#key"),
            enabled: true,
          },
          [UsageLimitSourceId.make("unresolved-hub")]: {
            kind: "cliproxy",
            url: "https://unresolved.test",
            managementKey: keySource("missing#key"),
            enabled: true,
          },
        },
      }),
      Layer.mock(BackgroundPolicy.BackgroundPolicy)({
        shouldRunScopeWork: () => Effect.succeed(false),
      }),
      Layer.succeed(SecretResolver.SecretResolver, {
        label: (provider) => Effect.succeed(provider),
        read: (references) =>
          Effect.succeed(
            references.map((reference) =>
              reference.reference === "cliproxy#key" ? "resolved-key" : undefined,
            ),
          ),
        invalidate: () => Effect.void,
      }),
      Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Effect.sync(() => {
            if (new URL(request.url).pathname.endsWith("/api-keys")) {
              expect(request.headers.authorization).toBe("Bearer resolved-key");
              return HttpClientResponse.fromWeb(request, Response.json([]));
            }
            authorizations.push(request.headers.authorization);
            return HttpClientResponse.fromWeb(request, Response.json({ files: [] }));
          }),
        ),
      ),
      NodeCrypto.layer,
      Sqlite.layerMemory,
    ]),
  );
});

it.effect("keeps an account's last good reading when the hub's next read of it is refused", () => {
  let refused = true;
  let workspace = "account-a";
  let listsIdentity = true;
  return Effect.gen(function* () {
    yield* TestClock.setTime(NOW);
    const sources = yield* UsageLimitSources.make;
    const read = Effect.gen(function* () {
      yield* sources.refresh;
      const [source] = yield* sources.current;
      return source?.accounts[0]?.usageLimits;
    });
    // Nothing to keep yet: the account stays listed as unreadable.
    expect(yield* read).toMatchObject({ windows: [], unavailable: { reason: "probeFailed" } });
    yield* TestClock.adjust("2 minutes");
    refused = false;
    yield* read;
    yield* TestClock.adjust("3 minutes");
    const good = yield* read;
    expect(good?.windows.map((window) => window.usedPercent)).toEqual([78]);
    expect(good?.unavailable).toBeUndefined();
    yield* TestClock.adjust("5 minutes");
    refused = true;
    expect(yield* read).toEqual(good);
    const history = yield* sources.quotaHistory({
      sourceId: UsageLimitSourceId.make("hub"),
      from: at(0),
      to: at(1),
    });
    expect(history.map(({ accounts }) => accounts[0]?.unavailable)).toEqual([
      true,
      undefined,
      undefined,
      true,
    ]);
    expect(history[1]?.accounts[0]?.windows[0]?.usedPercent).toBe(78);
    expect(history[3]?.accounts[0]?.key).toBe(history[1]?.accounts[0]?.key);
    expect(history[3]?.accounts[0]?.windows).toEqual([]);
    expect(history[1]?.accounts[0]).not.toHaveProperty("email");
    expect(history[1]?.accounts[0]).not.toHaveProperty("id");
    // The same auth file now holds another login, whose reading is unknown.
    workspace = "account-b";
    expect(yield* read).toMatchObject({ windows: [], unavailable: { reason: "probeFailed" } });
    // A file that lists no login cannot show whether the next one is the same.
    listsIdentity = false;
    refused = false;
    yield* read;
    refused = true;
    expect(yield* read).toMatchObject({ windows: [], unavailable: { reason: "probeFailed" } });
  }).pipe(
    Effect.provide([
      ServerSettings.layerTest({
        usageLimitSources: {
          [UsageLimitSourceId.make("hub")]: {
            kind: "cliproxy",
            url: "http://hub.test:8317",
            managementKey: "management-secret",
            enabled: true,
          },
        },
      }),
      Layer.mock(BackgroundPolicy.BackgroundPolicy)({
        shouldRunScopeWork: () => Effect.succeed(false),
      }),
      Layer.succeed(SecretResolver.SecretResolver, {
        label: (provider) => Effect.succeed(provider),
        read: (references) => Effect.succeed(references.map(() => undefined)),
        invalidate: () => Effect.void,
      }),
      Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Effect.sync(() => {
            if (new URL(request.url).pathname.endsWith("/auth-files")) {
              return HttpClientResponse.fromWeb(
                request,
                Response.json({
                  files: [
                    {
                      id: "first.json",
                      auth_index: "a",
                      provider: "codex",
                      ...(listsIdentity
                        ? {
                            email: "first@example.com",
                            id_token: { chatgpt_account_id: workspace },
                          }
                        : {}),
                    },
                  ],
                }),
              );
            }
            const usage = {
              plan_type: "pro",
              rate_limit: {
                secondary_window: {
                  used_percent: 78,
                  reset_at: 4070908800,
                  limit_window_seconds: 604800,
                },
              },
            };
            return HttpClientResponse.fromWeb(
              request,
              Response.json(
                refused
                  ? { status_code: 429, body: "{}" }
                  : { status_code: 200, body: JSON.stringify(usage) },
              ),
            );
          }),
        ),
      ),
      NodeCrypto.layer,
      Sqlite.layerMemory,
    ]),
  );
});

it.effect("keeps managed Claude settings and availability in sync with the hub", () =>
  Effect.gen(function* () {
    const sourceId = UsageLimitSourceId.make("hub");
    const defaultInstanceId = ProviderInstanceId.make("claudeAgent");
    const keyRequested = yield* Deferred.make<void>();
    const releaseKeys = yield* Deferred.make<void>();
    const modelAuthorizations: Array<string | undefined> = [];
    let reachable = false;
    let clientKey = "client-key";
    let hubModels = ["claude-sonnet-4-6", "hub-only"];
    return yield* Effect.gen(function* () {
      const settings = yield* ServerSettings.ServerSettingsService;
      const { settingsPath } = yield* ServerConfig.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const sourceConfig = {
        kind: "cliproxy" as const,
        label: "Home hub",
        url: "https://hub.test/proxy/management.html?tab=accounts",
        managementKey: "management-secret",
        enabled: true,
      };
      const before = yield* settings.updateSettings({
        providerInstances: {
          [defaultInstanceId]: {
            driver: ProviderDriverKind.make("claudeAgent"),
            displayName: "Personal Claude",
            config: {
              binaryPath: "/opt/claude",
              homePath: "~/.claude-work",
              customModels: [{ slug: "personal-only", name: "Personal model" }],
            },
            environment: [
              { name: "ANTHROPIC_UNIX_SOCKET", value: "/tmp/personal.sock", sensitive: false },
              { name: "CLAUDE_CODE_HOST_AUTH_ENV_VAR", value: "PERSONAL_TOKEN", sensitive: false },
              { name: "CLAUDE_CONFIG_DIR", value: "~/.claude-work", sensitive: false },
            ],
          },
        },
        setModelFavorites: [
          { provider: defaultInstanceId, model: "claude-sonnet-4-6", favorite: true },
        ],
        usageLimitSources: { [sourceId]: sourceConfig },
      });
      const sources = yield* UsageLimitSources.make;
      yield* sources.refresh;
      expect((yield* settings.getSettings).providerInstances).toEqual(before.providerInstances);

      reachable = true;
      const changes = yield* settings.subscribeChanges;
      const refreshed = yield* sources.refresh.pipe(Effect.forkScoped);
      yield* Deferred.await(keyRequested);
      expect((yield* sources.current)[0]?.error).toBeUndefined();
      expect((yield* settings.getSettings).providerInstances).toEqual(before.providerInstances);
      yield* Deferred.succeed(releaseKeys, undefined);
      yield* Fiber.join(refreshed);
      const configured = yield* changes.pipe(
        Stream.filter((next) =>
          Object.values(next.providerInstances).some(
            (instance) => instance.claudeHub?.sourceId === sourceId,
          ),
        ),
        Stream.runHead,
        Effect.flatMap(Effect.fromOption),
      );
      expect(configured.providerInstances[defaultInstanceId]).toEqual(
        before.providerInstances[defaultInstanceId],
      );
      const entries = Object.entries(configured.providerInstances).filter(
        ([id]) => id !== defaultInstanceId,
      );
      expect(entries).toHaveLength(1);
      const [instanceId, instance] = entries[0]!;
      expect(instance).toMatchObject({ driver: "claudeAgent", displayName: "Claude (Home hub)" });
      expect(instance.config).toMatchObject({
        binaryPath: "/opt/claude",
        homePath: "~/.claude-work",
        hubModels,
        customModels: [],
      });
      expect(configured.favorites).toContainEqual({
        provider: instanceId,
        model: "claude-sonnet-4-6",
      });
      expect(instance.environment).toEqual(
        expect.arrayContaining([
          { name: "ANTHROPIC_BASE_URL", value: "https://hub.test/proxy", sensitive: false },
          { name: "CLAUDE_CODE_USE_ANTHROPIC_AWS", value: "", sensitive: false },
          { name: "CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD", value: "", sensitive: false },
          { name: "CLAUDE_CODE_USE_MANTLE", value: "", sensitive: false },
          { name: "ANTHROPIC_UNIX_SOCKET", value: "", sensitive: false },
          { name: "CLAUDE_CODE_HOST_AUTH_ENV_VAR", value: "", sensitive: false },
          { name: "CLAUDE_CONFIG_DIR", value: "~/.claude-work", sensitive: false },
          expect.objectContaining({
            name: "ANTHROPIC_AUTH_TOKEN",
            value: "client-key",
            sensitive: true,
          }),
        ]),
      );
      expect(yield* fs.readFileString(settingsPath)).not.toContain("client-key");
      expect(
        JSON.stringify(
          ServerSettings.redactServerSettingsForClient(configured, {
            secretReferences: true,
          }),
        ),
      ).not.toContain("client-key");
      expect(JSON.stringify(yield* sources.current)).not.toContain("client-key");

      const id = ProviderInstanceId.make(instanceId);
      const projectId = ProjectId.make("hub-project");
      const token = (settings: typeof configured) =>
        settings.providerInstances[id]?.environment?.find(
          (variable) => variable.name === "ANTHROPIC_AUTH_TOKEN",
        )?.value;
      const editedInstance = {
        ...instance,
        displayName: "Edited Claude",
        enabled: false,
        config: { binaryPath: "/opt/other-claude" },
        environment: [
          { name: "ANTHROPIC_BASE_URL", value: "https://other.test", sensitive: false },
          { name: "anthropic_auth_token", value: "replacement", sensitive: false },
        ],
      };
      const editError = yield* settings
        .updateProviderInstance({ operation: "upsert", instanceId: id, instance: editedInstance })
        .pipe(Effect.flip);
      expect(editError.operation).toBe("write-managed-setting");
      const effort = { id: "effort", value: "high" };
      const edited = yield* settings.updateSettings({
        providerInstances: {
          [id]: editedInstance,
          [defaultInstanceId]: {
            driver: instance.driver,
            config: { binaryPath: "/opt/claude-next" },
          },
        },
        projectSettingsOverrides: {
          [projectId]: {
            providerInstances: { [defaultInstanceId]: { enabled: false }, [id]: { enabled: true } },
          },
        },
        setModelFavorites: [{ provider: id, model: "claude-sonnet-4-6", favorite: false }],
        setModelEffortDefaults: [
          { provider: defaultInstanceId, model: "claude-sonnet-4-6", effort },
        ],
      });
      expect(edited.providerInstances[id]?.displayName).toBe("Claude (Home hub)");
      expect(edited.providerInstances[id]?.enabled).not.toBe(false);
      expect(resolveProjectProviderInstanceEnabled(edited, projectId, id)).toBe(false);
      expect(resolveProjectProviderInstanceEnabled(edited, null, id)).toBe(true);
      expect(edited.providerInstances[id]?.config).toMatchObject({
        binaryPath: "/opt/claude-next",
      });
      expect(edited.favorites).toEqual([]);
      expect(edited.providerModelPreferences?.[id]?.defaultEfforts?.["claude-sonnet-4-6"]).toEqual(
        effort,
      );
      expect(edited.providerInstances[id]?.environment).toEqual(
        expect.arrayContaining([
          { name: "ANTHROPIC_BASE_URL", value: "https://hub.test/proxy", sensitive: false },
          { name: "CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST", value: "1", sensitive: false },
        ]),
      );
      expect(token(edited)).toBe("client-key");
      expect(modelAuthorizations.slice(0, 2)).toEqual([
        "Bearer stale-client-key",
        "Bearer client-key",
      ]);

      const shared = yield* settings.updateSettings({
        setModelFavorites: [{ provider: id, model: "hub-only", favorite: true }],
        setModelEffortDefaults: [{ provider: id, model: "claude-sonnet-4-6", effort: null }],
      });
      expect(shared.favorites).toEqual([
        { provider: defaultInstanceId, model: "hub-only" },
        { provider: id, model: "hub-only" },
      ]);
      expect(shared.providerModelPreferences?.[defaultInstanceId]?.defaultEfforts).toEqual({});
      expect(shared.providerModelPreferences?.[id]?.defaultEfforts).toEqual({});

      const modelChanges = yield* settings.subscribeChanges;
      hubModels = ["claude-sonnet-4-6", "new-hub-model"];
      yield* sources.refresh;
      yield* modelChanges.pipe(
        Stream.filter(
          (next) =>
            next.providerInstances[id]?.claudeHub?.models?.includes("new-hub-model") === true,
        ),
        Stream.runHead,
        Effect.flatMap(Effect.fromOption),
      );

      clientKey = "rotated-key";
      const rotation = yield* settings.subscribeChanges;
      yield* sources.refresh;
      const rotated = yield* rotation.pipe(
        Stream.filter((next) => token(next) === clientKey),
        Stream.runHead,
        Effect.flatMap(Effect.fromOption),
      );
      expect(rotated.providerInstances[id]?.displayName).toBe("Claude (Home hub)");
      expect(yield* fs.readFileString(settingsPath)).not.toContain(clientKey);

      reachable = false;
      const outage = yield* settings.subscribeChanges;
      yield* sources.refresh;
      yield* outage.pipe(
        Stream.filter((next) => next.providerInstances[id] === undefined),
        Stream.runHead,
        Effect.flatMap(Effect.fromOption),
      );
      expect((yield* settings.getSettings).providerInstances[id]).toBeUndefined();

      reachable = true;
      const recovery = yield* settings.subscribeChanges;
      yield* sources.refresh;
      const recovered = yield* recovery.pipe(
        Stream.filter((next) => token(next) === clientKey),
        Stream.runHead,
        Effect.flatMap(Effect.fromOption),
      );
      expect(recovered.providerInstances[id]?.displayName).toBe("Claude (Home hub)");
      const removed = yield* settings.updateSettings({ usageLimitSources: { [sourceId]: null } });
      expect(removed.providerInstances).toEqual({
        [defaultInstanceId]: edited.providerInstances[defaultInstanceId],
      });
      const rejected = yield* settings
        .updateProviderInstance({
          operation: "upsert",
          instanceId: id,
          instance,
        })
        .pipe(Effect.flip);
      expect(rejected.operation).toBe("write-managed-setting");
    }).pipe(
      Effect.provide([
        ServerSettings.layer.pipe(
          Layer.provide(Layer.merge(ServerSecretStore.layer, ManagedPolicy.layerTest())),
          Layer.provideMerge(Sqlite.layerMemory),
          Layer.provideMerge(
            ServerConfig.layerTest(process.cwd(), { prefix: "t3code-claude-hub-" }),
          ),
          Layer.provideMerge(NodeServices.layer),
          Layer.provideMerge(NodeCrypto.layer),
        ),
        Layer.mock(BackgroundPolicy.BackgroundPolicy)({
          shouldRunScopeWork: () => Effect.succeed(false),
        }),
        Layer.succeed(SecretResolver.SecretResolver, {
          label: (provider) => Effect.succeed(provider),
          read: (references) => Effect.succeed(references.map(() => undefined)),
          invalidate: () => Effect.void,
        }),
        Layer.succeed(
          HttpClient.HttpClient,
          HttpClient.make((request) =>
            Effect.gen(function* () {
              const path = new URL(request.url).pathname;
              const authorization = request.headers.authorization;
              if (path === "/proxy/v1/models") {
                modelAuthorizations.push(authorization);
                const response =
                  reachable && authorization === `Bearer ${clientKey}`
                    ? Response.json({
                        data: hubModels.map((id) => ({ id, owned_by: "anthropic" })),
                      })
                    : Response.json({}, { status: 401 });
                return HttpClientResponse.fromWeb(request, response);
              }
              expect(authorization).toBe("Bearer management-secret");
              if (path.endsWith("/auth-files")) {
                return HttpClientResponse.fromWeb(
                  request,
                  Response.json({ files: [] }, { status: reachable ? 200 : 503 }),
                );
              }
              if (path === "/proxy/v8/management/config/access/api-keys") {
                return HttpClientResponse.fromWeb(request, Response.json({}, { status: 404 }));
              }
              expect(path).toBe("/proxy/v0/management/api-keys");
              yield* Deferred.succeed(keyRequested, undefined);
              yield* Deferred.await(releaseKeys);
              const response = Response.json({
                "api-keys": ["", "stale-client-key", clientKey],
              });
              return HttpClientResponse.fromWeb(request, response);
            }),
          ),
        ),
      ]),
    );
  }),
);

const NOW = Date.parse("2026-11-13T12:00:00.000Z");
const at = (hours: number) => DateTime.formatIso(DateTime.makeUnsafe(NOW + hours * 3_600_000));
const spent = (id: string, hours: number): ServerProviderUsageWindow => ({
  id,
  kind: "weekly",
  label: id,
  usedPercent: 100,
  resetsAt: at(hours),
});
const hub = (
  accounts: ReadonlyArray<{
    driver?: string;
    models?: ReadonlyArray<string>;
    windows?: ReadonlyArray<ServerProviderUsageWindow>;
    unavailable?: true;
  }>,
): UsageLimitSourceSnapshot => ({
  id: UsageLimitSourceId.make("hub"),
  kind: "cliproxy",
  label: "hub",
  checkedAt: at(0),
  accounts: accounts.map((account, index) => ({
    id: `account-${index}`,
    driver: ProviderDriverKind.make(account.driver ?? "claudeAgent"),
    ...(account.models ? { models: account.models } : {}),
    usageLimits: {
      checkedAt: at(0),
      windows: account.windows ?? [],
      ...(account.unavailable ? { unavailable: { reason: "probeFailed" as const } } : {}),
    },
  })),
});

it.each([
  {
    name: "earliest refill when every account is spent, each at its latest spent window",
    accounts: [
      { windows: [spent("five_hour", 1), spent("seven_day", 3)] },
      { windows: [spent("five_hour", 2)] },
      { driver: "codex", windows: [] },
    ],
    model: "claude-haiku-5-5",
    expected: at(2),
  },
  {
    name: "unknown while an account still has room",
    accounts: [{ windows: [spent("five_hour", 1)] }, { windows: [] }],
    model: "claude-haiku-5-5",
    expected: null,
  },
  {
    name: "unknown while an account could not be read",
    accounts: [{ windows: [spent("five_hour", 1)] }, { unavailable: true as const }],
    model: "claude-haiku-5-5",
    expected: null,
  },
  {
    name: "unknown when a spent window has no reset or already reset",
    accounts: [{ windows: [{ ...spent("five_hour", 1), resetsAt: undefined }] }],
    model: "claude-haiku-5-5",
    expected: null,
  },
  {
    name: "a model-scoped weekly window blocks only its own model",
    accounts: [{ windows: [spent("seven_day_fable", 5)] }],
    model: "claude-haiku-5-5",
    expected: null,
  },
  {
    name: "a model-scoped weekly window blocks its own model",
    accounts: [{ windows: [spent("seven_day_fable", 5)] }],
    model: "claude-fable-5-2",
    expected: at(5),
  },
  {
    name: "no account of the driver",
    accounts: [{ driver: "codex", windows: [spent("five_hour", 1)] }],
    model: "claude-haiku-5-5",
    expected: null,
  },
  // regression: #30778 only the accounts the hub routes the model to can refill it
  {
    name: "an account of another driver the hub routes the model to counts",
    accounts: [
      { driver: "codex", models: ["gpt-5.6-sol"], windows: [spent("five_hour", 3)] },
      { models: ["claude-sonnet-4-6"], windows: [] },
    ],
    model: "gpt-5.6-sol",
    expected: at(3),
  },
  {
    name: "an account that lists no models is left out of an alias",
    accounts: [{ windows: [spent("five_hour", 1)] }, { models: [], windows: [] }],
    model: "opus",
    expected: at(1),
  },
  {
    name: "a hub thinking suffix routes by its base model",
    accounts: [
      { driver: "codex", models: ["gpt-5.2"], windows: [spent("five_hour", 3)] },
      { models: ["claude-sonnet-4-6"], windows: [] },
    ],
    model: "gpt-5.2(high)",
    expected: at(3),
  },
  {
    name: "an own-driver account whose model list was unread still counts",
    accounts: [
      { windows: [spent("five_hour", 1)] },
      {
        driver: "antigravity",
        models: ["claude-sonnet-4-6"],
        windows: [spent("3p-5h", 8)],
      },
    ],
    model: "claude-sonnet-4-6",
    expected: at(1),
  },
])("hub pool reset: $name", ({ accounts, model, expected }) => {
  expect(
    UsageLimitSources.hubPoolResetAt(
      [hub(accounts)],
      ProviderDriverKind.make("claudeAgent"),
      model,
      NOW,
    ),
  ).toBe(expected);
});

it.effect("the reset fallback refreshes its hub, and a stalled hub cannot hold the failure", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(NOW);
    const roomLeft = { ...hub([{ windows: [spent("five_hour", 2)] }]), origin: "http://hub.test" };
    const cached = {
      ...roomLeft,
      accounts: roomLeft.accounts.map((account) => ({
        ...account,
        usageLimits: {
          ...account.usageLimits,
          windows: account.usageLimits.windows.map((window) => ({ ...window, usedPercent: 99 })),
        },
      })),
    };
    let current: ReadonlyArray<UsageLimitSourceSnapshot> = [cached];
    let refresh: Effect.Effect<void> = Effect.sync(() => {
      current = [roomLeft];
    });
    const lookup = UsageLimitSources.UsageLimitResetFallback.pipe(
      Effect.flatMap((fallback) =>
        fallback.resetAt(ProviderDriverKind.make("claudeAgent"), "http://hub.test", null),
      ),
      Effect.provide(
        UsageLimitSources.layerResetFallback.pipe(
          Layer.provide(
            Layer.mock(UsageLimitSources.UsageLimitSources)({
              current: Effect.sync(() => current),
              refresh: Effect.suspend(() => refresh),
            }),
          ),
        ),
      ),
    );
    // The last poll saw room; the account was spent after it.
    expect(yield* lookup).toBe(at(2));
    current = [cached];
    refresh = Effect.never;
    const stalled = yield* Effect.forkChild(lookup);
    yield* TestClock.adjust("5 seconds");
    expect(yield* Fiber.join(stalled)).toBeNull();
  }),
);
