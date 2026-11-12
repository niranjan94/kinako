import { RegistryContext } from "@effect/atom-react";
import { planModelSettingsSync } from "@t3tools/client-runtime/state/shared-settings";
import type { EnvironmentId, ModelPreferences, ServerSettingsPatch } from "@t3tools/contracts";
import { useContext } from "react";

import { connectedEnvironmentIdsAtom } from "../../state/presentation";
import { environmentServerConfigsAtom, serverEnvironment } from "../../state/server";
import { environmentSession, readEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";

/** Sends a model-settings edit to other connected environments whose instance runs the same driver. */
export function useSyncModelSettings(sourceEnvironmentId: EnvironmentId | null) {
  const registry = useContext(RegistryContext);
  const save = useAtomCommand(serverEnvironment.updateSettings, "model settings sync");
  return (patch: ServerSettingsPatch, legacyFavorites: ModelPreferences["favorites"]) => {
    if (sourceEnvironmentId === null) return;
    const configs = registry.get(environmentServerConfigsAtom);
    const source = configs.get(sourceEnvironmentId)?.settings;
    if (!source) return;
    const plan = planModelSettingsSync({
      sourceEnvironmentId,
      source,
      patch,
      connectedTargets: registry.get(connectedEnvironmentIdsAtom).map((environmentId) => ({
        environmentId,
        serverConfig: configs.get(environmentId) ?? null,
      })),
      // Like shared settings, a session still loading its grants is left to the server to authorize.
      mayWrite: (environmentId, scope) =>
        registry.get(environmentSession.sessionStateAtom(environmentId))._tag === "Initial" ||
        readEnvironmentScope(environmentId, scope),
    });
    for (const { target, patch: targetPatch } of plan) {
      void save({
        environmentId: target.environmentId,
        input: {
          patch: {
            ...targetPatch,
            ...(target.serverConfig.settings.favorites === null
              ? { migrateModelPreferences: { favorites: legacyFavorites } }
              : {}),
          },
        },
      });
    }
  };
}
