import {
  CLAUDE_HUB_MANAGED_ENVIRONMENT_NAMES,
  DEFAULT_SERVER_SETTINGS,
  ModelSelection,
  ProjectId,
  ProjectScript,
  keepUnknownOverrideKeys,
  ProjectSettingsOverrides,
  type ProviderInstanceConfig,
  type ProviderInstanceMutation,
  defaultInstanceIdForDriver,
  isProviderDriverKind,
  isClaudeHubInstanceId,
  ProviderDriverKind,
  ProviderInstanceId,
  resolveProviderInstanceEnabled,
  ResponseStreamingMode,
  ServerSettings,
  ServerSettingsError,
  type ServerSettingsPatch,
  type ManagedPolicySummary,
  globalIdleCompaction,
  isSecretReference,
  type SecretReference,
  type UsageLimitSourceConfig,
  type UsageLimitSourceId,
  withIdleCompaction,
} from "@t3tools/contracts";
import * as Cache from "effect/Cache";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Equal from "effect/Equal";
import * as Effect from "effect/Effect";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";
import * as Semaphore from "effect/Semaphore";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import { resolveSymlinkTarget } from "@t3tools/shared/symlink";
import * as ServerConfig from "./config.ts";
import { type DeepPartial, deepMerge } from "@t3tools/shared/Struct";
import { fromJsonStringPretty, fromLenientJson } from "@t3tools/shared/schemaJson";
import {
  applyServerSettingsPatch,
  deriveLegacyProjectOverrides,
  fallbackTextGenerationModelSelection,
  isModelSelectionProviderEnabled,
} from "@t3tools/shared/serverSettings";
import * as ServerSecretStore from "./auth/ServerSecretStore.ts";
import * as ManagedPolicy from "./policy/ManagedPolicy.ts";
import { secretProviderDefinitions } from "./secrets/secretProviderDefinitions.ts";
import { watchDirectoryReplacements } from "./watchDirectoryReplacements.ts";
import {
  readSecretFieldValues,
  sourceControlHostSecretName,
} from "./sourceControl/sourceControlHostSecrets.ts";

import {
  mapSettingsSecrets,
  mapSettingsSecretValues,
  withoutRemovedSecretProviderReferences,
  withoutRedirectedSimlockTokens,
  SECRET_REDACTED,
  type SettingsSecret,
} from "./settingsSecrets.ts";

export {
  resolveReviewGuideModelSelection,
  resolveSourceControlWriterModelSelection,
} from "@t3tools/shared/serverSettings";

const encodeServerSettings = Schema.encodeEffect(ServerSettings);
const encodeServerSettingsJson = Schema.encodeUnknownEffect(fromJsonStringPretty(ServerSettings));
const decodeServerSettings = Schema.decodeUnknownEffect(ServerSettings);

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

// Conflicting flags resolve to false to preserve user disables.
const foldProviderInstanceEnabledFlags = (settings: ServerSettings): ServerSettings => {
  let changed = false;
  const providerInstances: Record<string, ProviderInstanceConfig> = {};
  for (const [instanceId, instance] of Object.entries(settings.providerInstances)) {
    const config = instance.config;
    // Leave malformed flags for driver schema validation rather than silently repairing them.
    if (
      config === null ||
      typeof config !== "object" ||
      Array.isArray(config) ||
      typeof (config as { readonly enabled?: unknown }).enabled !== "boolean"
    ) {
      providerInstances[instanceId] = instance;
      continue;
    }
    const { enabled: configEnabled, ...restConfig } = config as Record<string, unknown> & {
      readonly enabled: boolean;
    };
    const resolved =
      instance.enabled === false || configEnabled === false
        ? false
        : (instance.enabled ?? configEnabled);
    changed = true;
    providerInstances[instanceId] = {
      ...instance,
      enabled: resolved,
      config: restConfig,
    } satisfies ProviderInstanceConfig;
  }
  if (!changed) {
    return settings;
  }
  return {
    ...settings,
    providerInstances: providerInstances as ServerSettings["providerInstances"],
  };
};

const normalizeServerSettings = (
  settings: ServerSettings,
): Effect.Effect<ServerSettings, ServerSettingsError> =>
  encodeServerSettings(settings).pipe(
    Effect.flatMap(decodeServerSettings),
    Effect.map(foldProviderInstanceEnabledFlags),
    Effect.map((next) => withIdleCompaction(next, globalIdleCompaction(next))),
    Effect.map((next) => ({ ...next, ...deriveLegacyProjectOverrides(next) })),
    Effect.mapError(
      (cause) =>
        new ServerSettingsError({
          settingsPath: "<memory>",
          operation: "normalize",
          cause,
        }),
    ),
  );

export function redactServerSettingsForClient(
  settings: ServerSettings,
  client: { readonly secretReferences: boolean },
): ServerSettings {
  const redacted = mapSettingsSecrets(settings, (secret) =>
    secret.sensitive
      ? { value: "", redacted: secret.redacted || secret.value.length > 0 }
      : { value: secret.value, redacted: false },
  );
  // Older clients decode secret fields as strings and fail on a reference, so they see a saved secret.
  const shaped = client.secretReferences
    ? redacted
    : mapSettingsSecretValues(redacted, (value) =>
        isSecretReference(value) ? SECRET_REDACTED : value,
      );
  return {
    ...shaped,
    providerInstances: Object.fromEntries(
      Object.entries(shaped.providerInstances).map(([id, instance]) => [
        id,
        instance.claudeHub && instance.environment
          ? {
              ...instance,
              environment: instance.environment.filter(({ name }) => isClaudeHubVariable(name)),
            }
          : instance,
      ]),
    ),
    secretProviders: withoutUnknownSecretProviderConfigs(shaped),
  };
}

/** A client shown a reference as a saved secret sends that marker back; it keeps the reference. */
function withEchoedSecretReferences(current: ServerSettings, next: ServerSettings): ServerSettings {
  const references = new Map<string, SecretReference>();
  mapSettingsSecretValues(current, (value, secretName) => {
    if (isSecretReference(value)) references.set(secretName, value);
    return value;
  });
  if (references.size === 0) return next;
  return mapSettingsSecretValues(next, (value, secretName) =>
    value === SECRET_REDACTED ? (references.get(secretName) ?? value) : value,
  );
}

// A newer kind's config may hold credentials this build cannot recognize, so it never leaves the server.
function withoutUnknownSecretProviderConfigs(
  settings: ServerSettings,
): ServerSettings["secretProviders"] {
  return Object.fromEntries(
    Object.entries(settings.secretProviders).map(([id, entry]) => {
      if (secretProviderConfigGuards.has(entry.kind)) return [id, entry];
      const { config: _config, ...envelope } = entry;
      return [id, envelope];
    }),
  ) as ServerSettings["secretProviders"];
}

export function applyProviderInstanceMutation(
  settings: ServerSettings,
  mutation: ProviderInstanceMutation,
): ServerSettings {
  const providerInstances = { ...settings.providerInstances };
  if (mutation.operation === "upsert" || mutation.operation === "create") {
    providerInstances[mutation.instanceId] = mutation.instance;
  } else {
    delete providerInstances[mutation.instanceId];
  }
  return { ...settings, providerInstances };
}

interface ClaudeHubSetup {
  readonly sourceId: UsageLimitSourceId;
  readonly sourceUrl: string;
  readonly sourceManagementKey: Redacted.Redacted<UsageLimitSourceConfig["managementKey"]>;
  readonly instanceId: ProviderInstanceId;
  readonly endpoint: string;
  readonly label: string;
  readonly apiKey: Redacted.Redacted<string> | undefined;
  readonly models?: ReadonlyArray<string> | undefined;
}

function isClaudeHubVariable(name: string): boolean {
  return CLAUDE_HUB_MANAGED_ENVIRONMENT_NAMES.has(name.toUpperCase());
}

// Clear inherited credentials and provider switches so only the hub's client key is used.
const claudeHubLaunchDefaults = {
  CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: "1",
  ANTHROPIC_API_KEY: "",
  ANTHROPIC_CUSTOM_HEADERS: "",
  ANTHROPIC_UNIX_SOCKET: "",
  CLAUDE_CODE_HOST_AUTH_ENV_VAR: "",
  CLAUDE_CODE_HOST_CREDS_FILE: "",
  CLAUDE_CODE_OAUTH_TOKEN: "",
  CLAUDE_CODE_USE_ANTHROPIC_AWS: "",
  CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD: "",
  CLAUDE_CODE_USE_BEDROCK: "",
  CLAUDE_CODE_USE_FOUNDRY: "",
  CLAUDE_CODE_USE_GATEWAY: "",
  CLAUDE_CODE_USE_MANTLE: "",
  CLAUDE_CODE_USE_VERTEX: "",
};

