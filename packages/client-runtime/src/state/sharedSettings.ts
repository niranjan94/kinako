import {
  type AuthEnvironmentScope,
  type EnvironmentId,
  requiredScopesForServerSettingsPatch,
  type ModelPreferences,
  ProviderDriverKind,
  type ProviderInstanceConfig,
  type ProviderInstanceId,
  type ServerSettings,
  type ServerSettingsPatch,
} from "@t3tools/contracts";
import { readCustomModelEntries, toCustomModelSetting } from "@t3tools/shared/model";
import { isModelSelectionProviderEnabled } from "@t3tools/shared/serverSettings";
import * as Struct from "effect/Struct";

import type { EnvironmentConnectionPhase } from "../connection/presentation.ts";

const SHARED_SERVER_SETTING_KEYS = [
  "continueThreadsAfterServerUpdate",
  "sidebarAutoSettleAfterDays",
  "sidebarAutoSettleOnMerge",
  "autoResumeLimitedThreads",
  "snoozeLimitedThreads",
  "snoozePresets",
  "newWorktreesStartFromOrigin",
  "sourceControlWritingStyle",
  "textGenerationModelSelection",
] as const satisfies ReadonlyArray<keyof ServerSettings & keyof ServerSettingsPatch>;

const SHARED_KEY_SET = new Set<string>(SHARED_SERVER_SETTING_KEYS);

export function splitSharedServerPatch(patch: ServerSettingsPatch): {
  sharedPatch: ServerSettingsPatch;
  localPatch: ServerSettingsPatch;
} {
  const sharedPatch: Record<string, unknown> = {};
  const localPatch: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(patch)) {
    if (SHARED_KEY_SET.has(key)) {
      sharedPatch[key] = value;
    } else {
      localPatch[key] = value;
    }
  }
  return {
    sharedPatch: sharedPatch as ServerSettingsPatch,
    localPatch: localPatch as ServerSettingsPatch,
  };
}

export function filterSharedServerPatch(
  patch: ServerSettingsPatch,
  settings?: ServerSettings,
  sourceSettings = settings,
  targetIsSource = false,
): ServerSettingsPatch {
  const instanceId =
    patch.textGenerationModelSelection?.instanceId ??
    sourceSettings?.textGenerationModelSelection.instanceId;
  if (
    !targetIsSource &&
    patch.textGenerationModelSelection &&
    (!settings ||
      (instanceId !== undefined &&
        (sourceSettings?.providerInstances[instanceId]?.driver ?? instanceId) !==
          (settings.providerInstances[instanceId]?.driver ?? instanceId)) ||
      !isModelSelectionProviderEnabled(settings, {
        ...settings.textGenerationModelSelection,
        ...patch.textGenerationModelSelection,
      }))
  ) {
    patch = Struct.omit(patch, ["textGenerationModelSelection"]);
  }
  return settings ? patch : Struct.omit(patch, ["continueThreadsAfterServerUpdate"]);
}

export function supportsSharedSettingsSync(environment: {
  readonly connection: { readonly phase: EnvironmentConnectionPhase };
  readonly serverConfig: object | null;
}): boolean {
  return environment.connection.phase === "connected" && environment.serverConfig !== null;
}

type ProviderInstances = Pick<ServerSettings, "providerInstances">;

/** An unconfigured default slot is named after its driver. */
function instanceDriver(
  settings: ProviderInstances,
  instanceId: ProviderInstanceId,
): ProviderDriverKind {
  const instance = Object.hasOwn(settings.providerInstances, instanceId)
    ? settings.providerInstances[instanceId]
    : undefined;
  return instance?.driver ?? ProviderDriverKind.make(instanceId);
}

function sameInstance(
  source: ProviderInstances,
  target: ProviderInstances,
  instanceId: ProviderInstanceId,
): boolean {
  return instanceDriver(source, instanceId) === instanceDriver(target, instanceId);
}

export function instanceCustomModels(instance: ProviderInstanceConfig | undefined) {
  const config = instance?.config as { customModels?: unknown } | undefined;
  return readCustomModelEntries(config?.customModels).map(toCustomModelSetting);
}

function customModelsOf(settings: ProviderInstances, instanceId: ProviderInstanceId) {
  return instanceCustomModels(
    Object.hasOwn(settings.providerInstances, instanceId)
      ? settings.providerInstances[instanceId]
      : undefined,
  );
}