const claudeHubLaunchEnvironment = Object.entries(claudeHubLaunchDefaults).map(([name, value]) => ({
  name,
  value,
  sensitive: false,
}));

function isClaudeHubLaunchVariable(name: string): boolean {
  return Object.hasOwn(claudeHubLaunchDefaults, name.toUpperCase());
}

const CLAUDE_DRIVER = ProviderDriverKind.make("claudeAgent");
const DEFAULT_CLAUDE_INSTANCE_ID = defaultInstanceIdForDriver(CLAUDE_DRIVER);

function withEffectiveClaudeHubProviders(
  settings: ServerSettings,
  confirmed?: ReadonlySet<string>,
): ServerSettings {
  const entries = Object.entries(settings.providerInstances);
  if (!entries.some(([, instance]) => instance.claudeHub)) return settings;

  const clean = withoutClaudeHubPreferences(settings);
  const main = clean.providerInstances[DEFAULT_CLAUDE_INSTANCE_ID];
  const config =
    main?.config && typeof main.config === "object" && !Array.isArray(main.config)
      ? main.config
      : {};
  const inheritedEnvironment = main?.environment?.filter(
    ({ name }) => !isClaudeHubVariable(name) && !isClaudeHubLaunchVariable(name),
  );
  const defaultEfforts =
    clean.providerModelPreferences?.[DEFAULT_CLAUDE_INSTANCE_ID]?.defaultEfforts;
  const providerModelPreferences =
    defaultEfforts === undefined ? undefined : { ...clean.providerModelPreferences };
  const favorites = clean.favorites === null ? null : [...clean.favorites];
  const claudeFavorites = favorites?.filter(
    ({ provider }) => provider === DEFAULT_CLAUDE_INSTANCE_ID,
  );
  const providerInstances = { ...clean.providerInstances };
  const visibleHubIds: ProviderInstanceId[] = [];

  for (const [rawId, instance] of entries) {
    const hub = instance.claudeHub;
    if (!hub) continue;
    const source = clean.usageLimitSources[hub.sourceId];
    const id = ProviderInstanceId.make(rawId);
    if (
      !hub.available ||
      !source?.enabled ||
      source.url !== hub.sourceUrl ||
      confirmed?.has(id) === false
    ) {
      delete providerInstances[id];
      continue;
    }
    visibleHubIds.push(id);
    providerInstances[id] = {
      driver: CLAUDE_DRIVER,
      displayName: instance.displayName ?? `Claude (${source.label ?? hub.sourceUrl})`,
      ...(main?.enabled === undefined ? {} : { enabled: main.enabled }),
      ...(main?.accentColor === undefined ? {} : { accentColor: main.accentColor }),
      claudeHub: hub,
      config: { ...config, customModels: [], hubModels: hub.models ?? [] },
      environment: [
        ...(inheritedEnvironment ?? []),
        ...claudeHubLaunchEnvironment,
        ...(instance.environment ?? []).filter(({ name }) => isClaudeHubVariable(name)),
      ],
    };
    if (providerModelPreferences && defaultEfforts) {
      providerModelPreferences[id] = { defaultEfforts, hiddenModels: [], modelOrder: [] };
    }
    if (claudeFavorites) {
      for (const { model } of claudeFavorites) favorites?.push({ provider: id, model });
    }
  }

  return {
    ...clean,
    providerInstances,
    favorites,
    providerModelPreferences: providerModelPreferences ?? clean.providerModelPreferences,
    projectSettingsOverrides: Object.fromEntries(
      Object.entries(clean.projectSettingsOverrides).map(([projectId, entry]) => {
        const inherited = entry.providerInstances?.[DEFAULT_CLAUDE_INSTANCE_ID];
        return [
          projectId,
          inherited && visibleHubIds.length > 0
            ? {
                ...entry,
                providerInstances: {
                  ...entry.providerInstances,
                  ...Object.fromEntries(visibleHubIds.map((id) => [id, inherited])),
                },
              }
            : entry,
        ];
      }),
    ),
  };
}

function withoutClaudeHubPreferences(settings: ServerSettings): ServerSettings {
  const managedIds = new Set(
    Object.entries(settings.providerInstances)
      .filter(([, instance]) => instance.claudeHub)
      .map(([id]) => id),
  );
  const isHub = (id: string) => managedIds.has(id) || isClaudeHubInstanceId(id);
  const withoutHubs = <T>(values: Readonly<Record<string, T>>) =>
    Object.fromEntries(Object.entries(values).filter(([id]) => !isHub(id)));
  return {
    ...settings,
    favorites: settings.favorites?.filter(({ provider }) => !isHub(provider)) ?? null,
    providerModelPreferences:
      settings.providerModelPreferences === null
        ? null
        : withoutHubs(settings.providerModelPreferences),
    projectSettingsOverrides: Object.fromEntries(
      Object.entries(settings.projectSettingsOverrides).map(([id, entry]) => [
        id,
        entry.providerInstances
          ? { ...entry, providerInstances: withoutHubs(entry.providerInstances) }
          : entry,
      ]),
    ),
  };
}

function applySettingsPatch(current: ServerSettings, patch: ServerSettingsPatch): ServerSettings {
  const modelPreferenceProvider = (provider: ProviderInstanceId) =>
    current.providerInstances[provider]?.claudeHub ? DEFAULT_CLAUDE_INSTANCE_ID : provider;
  return applyServerSettingsPatch(current, {
    ...patch,
    ...(patch.setModelFavorites && {
      setModelFavorites: patch.setModelFavorites.map((change) => ({
        ...change,
        provider: modelPreferenceProvider(change.provider),
      })),
    }),
    ...(patch.setModelEffortDefaults && {
      setModelEffortDefaults: patch.setModelEffortDefaults.map((change) => ({
        ...change,
        provider: modelPreferenceProvider(change.provider),
      })),
    }),
  });
}

function preserveClaudeHubProviders(current: ServerSettings, next: ServerSettings): ServerSettings {
  const providerInstances = { ...next.providerInstances };
  for (const [rawId, instance] of Object.entries(providerInstances)) {
    const id = ProviderInstanceId.make(rawId);
    if (isClaudeHubInstanceId(id) && current.providerInstances[id] === undefined) {
      delete providerInstances[id];
    } else if (instance.claudeHub && !current.providerInstances[id]?.claudeHub) {
      const { claudeHub: _claudeHub, ...rest } = instance;
      providerInstances[id] = rest;
    }
  }
  for (const [rawId, stored] of Object.entries(current.providerInstances)) {
    const hub = stored.claudeHub;
    if (!hub) continue;
    const id = ProviderInstanceId.make(rawId);
    const source = next.usageLimitSources[hub.sourceId];
    if (source === undefined) {
      delete providerInstances[id];
      continue;
    }
    const available = hub.available && source.enabled && source.url === hub.sourceUrl;
    providerInstances[id] = {
      driver: CLAUDE_DRIVER,
      ...(stored.displayName === undefined ? {} : { displayName: stored.displayName }),
      claudeHub: { ...hub, available },
      environment: (stored.environment ?? []).filter(
        ({ name }) => isClaudeHubVariable(name) && (available || name !== "ANTHROPIC_AUTH_TOKEN"),
      ),
    };
  }
  return withoutClaudeHubPreferences({ ...next, providerInstances });
}

function applyClaudeHubSetup(
  settings: ServerSettings,
  setup: ClaudeHubSetup,
  currentManagementKey: UsageLimitSourceConfig["managementKey"] | undefined,
  currentInstance: ProviderInstanceConfig | undefined,
): ServerSettings {
  const source = settings.usageLimitSources[setup.sourceId];
  const stored = settings.providerInstances[setup.instanceId];
  if (
    !source?.enabled ||
    source.url !== setup.sourceUrl ||
    !Equal.equals(currentManagementKey, Redacted.value(setup.sourceManagementKey)) ||
    (stored !== undefined && stored.claudeHub?.sourceId !== setup.sourceId)
  ) {
    return settings;
  }
  const apiKey = setup.apiKey === undefined ? undefined : Redacted.value(setup.apiKey);
  const claudeHub = {
    sourceId: setup.sourceId,
    sourceUrl: setup.sourceUrl,
    available: apiKey !== undefined,
    ...(setup.models === undefined ? {} : { models: setup.models }),
  };
  if (apiKey === undefined && (stored === undefined || !stored.claudeHub?.available))
    return settings;
  if (
    currentInstance?.displayName === `Claude (${setup.label})` &&
    Equal.equals(currentInstance.claudeHub, claudeHub) &&
    currentInstance.environment?.find(({ name }) => name === "ANTHROPIC_BASE_URL")?.value ===
      setup.endpoint &&
    currentInstance.environment?.find(({ name }) => name === "ANTHROPIC_AUTH_TOKEN")?.value ===
      apiKey
  )
    return settings;

  return applyProviderInstanceMutation(settings, {
    operation: "upsert",
    instanceId: setup.instanceId,
    instance: {
      driver: CLAUDE_DRIVER,
      displayName: `Claude (${setup.label})`,
      claudeHub,
      environment: [
        { name: "ANTHROPIC_BASE_URL", value: setup.endpoint, sensitive: false },
        ...(apiKey === undefined
          ? []
          : [{ name: "ANTHROPIC_AUTH_TOKEN", value: apiKey, sensitive: true }]),
      ],
    },
  });
}

const secretProviderConfigGuards = new Map(
  secretProviderDefinitions.definitions.map((definition) => [
    definition.kind as string,
    Schema.is(definition.configSchema),
  ]),
);

// Rejects a kind this server has not loaded rather than storing a config it cannot check.
function ensureSecretProviderWritesAllowed(
  patch: ServerSettingsPatch,
  settingsPath: string,
): Effect.Effect<void, ServerSettingsError> {
  for (const [id, entry] of Object.entries(patch.secretProviders ?? {})) {
    if (entry === null) continue;
    const isConfig = secretProviderConfigGuards.get(entry.kind);
    const problem =
      isConfig === undefined
        ? `Unsupported secret provider kind: ${entry.kind}.`
        : isConfig(entry.config)
          ? undefined
          : `Invalid ${entry.kind} config for secret provider ${id}.`;
    if (problem !== undefined) {
      return Effect.fail(
        new ServerSettingsError({
          settingsPath,
          operation: "write-secret-provider",
          cause: new Error(problem),
        }),
      );
    }
  }
  return Effect.void;
}

function ensureProviderInstanceMutationAllowed(
  settings: ServerSettings,
  mutation: ProviderInstanceMutation,
  settingsPath: string,
): Effect.Effect<void, ServerSettingsError> {
  const existing = settings.providerInstances[mutation.instanceId];
  if (
    existing?.claudeHub ||
    (existing === undefined && isClaudeHubInstanceId(mutation.instanceId))
  ) {
    return Effect.fail(
      new ServerSettingsError({
        settingsPath,
        operation: "write-managed-setting",
        managedSetting: `providerInstances.${mutation.instanceId}`,
        managedBy: "CLIProxyAPI",
      }),
    );
  }
  if (
    mutation.operation === "create" &&
    Object.hasOwn(settings.providerInstances, mutation.instanceId)
  ) {
    return Effect.fail(
      new ServerSettingsError({
        settingsPath,
        operation: "create-provider-instance",
        providerInstanceId: mutation.instanceId,
      }),
    );
  }
  return Effect.void;
}