/** The model-settings part of an edit, kept to instances that run the same driver on the target. */
function modelSettingsPatchForEnvironment(
  patch: ServerSettingsPatch,
  source: ProviderInstances,
  target: ProviderInstances,
): ServerSettingsPatch {
  const matches = (change: { readonly provider: ProviderInstanceId }) =>
    sameInstance(source, target, change.provider);
  const setModelFavorites = patch.setModelFavorites?.filter(matches) ?? [];
  const setModelsHidden = patch.setModelsHidden?.filter(matches) ?? [];
  const setProviderCustomModels = patch.setProviderCustomModels?.filter(matches) ?? [];
  return {
    ...(setModelFavorites.length > 0 ? { setModelFavorites } : {}),
    ...(setModelsHidden.length > 0 ? { setModelsHidden } : {}),
    ...(patch.setProviderModelOrder && matches(patch.setProviderModelOrder)
      ? { setProviderModelOrder: patch.setProviderModelOrder }
      : {}),
    ...(setProviderCustomModels.length > 0 ? { setProviderCustomModels } : {}),
  };
}

export interface ModelSettingsSnapshot extends ProviderInstances, ModelPreferences {}

/** Mirrors the source's model settings onto every target instance that runs the same driver. */
export function copyModelSettingsPatch(
  source: ModelSettingsSnapshot,
  target: ModelSettingsSnapshot,
  options: { readonly includeCustomModels: boolean },
): ServerSettingsPatch {
  const candidates = new Set<ProviderInstanceId>(
    [source, target].flatMap((settings) => [
      ...(Object.keys(settings.providerInstances) as ProviderInstanceId[]),
      ...(Object.keys(settings.providerModelPreferences) as ProviderInstanceId[]),
      ...settings.favorites.map((favorite) => favorite.provider),
    ]),
  );
  const copied = new Set([...candidates].filter((id) => sameInstance(source, target, id)));
  const providerModelPreferences = Object.fromEntries([
    ...Object.entries(target.providerModelPreferences).filter(
      ([id]) => !copied.has(id as ProviderInstanceId),
    ),
    ...Object.entries(source.providerModelPreferences).filter(([id]) =>
      copied.has(id as ProviderInstanceId),
    ),
  ]);
  const setProviderCustomModels = options.includeCustomModels
    ? [...copied].flatMap((provider) => {
        const customModels = customModelsOf(source, provider);
        return customModels.length > 0 || customModelsOf(target, provider).length > 0
          ? [{ provider, driver: instanceDriver(source, provider), customModels }]
          : [];
      })
    : [];
  return {
    favorites: [
      ...target.favorites.filter((favorite) => !copied.has(favorite.provider)),
      ...source.favorites.filter((favorite) => copied.has(favorite.provider)),
    ],
    providerModelPreferences,
    ...(setProviderCustomModels.length > 0 ? { setProviderCustomModels } : {}),
  };
}

interface ModelSettingsSyncConfig {
  readonly settings: ServerSettings;
  readonly environment: { readonly capabilities: { readonly modelSettingsSync?: boolean } };
}

export function supportsModelSettingsSync(serverConfig: ModelSettingsSyncConfig): boolean {
  return serverConfig.environment.capabilities.modelSettingsSync === true;
}

/** Which connected environments receive a model-settings edit, and the part of it each one gets. */
export function planModelSettingsSync<
  Target extends {
    readonly environmentId: EnvironmentId;
    readonly serverConfig: ModelSettingsSyncConfig | null;
  },
>(input: {
  readonly sourceEnvironmentId: EnvironmentId;
  readonly source: ProviderInstances;
  readonly patch: ServerSettingsPatch;
  readonly connectedTargets: ReadonlyArray<Target>;
  readonly mayWrite: (environmentId: EnvironmentId, scope: AuthEnvironmentScope) => boolean;
}): Array<{
  readonly target: Target & { readonly serverConfig: ModelSettingsSyncConfig };
  readonly patch: ServerSettingsPatch;
}> {
  return input.connectedTargets.flatMap((target) => {
    const { environmentId, serverConfig } = target;
    if (
      environmentId === input.sourceEnvironmentId ||
      serverConfig === null ||
      !supportsModelSettingsSync(serverConfig)
    ) {
      return [];
    }
    const patch = modelSettingsPatchForEnvironment(
      input.patch,
      input.source,
      serverConfig.settings,
    );
    if (
      Object.keys(patch).length === 0 ||
      !requiredScopesForServerSettingsPatch(patch).every((scope) =>
        input.mayWrite(environmentId, scope),
      )
    ) {
      return [];
    }
    return [{ target: { ...target, serverConfig }, patch }];
  });
}