export class ServerSettingsService extends Context.Service<
  ServerSettingsService,
  {
    readonly start: Effect.Effect<void, ServerSettingsError>;

    readonly ready: Effect.Effect<void, ServerSettingsError>;

    /** The administrator's policy as clients see it; absent when unmanaged. */
    readonly managedPolicy?: ManagedPolicySummary | undefined;

    readonly getSettings: Effect.Effect<ServerSettings, ServerSettingsError>;

    readonly updateSettings: (
      patch: ServerSettingsPatch,
    ) => Effect.Effect<ServerSettings, ServerSettingsError>;

    readonly updateProviderInstance: (
      mutation: ProviderInstanceMutation,
      patch?: ServerSettingsPatch,
    ) => Effect.Effect<ServerSettings, ServerSettingsError>;

    readonly configureClaudeFromHub: (
      setup: ClaudeHubSetup,
    ) => Effect.Effect<void, ServerSettingsError>;

    readonly withSettingsSnapshot: <A, E, R>(
      use: (settings: ServerSettings) => Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E | ServerSettingsError, R>;

    readonly streamChanges: Stream.Stream<ServerSettings>;

    /** Subscribe before reading a snapshot to retain changes before lazy stream startup. */
    readonly subscribeChanges: Effect.Effect<Stream.Stream<ServerSettings>, never, Scope.Scope>;
  }
>()("t3/serverSettings/ServerSettingsService") {
  static readonly layerTest = (
    overrides: DeepPartial<ServerSettings> = {},
    managedPolicy?: ManagedPolicySummary,
  ) => layerTest(overrides, managedPolicy);
}

const makeTest = Effect.fn("serverSettings.makeTest")(function* (
  overrides: DeepPartial<ServerSettings> = {},
  managedPolicy?: ManagedPolicySummary,
) {
  const { automaticGitFetchInterval, providerHealthRefreshInterval, ...overridesForMerge } =
    overrides;
  const merged = deepMerge(DEFAULT_SERVER_SETTINGS, overridesForMerge);
  const initialSettings = yield* normalizeServerSettings({
    ...merged,
    ...(automaticGitFetchInterval !== undefined
      ? { automaticGitFetchInterval: automaticGitFetchInterval as Duration.Duration }
      : {}),
    ...(providerHealthRefreshInterval !== undefined
      ? { providerHealthRefreshInterval: providerHealthRefreshInterval as Duration.Duration }
      : {}),
  });
  const currentSettingsRef = yield* Ref.make<ServerSettings>(initialSettings);
  const writeSemaphore = yield* Semaphore.make(1);
  const getSettings = Ref.get(currentSettingsRef).pipe(
    Effect.map((settings) => withEffectiveClaudeHubProviders(settings)),
    Effect.map(resolveTextGenerationProvider),
  );

  const updateTestSettings = (
    update: (current: ServerSettings) => Effect.Effect<ServerSettings, ServerSettingsError>,
    syncClaudeHub = false,
  ): Effect.Effect<ServerSettings, ServerSettingsError> =>
    writeSemaphore.withPermits(1)(
      Ref.get(currentSettingsRef).pipe(
        Effect.flatMap((current) =>
          update(current).pipe(
            Effect.map((next) =>
              syncClaudeHub ? next : preserveClaudeHubProviders(current, next),
            ),
          ),
        ),
        Effect.flatMap(normalizeServerSettings),
        Effect.tap((nextSettings) => Ref.set(currentSettingsRef, nextSettings)),
        Effect.map((settings) => withEffectiveClaudeHubProviders(settings)),
        Effect.map(resolveTextGenerationProvider),
      ),
    );

  return {
    managedPolicy,
    start: Effect.void,
    ready: Effect.void,
    getSettings,
    updateSettings: (patch) =>
      updateTestSettings((currentSettings) =>
        Effect.succeed(applySettingsPatch(currentSettings, patch)),
      ),
    updateProviderInstance: (mutation, patch = {}) =>
      updateTestSettings((currentSettings) =>
        Effect.gen(function* () {
          yield* ensureProviderInstanceMutationAllowed(currentSettings, mutation, "test settings");
          const patched = applySettingsPatch(currentSettings, patch);
          return applyProviderInstanceMutation(patched, mutation);
        }),
      ),
    configureClaudeFromHub: (setup) =>
      updateTestSettings(
        (current) =>
          Effect.succeed(
            applyClaudeHubSetup(
              current,
              setup,
              current.usageLimitSources[setup.sourceId]?.managementKey,
              current.providerInstances[setup.instanceId],
            ),
          ),
        true,
      ).pipe(Effect.asVoid),
    withSettingsSnapshot: (use) =>
      writeSemaphore.withPermits(1)(getSettings.pipe(Effect.flatMap(use))),
    streamChanges: Stream.empty,
    subscribeChanges: Effect.succeed(Stream.empty),
  } satisfies ServerSettingsService["Service"];
});

/** Test settings; `managedPolicy` only tells consumers a policy applies, it does not lock values. */
export const layerTest = (
  overrides: DeepPartial<ServerSettings> = {},
  managedPolicy?: ManagedPolicySummary,
) => Layer.effect(ServerSettingsService, makeTest(overrides, managedPolicy));

// Accept retired token delivery only on load so one old value cannot reset all settings.
const PersistedResponseStreamingMode = Schema.Union([
  ResponseStreamingMode,
  Schema.Literal("token"),
]).pipe(
  Schema.decodeTo(
    ResponseStreamingMode,
    SchemaTransformation.transform({
      decode: (mode) => (mode === "token" ? "paragraph" : mode),
      encode: (mode) => mode,
    }),
  ),
);
const PersistedServerSettings = Schema.Struct({
  ...ServerSettings.fields,
  responseStreamingMode: PersistedResponseStreamingMode.pipe(
    Schema.withDecodingDefault(Effect.succeed("paragraph" as const)),
  ),
  projectSettingsOverrides: Schema.Record(
    ProjectId,
    keepUnknownOverrideKeys(
      Schema.Struct({
        ...ProjectSettingsOverrides.fields,
        responseStreamingMode: Schema.optionalKey(PersistedResponseStreamingMode),
      }),
    ),
  ).pipe(Schema.withDecodingDefault(Effect.succeed({}))),
});
// Parse first and decode second, so a managed policy can fill its defaults in between.
const decodeSettingsFileJsonExit = Schema.decodeUnknownExit(fromLenientJson(Schema.Unknown));
const decodePersistedServerSettingsExit = Schema.decodeUnknownExit(PersistedServerSettings);

/**
 * The settings on disk with the managed policy laid over them, read without the service: no
 * database, no write, no legacy migration. A missing or unreadable file reads as the defaults.
 */
export const readServerSettingsFromDisk = Effect.gen(function* () {
  const { settingsPath } = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const { settings: managed } = yield* ManagedPolicy.ManagedPolicy;
  const raw = yield* fs.readFileString(settingsPath).pipe(Effect.option);
  return managed.applyLocks(
    Option.isNone(raw) ? managed.defaults : decodeSettingsFile(raw.value, managed).settings,
  );
}).pipe(Effect.withSpan("ServerSettings.readServerSettingsFromDisk"));
const LegacyProviderSettingsJson = fromLenientJson(
  Schema.Struct({
    providers: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
    bitbucket: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
    github: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
  }),
);
const decodeLegacyProviderSettingsJsonExit = Schema.decodeUnknownExit(LegacyProviderSettingsJson);

/**
 * A settings file as the server reads it: its settings, or the defaults when the file or its
 * legacy fields are rejected, with the cause. Pure, so the CLI reads files as the server does.
 */
function decodeSettingsFile(
  raw: string,
  managed: ManagedPolicy.ManagedPolicy["Service"]["settings"],
) {
  const parsed = decodeSettingsFileJsonExit(raw);
  const decoded = Exit.isFailure(parsed)
    ? parsed
    : decodePersistedServerSettingsExit(managed.withDefaults(parsed.value));
  const legacy = decodeLegacyProviderSettingsJsonExit(raw);
  const failure = Exit.isFailure(decoded)
    ? decoded.cause
    : Exit.isFailure(legacy)
      ? legacy.cause
      : undefined;
  const settings: ServerSettings =
    Exit.isSuccess(decoded) && failure === undefined
      ? decoded.value
      : // The file may hold an opt-out we can no longer read; never resume threads on a guess.
        {
          ...managed.defaults,
          continueThreadsAfterServerUpdate: false,
          usageHistoryRetentionDays: "unlimited",
        };
  return { settings, legacy: Exit.isSuccess(legacy) ? legacy.value : undefined, failure };
}

const LEGACY_BITBUCKET_SECRET_NAMES: Readonly<Record<string, string>> = {
  accessToken: "bitbucket-access-token",
  apiToken: "bitbucket-api-token",
};
const legacyGitHubTokenSecretName = (host: string) =>
  `github-token-${Buffer.from(host.trim().toLowerCase(), "utf8").toString("base64url")}`;

function migrateLegacySourceControlSettings(
  settings: ServerSettings,
  legacy: {
    readonly bitbucket?: Readonly<Record<string, unknown>> | undefined;
    readonly github?: Readonly<Record<string, unknown>> | undefined;
  },
): {
  readonly settings: ServerSettings;
  readonly secretMoves: ReadonlyArray<{ readonly from: string; readonly to: string }>;
} {
  const sourceControlHosts = { ...settings.sourceControlHosts };
  const secretMoves: Array<{ readonly from: string; readonly to: string }> = [];
  if (legacy.bitbucket !== undefined && sourceControlHosts.bitbucket === undefined) {
    sourceControlHosts.bitbucket = legacy.bitbucket;
    for (const [field, from] of Object.entries(LEGACY_BITBUCKET_SECRET_NAMES)) {
      if (legacy.bitbucket[field] !== SECRET_REDACTED) continue;
      secretMoves.push({
        from,
        to: sourceControlHostSecretName({ kind: "bitbucket", field, serverHost: null }),
      });
    }
  }
  if (legacy.github !== undefined && sourceControlHosts.github === undefined) {
    sourceControlHosts.github = legacy.github;
    for (const [serverHost, value] of readSecretFieldValues(legacy.github.tokens)) {
      if (serverHost === null || value !== SECRET_REDACTED) continue;
      secretMoves.push({
        from: legacyGitHubTokenSecretName(serverHost),
        to: sourceControlHostSecretName({ kind: "github", field: "tokens", serverHost }),
      });
    }
  }
  return { settings: { ...settings, sourceControlHosts }, secretMoves };
}

const HISTORY_RESTORED_DRIVERS: ReadonlySet<ProviderDriverKind> = new Set(
  ["cursor", "grok", "opencode"].map((driver) => ProviderDriverKind.make(driver)),
);

function migrateLegacyProviderSettings(
  settings: ServerSettings,
  legacyProviders: Readonly<Record<string, unknown>>,
  providerHistory: ReadonlyArray<{
    readonly providerName: string;
    readonly providerInstanceId: string | null;
  }>,
): ServerSettings {
  const usedProviders = new Set<string>(providerHistory.map(({ providerName }) => providerName));
  const usedProviderInstances = new Set<string>(
    providerHistory.map(
      ({ providerName, providerInstanceId }) => providerInstanceId ?? providerName,
    ),
  );

  const providerInstances: Record<ProviderInstanceId, ProviderInstanceConfig> = {};
  for (const [instanceId, instance] of Object.entries(settings.providerInstances) as Array<
    [ProviderInstanceId, ProviderInstanceConfig]
  >) {
    providerInstances[instanceId] =
      instance.enabled === undefined &&
      HISTORY_RESTORED_DRIVERS.has(instance.driver) &&
      usedProviderInstances.has(instanceId)
        ? { ...instance, enabled: true }
        : instance;
  }

  const legacyEntries = new Map(Object.entries(legacyProviders));
  for (const driver of HISTORY_RESTORED_DRIVERS) {
    if (!legacyEntries.has(driver)) legacyEntries.set(driver, {});
  }
  for (const [kind, blob] of legacyEntries) {
    if (!isProviderDriverKind(kind) || blob === null || typeof blob !== "object") continue;
    if (Array.isArray(blob)) continue;
    const driver = kind;
    const instanceId = defaultInstanceIdForDriver(driver);
    if (Object.hasOwn(providerInstances, instanceId)) continue;

    const { enabled: rawEnabled, ...config } = blob as Record<string, unknown>;
    const explicitEnabled = typeof rawEnabled === "boolean" ? rawEnabled : undefined;
    const enabled =
      explicitEnabled ??
      (HISTORY_RESTORED_DRIVERS.has(driver) && usedProviders.has(driver) ? true : undefined);
    const driverDefault = resolveProviderInstanceEnabled({ driver, config: {} });
    if (Object.keys(config).length === 0 && (enabled === undefined || enabled === driverDefault)) {
      continue;
    }
    providerInstances[instanceId] = {
      driver,
      ...(enabled === undefined ? {} : { enabled }),
      config,
    } satisfies ProviderInstanceConfig;
  }

  return {
    ...settings,
    providerInstances,
  };
}

const ACP_REGISTRY_DRIVER = ProviderDriverKind.make("acpRegistry");

function selectionSupportsTextGeneration(
  settings: ServerSettings,
  selection: ModelSelection,
): boolean {
  return settings.providerInstances[selection.instanceId]?.driver !== ACP_REGISTRY_DRIVER;
}

type DriverAllowed = (driver: ProviderDriverKind) => boolean;
const anyDriver: DriverAllowed = () => true;

function resolveTextGenerationProvider(
  settings: ServerSettings,
  isDriverAllowed: DriverAllowed = anyDriver,
): ServerSettings {
  const selection = settings.textGenerationModelSelection;
  return isModelSelectionProviderEnabled(settings, selection) &&
    selectionSupportsTextGeneration(settings, selection) &&
    isDriverAllowed(
      settings.providerInstances[selection.instanceId]?.driver ??
        ProviderDriverKind.make(selection.instanceId),
    )
    ? settings
    : fallbackTextGenerationProvider(settings, isDriverAllowed);
}

function fallbackTextGenerationProvider(
  settings: ServerSettings,
  isDriverAllowed: DriverAllowed,
): ServerSettings {
  const fallback = fallbackTextGenerationModelSelection(
    settings.providerInstances,
    (instanceId, driver) =>
      // A default instance id can be configured with another driver.
      isDriverAllowed(settings.providerInstances[instanceId]?.driver ?? driver) &&
      resolveProviderInstanceEnabled(
        settings.providerInstances[instanceId] ?? { driver, config: {} },
      ),
    { defaultModelSelection: settings.defaultModelSelection },
  );
  return fallback === null ? settings : { ...settings, textGenerationModelSelection: fallback };
}

const ATOMIC_SETTINGS_KEYS: ReadonlySet<string> = new Set([
  "backgroundActivity",
  "automaticGitFetchInterval",
  "providerHealthRefreshInterval",
  "sourceControlWriterModelSelection",
  "reviewGuideModelSelection",
  "textGenerationModelSelection",
  "fallbackModelSelection",
  "pullRequestMergeMethod",
  // Empty by default, these hold one whole value, which a managed policy can default.
  ...Object.entries(DEFAULT_SERVER_SETTINGS).flatMap(([key, value]) =>
    value === null ? [key] : [],
  ),
]);

function stripDefaultServerSettings(current: unknown, defaults: unknown): unknown | undefined {
  if (Array.isArray(current) || Array.isArray(defaults)) {
    return Equal.equals(current, defaults) ? undefined : current;
  }

  if (
    current !== null &&
    defaults !== null &&
    typeof current === "object" &&
    typeof defaults === "object"
  ) {
    const currentRecord = current as Record<string, unknown>;
    const defaultsRecord = defaults as Record<string, unknown>;
    const next: Record<string, unknown> = {};

    for (const key of Object.keys(currentRecord)) {
      if (ATOMIC_SETTINGS_KEYS.has(key)) {
        if (!Equal.equals(currentRecord[key], defaultsRecord[key])) {
          next[key] = currentRecord[key];
        }
      } else {
        const stripped = stripDefaultServerSettings(currentRecord[key], defaultsRecord[key]);
        if (stripped !== undefined) {
          next[key] = stripped;
        }
      }
    }

    return Object.keys(next).length > 0 ? next : undefined;
  }

  return Object.is(current, defaults) ? undefined : current;
}

const decodeProjectScriptsJson = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Array(ProjectScript)),
);
const decodeModelSelectionJson = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.NullOr(ModelSelection)),
);

interface LegacyProjectSettingsRow {
  readonly projectId: string;
  readonly defaultModelSelection: string | null;
  readonly defaultThreadEnvMode: string | null;
  readonly autoPull: number;
  readonly scripts: string;
}

// projectSettingsFolded prevents restarts from undoing later UI resets.
function foldLegacyProjectSettings(
  settings: ServerSettings,
  rows: ReadonlyArray<LegacyProjectSettingsRow>,
): ServerSettings {
  if (settings.projectSettingsFolded) return settings;
  if (
    rows.length === 0 &&
    Object.keys(settings.projectAgentBrowserAccessOverrides).length === 0 &&
    Object.keys(settings.projectAutoPullOverrides).length === 0 &&
    Object.keys(settings.projectScriptOverrides).length === 0
  ) {
    return settings;
  }
  const entries: Record<string, ProjectSettingsOverrides> = {
    ...settings.projectSettingsOverrides,
  };
  const set = <K extends keyof ProjectSettingsOverrides>(
    projectId: string,
    key: K,
    value: ProjectSettingsOverrides[K] | undefined,
  ) => {
    if (value === undefined) return;
    const entry = entries[projectId] ?? {};
    if (Object.hasOwn(entry, key)) return;
    entries[projectId] = { ...entry, [key]: value };
  };
  for (const [projectId, value] of Object.entries(settings.projectAgentBrowserAccessOverrides)) {
    set(projectId, "enableAgentBrowserAccess", value);
  }
  for (const [projectId, value] of Object.entries(settings.projectAutoPullOverrides)) {
    set(projectId, "defaultAutoPull", value);
  }
  // A stored null resets to machine defaults, so the project's aggregate scripts must not resurface.
  const resetScripts = new Set<string>();
  for (const [projectId, value] of Object.entries(settings.projectScriptOverrides)) {
    if (value === null) resetScripts.add(projectId);
    else set(projectId, "defaultProjectScripts", value);
  }
  for (const row of rows) {
    const model = decodeModelSelectionJson(row.defaultModelSelection ?? "null");
    if (Option.isSome(model) && model.value !== null) {
      set(row.projectId, "defaultModelSelection", model.value);
    }
    if (row.defaultThreadEnvMode === "local" || row.defaultThreadEnvMode === "worktree") {
      set(row.projectId, "defaultThreadEnvMode", row.defaultThreadEnvMode);
    }
    if (row.autoPull === 1) set(row.projectId, "defaultAutoPull", true);
    const scripts = decodeProjectScriptsJson(row.scripts);
    if (Option.isSome(scripts) && scripts.value.length > 0 && !resetScripts.has(row.projectId)) {
      set(row.projectId, "defaultProjectScripts", scripts.value);
    }
  }
  const projectSettingsOverrides = Object.fromEntries(
    Object.entries(entries).filter(([, entry]) => Object.keys(entry).length > 0),
  );
  return {
    ...settings,
    projectSettingsOverrides,
    projectSettingsFolded: true,
    ...deriveLegacyProjectOverrides({ projectSettingsOverrides }),
  };
}

const make = Effect.gen(function* () {
  const { settingsPath } = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const pathService = yield* Path.Path;
  const secretStore = yield* ServerSecretStore.ServerSecretStore;
  const sql = yield* SqlClient.SqlClient;
  const {
    settings: managed,
    providers: managedProviders,
    summary: managedPolicy,
  } = yield* ManagedPolicy.ManagedPolicy;
  const confirmedClaudeHubs = new Set<ProviderInstanceId>();
  // Locks are laid over every settings value that leaves this service, never persisted.
  const toEffective = (settings: ServerSettings) =>
    resolveTextGenerationProvider(
      managedProviders.applyLimits(
        withEffectiveClaudeHubProviders(managed.applyLocks(settings), confirmedClaudeHubs),
      ),
      managedProviders.isDriverAllowed,
    );
  const writeSemaphore = yield* Semaphore.make(1);
  const cacheKey = "settings" as const;
  const changesPubSub = yield* PubSub.unbounded<ServerSettings>();
  const startedRef = yield* Ref.make(false);
  const startedDeferred = yield* Deferred.make<void, ServerSettingsError>();
  const watcherScope = yield* Scope.make("sequential");
  yield* Effect.addFinalizer(() => Scope.close(watcherScope, Exit.void));

  const emitChange = (settings: ServerSettings) =>
    PubSub.publish(changesPubSub, settings).pipe(Effect.asVoid);

  const readConfigExists = fs.exists(settingsPath).pipe(
    Effect.mapError(
      (cause) =>
        new ServerSettingsError({
          settingsPath,
          operation: "check-exists",
          cause,
        }),
    ),
  );

  const readRawConfig = fs.readFileString(settingsPath).pipe(
    Effect.mapError(
      (cause) =>
        new ServerSettingsError({
          settingsPath,
          operation: "read-file",
          cause,
        }),
    ),
  );

  // The file before this write, parsed; only read when policy defaults need it.
  const readStoredSettings = Effect.gen(function* () {
    if (!(yield* readConfigExists)) return undefined;
    const parsed = decodeSettingsFileJsonExit(yield* readRawConfig);
    return Exit.isSuccess(parsed) ? parsed.value : undefined;
  });

  const writeSettingsAtomically = Effect.fnUntraced(
    function* (settings: ServerSettings) {
      const stripped = stripDefaultServerSettings(settings, managed.defaults) ?? {};
      const sparseSettingsJson = yield* encodeServerSettingsJson(
        managed.keepStored === undefined
          ? stripped
          : managed.keepStored(stripped, settings, yield* readStoredSettings, (key) =>
              ATOMIC_SETTINGS_KEYS.has(key),
            ),
      );

      return yield* writeFileStringAtomically({
        filePath: settingsPath,
        contents: `${sparseSettingsJson}\n`,
      }).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, pathService),
      );
    },
    Effect.mapError(
      (cause) =>
        new ServerSettingsError({
          settingsPath,
          operation: "write-file",
          cause,
        }),
    ),
  );

  const moveInlineSettingsSecrets = Effect.fn("serverSettings.moveInlineSettingsSecrets")(
    function* (settings: ServerSettings) {
      const pending: SettingsSecret[] = [];
      mapSettingsSecrets(settings, (secret) => {
        if (secret.kind === "field" && !secret.redacted && secret.value.length > 0) {
          pending.push(secret);
        }
        return secret;
      });
      const moved = new Set<string>();
      for (const secret of pending) {
        const stored = yield* secretStore
          .set(secret.secretName, textEncoder.encode(secret.value))
          .pipe(
            Effect.as(true),
            Effect.catch(() =>
              Effect.logWarning("failed to move a settings secret into the secret store").pipe(
                Effect.as(false),
              ),
            ),
          );
        if (stored) moved.add(secret.secretName);
      }
      if (moved.size === 0) return settings;
      return mapSettingsSecrets(settings, (secret) =>
        moved.has(secret.secretName) ? { value: "", redacted: true } : secret,
      );
    },
  );

  const loadSettingsFromDisk = Effect.gen(function* () {
    let settings = managed.defaults;
    let legacyProviders: Readonly<Record<string, unknown>> | undefined;
    let legacySourceControl: Parameters<typeof migrateLegacySourceControlSettings>[1] = {};
    let parseFailure = Option.none<unknown>();

    if (yield* readConfigExists) {
      const file = decodeSettingsFile(yield* readRawConfig, managed);
      if (file.legacy !== undefined) {
        legacyProviders = file.legacy.providers;
        legacySourceControl = { bitbucket: file.legacy.bitbucket, github: file.legacy.github };
      }
      settings = file.settings;
      if (file.failure !== undefined) {
        parseFailure = Option.some(Cause.squash(file.failure));
        yield* Effect.logWarning("failed to parse settings.json, using defaults", {
          path: settingsPath,
          issues: Cause.pretty(file.failure),
          cause: file.failure,
        });
      }
    }
    // Settings saved by a server that kept the mode in `compactIdleThreads` move
    // it to `idleCompaction`, so that switch goes to clients as a boolean. The
    // defaults gain the field too, which tells clients this server reads modes.
    settings = withIdleCompaction(settings, globalIdleCompaction(settings));

    // A file that failed to decode must stay on disk for the user to repair.
    const settingsFileTrusted = Option.isNone(parseFailure);
    const providerHistory = yield* sql<{
      readonly providerName: string;
      readonly providerInstanceId: string | null;
    }>`
      SELECT DISTINCT
        provider_name AS "providerName",
        provider_instance_id AS "providerInstanceId"
      FROM projection_thread_sessions
      WHERE provider_name IN ('cursor', 'grok', 'opencode')
      UNION
      SELECT DISTINCT
        provider_name AS "providerName",
        provider_instance_id AS "providerInstanceId"
      FROM provider_session_runtime
      WHERE provider_name IN ('cursor', 'grok', 'opencode')
    `.pipe(
      NodeSqliteClient.readOnly,
      Effect.mapError(
        (cause) =>
          new ServerSettingsError({
            settingsPath,
            operation: "read-provider-history",
            cause,
          }),
      ),
    );

    const legacyProjectRows =
      settings.projectSettingsFolded || !settingsFileTrusted
        ? []
        : yield* sql<LegacyProjectSettingsRow>`
          SELECT
            project_id AS "projectId",
            default_model_selection_json AS "defaultModelSelection",
            default_thread_env_mode AS "defaultThreadEnvMode",
            auto_pull AS "autoPull",
            scripts_json AS "scripts"
          FROM projection_projects
          WHERE deleted_at IS NULL
        `.pipe(
            NodeSqliteClient.readOnly,
            Effect.mapError(
              (cause) =>
                new ServerSettingsError({
                  settingsPath,
                  operation: "read-project-settings",
                  cause,
                }),
            ),
          );

    const loaded = foldProviderInstanceEnabledFlags(
      legacyProviders === undefined
        ? settings
        : migrateLegacyProviderSettings(settings, legacyProviders, providerHistory),
    );
    const folded = settingsFileTrusted
      ? foldLegacyProjectSettings(loaded, legacyProjectRows)
      : loaded;
    // Remove retired keys only after copying secrets and writing the new file; failures retry on next load.
    const legacySecretsCopied = yield* Effect.forEach(
      settingsFileTrusted
        ? migrateLegacySourceControlSettings(folded, legacySourceControl).secretMoves
        : [],
      (move) =>
        secretStore.get(move.from).pipe(
          Effect.flatMap((secret) =>
            Option.isNone(secret) ? Effect.void : secretStore.set(move.to, secret.value),
          ),
          Effect.as(true),
          Effect.catch(() =>
            Effect.logWarning("failed to copy a source control secret to its new name", {
              secretName: move.to,
            }).pipe(Effect.as(false)),
          ),
        ),
    ).pipe(Effect.map((copied) => copied.every(Boolean)));
    const hasLegacySourceControl =
      settingsFileTrusted &&
      legacySecretsCopied &&
      (legacySourceControl.bitbucket !== undefined || legacySourceControl.github !== undefined);
    const sourceControlMigration = hasLegacySourceControl
      ? migrateLegacySourceControlSettings(folded, legacySourceControl)
      : { settings: folded, secretMoves: [] };
    const migrated = settingsFileTrusted
      ? yield* moveInlineSettingsSecrets(sourceControlMigration.settings)
      : folded;
    if (
      migrated !== loaded ||
      (settingsFileTrusted && legacyProviders !== undefined) ||
      hasLegacySourceControl
    ) {
      yield* writeSettingsAtomically(migrated);
      for (const move of sourceControlMigration.secretMoves) {
        yield* secretStore.remove(move.from).pipe(Effect.ignore);
      }
    }
    return { settings: migrated, parseFailure };
  });

  const settingsCache = yield* Cache.makeWith((_key: typeof cacheKey) => loadSettingsFromDisk, {
    capacity: 1,
    timeToLive: (exit) => (Exit.isSuccess(exit) ? Duration.infinity : Duration.zero),
  });

  const getSettingsFromCache = Cache.get(settingsCache, cacheKey).pipe(
    Effect.map((loaded) => loaded.settings),
  );
  const reloadSettings = Cache.invalidate(settingsCache, cacheKey).pipe(
    Effect.andThen(Cache.get(settingsCache, cacheKey)),
  );

  const materializeSettingsSecrets = Effect.fn("serverSettings.materializeSettingsSecrets")(
    function* (settings: ServerSettings): Effect.fn.Return<ServerSettings, ServerSettingsError> {
      const storedSecrets = new Map<string, string>();
      const pending = new Map<string, SettingsSecret>();
      mapSettingsSecrets(settings, (secret) => {
        if (secret.sensitive && secret.redacted) pending.set(secret.secretName, secret);
        return secret;
      });
      for (const secret of pending.values()) {
        const value = yield* secretStore.get(secret.secretName).pipe(
          Effect.mapError(
            (cause) =>
              new ServerSettingsError({
                settingsPath,
                operation: "read-secret",
                providerInstanceId: secret.providerInstanceId,
                environmentVariable: secret.environmentVariable,
                cause,
              }),
          ),
        );
        storedSecrets.set(
          secret.secretName,
          Option.isSome(value) ? textDecoder.decode(value.value) : "",
        );
      }
      return mapSettingsSecrets(settings, (secret) => ({
        value:
          secret.sensitive && secret.redacted
            ? (storedSecrets.get(secret.secretName) ?? "")
            : secret.value,
        redacted: secret.sensitive && secret.kind === "environment" && secret.redacted,
      }));
    },
  );

  // Background sweeps read settings every few seconds; reading secret files each time is wasted.
  // Every secret write rewrites the settings file, so a new cached object implies fresh secrets.
  // A read that overlaps a secret write may see files a rollback then restores, so it is not kept.
  let materialized: { readonly source: ServerSettings; readonly value: ServerSettings } | null =
    null;
  let secretWriteGeneration = 0;
  const invalidateMaterialized = Effect.sync(() => {
    secretWriteGeneration++;
    materialized = null;
  });
  const getMaterializedSettings = getSettingsFromCache.pipe(
    Effect.flatMap((source) => {
      if (materialized?.source === source) return Effect.succeed(materialized.value);
      const generation = secretWriteGeneration;
      return materializeSettingsSecrets(source).pipe(
        Effect.map(toEffective),
        Effect.tap((value) =>
          Effect.sync(() => {
            if (generation === secretWriteGeneration) materialized = { source, value };
          }),
        ),
      );
    }),
  );

  const materializeChanges = (changes: Stream.Stream<ServerSettings>) =>
    changes.pipe(
      Stream.mapEffect((settings) =>
        materializeSettingsSecrets(settings).pipe(
          Effect.catch((error: ServerSettingsError) =>
            Effect.logWarning("failed to materialize settings secrets", {
              operation: error.operation,
              providerInstanceId: error.providerInstanceId,
              environmentVariable: error.environmentVariable,
              cause: error.cause,
            }).pipe(Effect.as(settings)),
          ),
        ),
      ),
      Stream.map(toEffective),
    );

  type SecretChange = {
    readonly secretName: string;
    readonly providerInstanceId?: string;
    readonly environmentVariable?: string;
  } & (
    | { readonly kind: "write"; readonly value: Uint8Array }
    | { readonly kind: "remove"; readonly operation: "remove-secret" | "remove-stale-secret" }
  );

  const persistSettingsSecrets = (current: ServerSettings, next: ServerSettings) =>
    Effect.sync(() => {
      // Only sensitive rows own a stored secret; a plain duplicate must not hide one from cleanup.
      const previous = new Map<string, SettingsSecret>();
      const inlineValues = new Map<string, string>();
      mapSettingsSecrets(current, (secret) => {
        if (!secret.sensitive) return secret;
        previous.set(secret.secretName, secret);
        if (!secret.redacted && secret.value.length > 0) {
          inlineValues.set(secret.secretName, secret.value);
        }
        return secret;
      });
      const changes: SecretChange[] = [];
      const nextSecretNames = new Set<string>();
      const keptSecretNames = new Set<string>();
      const writtenSecretNames = new Set<string>();
      const inlineWrites = new Map<string, SecretChange>();
      const settings = mapSettingsSecrets(withEchoedSecretReferences(current, next), (secret) => {
        const metadata = {
          secretName: secret.secretName,
          ...(secret.providerInstanceId !== undefined
            ? { providerInstanceId: secret.providerInstanceId }
            : {}),
          ...(secret.environmentVariable !== undefined
            ? { environmentVariable: secret.environmentVariable }
            : {}),
        };
        if (!secret.sensitive) {
          changes.push({ ...metadata, kind: "remove", operation: "remove-secret" });
          return { value: secret.value, redacted: false };
        }
        if (secret.redacted) {
          keptSecretNames.add(secret.secretName);
          nextSecretNames.add(secret.secretName);
          const inlineValue = inlineValues.get(secret.secretName);
          if (inlineValue !== undefined) {
            inlineWrites.set(secret.secretName, {
              ...metadata,
              kind: "write",
              value: textEncoder.encode(inlineValue),
            });
          }
          return { value: "", redacted: true };
        }
        if (secret.value.length === 0) {
          changes.push({ ...metadata, kind: "remove", operation: "remove-secret" });
          return { value: "", redacted: false };
        }
        nextSecretNames.add(secret.secretName);
        writtenSecretNames.add(secret.secretName);
        changes.push({ ...metadata, kind: "write", value: textEncoder.encode(secret.value) });
        return { value: "", redacted: true };
      });
      // A legacy inline value only moves to the store when no row in this save replaces it.
      for (const [secretName, change] of inlineWrites) {
        if (!writtenSecretNames.has(secretName)) changes.push(change);
      }
      for (const secret of previous.values()) {
        if (nextSecretNames.has(secret.secretName)) continue;
        if (changes.some((change) => change.secretName === secret.secretName)) continue;
        changes.push({
          kind: "remove",
          secretName: secret.secretName,
          operation: "remove-stale-secret",
          ...(secret.providerInstanceId !== undefined
            ? { providerInstanceId: secret.providerInstanceId }
            : {}),
          ...(secret.environmentVariable !== undefined
            ? { environmentVariable: secret.environmentVariable }
            : {}),
        });
      }
      return {
        settings,
        // A redacted row still claims its stored secret, so a duplicate row must not remove it.
        changes: changes.filter(
          (change) => change.kind === "write" || !keptSecretNames.has(change.secretName),
        ),
      };
    });

  const rollbackSettingsSecretWrites = (
    writes: ReadonlyArray<{
      readonly secretName: string;
      readonly previousValue: Option.Option<Uint8Array>;
      readonly providerInstanceId?: string;
      readonly environmentVariable?: string;
    }>,
  ) =>
    Effect.forEach(
      writes.toReversed(),
      (write) =>
        (Option.isSome(write.previousValue)
          ? secretStore.set(write.secretName, write.previousValue.value)
          : secretStore.remove(write.secretName)
        ).pipe(
          Effect.catch((cause) =>
            Effect.logWarning("failed to roll back settings secret", {
              providerInstanceId: write.providerInstanceId,
              environmentVariable: write.environmentVariable,
              cause,
            }),
          ),
        ),
      { discard: true },
    );

  const applySettingsSecretChanges = (changes: ReadonlyArray<SecretChange>) => {
    const applied: Array<{
      readonly secretName: string;
      readonly previousValue: Option.Option<Uint8Array>;
      readonly providerInstanceId?: string;
      readonly environmentVariable?: string;
    }> = [];
    const rollback = Effect.suspend(() => rollbackSettingsSecretWrites(applied));
    return Effect.forEach(
      changes,
      (change) =>
        Effect.gen(function* () {
          const previousValue = yield* secretStore.get(change.secretName).pipe(
            Effect.mapError(
              (cause) =>
                new ServerSettingsError({
                  settingsPath,
                  operation: "read-secret",
                  providerInstanceId: change.providerInstanceId,
                  environmentVariable: change.environmentVariable,
                  cause,
                }),
            ),
          );
          // A store operation may mutate before reporting an error (for example chmod after rename).
          applied.push({ ...change, previousValue });
          yield* (
            change.kind === "write"
              ? secretStore.set(change.secretName, change.value)
              : secretStore.remove(change.secretName)
          ).pipe(
            Effect.mapError(
              (cause) =>
                new ServerSettingsError({
                  settingsPath,
                  operation: change.kind === "write" ? "write-secret" : change.operation,
                  providerInstanceId: change.providerInstanceId,
                  environmentVariable: change.environmentVariable,
                  cause,
                }),
            ),
          );
        }),
      { discard: true },
    ).pipe(
      Effect.tapError(() => rollback),
      Effect.as(rollback),
    );
  };

  const updateAndPersistSettings = (
    patch: ServerSettingsPatch,
    update: (current: ServerSettings) => Effect.Effect<ServerSettings, ServerSettingsError>,
    syncedClaudeHub?: ProviderInstanceId,
  ): Effect.Effect<ServerSettings, ServerSettingsError> =>
    writeSemaphore.withPermits(1)(
      Effect.gen(function* () {
        const { settings: current, parseFailure } = yield* reloadSettings;
        if (Option.isSome(parseFailure)) {
          return yield* new ServerSettingsError({
            settingsPath,
            operation: "read-file",
            cause: parseFailure.value,
          });
        }
        // An older client echoes a reference as the redacted marker; restore it before vetting so
        // a removed provider's reference is cleared below rather than restored by persistence.
        const proposed = yield* update(current);
        if (proposed === current) return yield* getMaterializedSettings;
        const updated = withoutRedirectedSimlockTokens(
          current,
          withEchoedSecretReferences(
            current,
            syncedClaudeHub === undefined
              ? preserveClaudeHubProviders(current, proposed)
              : proposed,
          ),
        );
        // Vet before secrets: a variable the policy hides from clients is not one they removed.
        const vetted = managed.vetWrite(current, yield* normalizeServerSettings(updated), patch);
        if (vetted._tag === "Locked") {
          return yield* new ServerSettingsError({
            settingsPath,
            operation: "write-managed-setting",
            managedSetting: vetted.path,
            managedBy: managedPolicy?.organization,
          });
        }
        const vettedProviders = managedProviders.vetWrite(current, vetted.settings);
        if (vettedProviders._tag === "Locked") {
          return yield* new ServerSettingsError({
            settingsPath,
            operation: "write-managed-setting",
            managedSetting: vettedProviders.path,
            managedBy: managedPolicy?.organization,
          });
        }
        if (vettedProviders._tag === "Disallowed") {
          return yield* new ServerSettingsError({
            settingsPath,
            operation: "use-disallowed-provider",
            providerInstanceId: vettedProviders.instanceId,
            providerLabel: vettedProviders.label,
            managedBy: managedPolicy?.organization,
          });
        }
        // After vetting, which can keep stored variables a policy hides from clients.
        const persisted = yield* persistSettingsSecrets(
          current,
          withoutRemovedSecretProviderReferences(current, vettedProviders.settings),
        );
        const next = yield* normalizeServerSettings(persisted.settings);
        const materializedNext = yield* Effect.uninterruptibleMask(() =>
          Effect.gen(function* () {
            yield* invalidateMaterialized;
            const rollbackSecretChanges = yield* applySettingsSecretChanges(persisted.changes);
            const materializedExit = yield* Effect.exit(materializeSettingsSecrets(next));
            if (Exit.isFailure(materializedExit)) {
              yield* rollbackSecretChanges;
              return yield* Effect.failCause(materializedExit.cause);
            }
            const writeExit = yield* Effect.exit(writeSettingsAtomically(next));
            if (Exit.isFailure(writeExit)) {
              yield* rollbackSecretChanges;
              return yield* Effect.failCause(writeExit.cause);
            }
            return materializedExit.value;
          }).pipe(Effect.ensuring(invalidateMaterialized)),
        );
        yield* Cache.set(settingsCache, cacheKey, { settings: next, parseFailure: Option.none() });
        if (
          syncedClaudeHub !== undefined &&
          next.providerInstances[syncedClaudeHub]?.claudeHub?.available
        ) {
          confirmedClaudeHubs.add(syncedClaudeHub);
        }
        for (const id of confirmedClaudeHubs) {
          if (!next.providerInstances[id]?.claudeHub?.available) confirmedClaudeHubs.delete(id);
        }
        const resolved = toEffective(materializedNext);
        materialized = { source: next, value: resolved };
        yield* emitChange(next);
        return resolved;
      }),
    );

  const withSettingsSnapshot: ServerSettingsService["Service"]["withSettingsSnapshot"] = (use) =>
    writeSemaphore.withPermits(1)(getMaterializedSettings.pipe(Effect.flatMap(use)));

  const revalidateAndEmit = writeSemaphore.withPermits(1)(
    Effect.gen(function* () {
      const { settings } = yield* reloadSettings;
      yield* emitChange(settings);
    }),
  );

  // `ready` completes once the watch is registered, or once it fails to be.
  const watchFileChanges = (filePath: string, ready: Deferred.Deferred<void>) => {
    const directory = pathService.dirname(filePath);
    const fileName = pathService.basename(filePath);
    const resolvedFilePath = pathService.resolve(filePath);
    const markReady = () => Deferred.doneUnsafe(ready, Exit.void);
    return fs.watch(directory, { onReady: markReady }).pipe(
      Stream.filter(
        (event) =>
          event.path === fileName ||
          event.path === filePath ||
          pathService.resolve(directory, event.path) === resolvedFilePath,
      ),
      Stream.as(undefined),
      Stream.ensuring(Effect.sync(markReady)),
    );
  };

  // A directory watch follows the directory's inode, so when the target's
  // directory is renamed away and another takes its path, watch the new one.
  const watchLinkTargetChanges = (linkTargetPath: string, ready: Deferred.Deferred<void>) =>
    watchDirectoryReplacements(
      (parentReady) => watchFileChanges(pathService.dirname(linkTargetPath), parentReady),
      Stream.unwrap(
        Effect.gen(function* () {
          const registered = yield* Deferred.make<void>();
          return Stream.merge(
            watchFileChanges(linkTargetPath, registered).pipe(Stream.ignoreCause({ log: true })),
            // Startup reloads once ready. Later watches trigger their own reload.
            Stream.fromEffect(
              Deferred.await(registered).pipe(Effect.andThen(Deferred.succeed(ready, undefined))),
            ).pipe(
              Stream.filter((completedStartup) => !completedStartup),
              Stream.as(undefined),
            ),
          );
        }),
      ),
    );

  const startWatcher = Effect.gen(function* () {
    const settingsDir = pathService.dirname(settingsPath);

    yield* fs.makeDirectory(settingsDir, { recursive: true }).pipe(
      Effect.mapError(
        (cause) =>
          new ServerSettingsError({
            settingsPath,
            operation: "prepare-directory",
            cause,
          }),
      ),
    );

    const revalidateAndEmitSafely = revalidateAndEmit.pipe(Effect.ignoreCause({ log: true }));

    // Watch symlink targets' directories for rewrites; re-resolve link changes to follow repointing.
    const watchLinkTarget = Effect.gen(function* () {
      const linkTargetPath = yield* resolveSymlinkTarget(settingsPath).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, pathService),
      );
      if (linkTargetPath === pathService.resolve(settingsPath)) {
        return Option.none<string>();
      }
      yield* fs
        .makeDirectory(pathService.dirname(linkTargetPath), { recursive: true })
        .pipe(Effect.ignore({ log: true }));
      return Option.some(linkTargetPath);
    }).pipe(Effect.orElseSucceed(() => Option.none<string>()));

    const settingsReady = yield* Deferred.make<void>();
    const linkTargetReady = yield* Deferred.make<void>();
    yield* Effect.gen(function* () {
      const [settingsEvents, resolveEvents] = yield* watchFileChanges(
        settingsPath,
        settingsReady,
      ).pipe(
        Stream.ignoreCause({ log: true }),
        Stream.broadcastN({ n: 2, capacity: 1, strategy: "sliding" }),
      );
      // Buffer settings path changes while resolving the first target.
      const linkTargetEvents = Stream.fromEffect(
        Deferred.await(settingsReady).pipe(Effect.andThen(watchLinkTarget)),
      ).pipe(
        Stream.concat(resolveEvents.pipe(Stream.mapEffect(() => watchLinkTarget))),
        Stream.changes,
        Stream.switchMap(
          Option.match({
            onNone: () =>
              Stream.fromEffect(Deferred.succeed(linkTargetReady, undefined)).pipe(Stream.drain),
            onSome: (linkTargetPath) => watchLinkTargetChanges(linkTargetPath, linkTargetReady),
          }),
        ),
      );

      // Saves emit multiple events; fs.watch may fire before content is flushed.
      yield* Stream.merge(settingsEvents, linkTargetEvents).pipe(
        Stream.debounce(Duration.millis(100)),
        Stream.runForEach(() => revalidateAndEmitSafely),
      );
    }).pipe(
      Effect.scoped,
      Effect.ignoreCause({ log: true }),
      Effect.ensuring(Deferred.succeed(linkTargetReady, undefined)),
      Effect.forkIn(watcherScope),
    );
    // Edits made once `start` returns must reach a registered watch.
    yield* Deferred.await(linkTargetReady);
  });

  const start = Effect.gen(function* () {
    const shouldStart = yield* Ref.modify(startedRef, (started) => [!started, true]);
    if (!shouldStart) {
      return yield* Deferred.await(startedDeferred);
    }

    const startup = Effect.gen(function* () {
      yield* startWatcher;
      yield* reloadSettings;
    });

    const startupExit = yield* Effect.exit(startup);
    if (startupExit._tag === "Failure") {
      yield* Deferred.failCause(startedDeferred, startupExit.cause).pipe(Effect.orDie);
      return yield* Effect.failCause(startupExit.cause);
    }

    yield* Deferred.succeed(startedDeferred, undefined).pipe(Effect.orDie);
  });

  return {
    managedPolicy,
    start,
    ready: Deferred.await(startedDeferred),
    getSettings: getMaterializedSettings,
    updateSettings: (patch) =>
      updateAndPersistSettings(patch, (current) =>
        ensureSecretProviderWritesAllowed(patch, settingsPath).pipe(
          Effect.as(applySettingsPatch(current, patch)),
        ),
      ),
    updateProviderInstance: (mutation, patch = {}) =>
      updateAndPersistSettings(patch, (current) =>
        Effect.gen(function* () {
          yield* ensureSecretProviderWritesAllowed(patch, settingsPath);
          yield* ensureProviderInstanceMutationAllowed(current, mutation, settingsPath);
          const patched = applySettingsPatch(current, patch);
          return applyProviderInstanceMutation(patched, mutation);
        }),
      ),
    configureClaudeFromHub: (setup) =>
      updateAndPersistSettings(
        {},
        (current) =>
          getMaterializedSettings.pipe(
            Effect.map(({ usageLimitSources, providerInstances }) =>
              applyClaudeHubSetup(
                current,
                setup,
                usageLimitSources[setup.sourceId]?.managementKey,
                providerInstances[setup.instanceId],
              ),
            ),
          ),
        setup.instanceId,
      ).pipe(Effect.asVoid),
    withSettingsSnapshot,
    get streamChanges() {
      return materializeChanges(Stream.fromPubSub(changesPubSub));
    },
    get subscribeChanges() {
      return PubSub.subscribe(changesPubSub).pipe(
        Effect.map((subscription) => materializeChanges(Stream.fromSubscription(subscription))),
      );
    },
  } satisfies ServerSettingsService["Service"];
});

export const layer = Layer.effect(ServerSettingsService, make);
