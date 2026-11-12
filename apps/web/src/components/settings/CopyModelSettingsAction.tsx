import {
  copyModelSettingsPatch,
  supportsModelSettingsSync,
  supportsSharedSettingsSync,
} from "@t3tools/client-runtime/state/shared-settings";
import {
  isAtomCommandInterrupted,
  settlePromise,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  AuthProvidersManageScope,
  AuthSettingsWriteScope,
  type EnvironmentId,
} from "@t3tools/contracts";
import { CopyIcon } from "lucide-react";

import { readModelPreferences } from "../../hooks/useSettings";
import { ensureLocalApi } from "../../localApi";
import { readEnvironment, useEnvironments } from "../../state/environments";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Menu, MenuGroup, MenuGroupLabel, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { toastManager } from "../ui/toast";

export function CopyModelSettingsAction({
  environmentId,
  environmentLabel,
}: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
}) {
  const { environments } = useEnvironments();
  const canWriteSettings = useEnvironmentScope(environmentId, AuthSettingsWriteScope);
  const canManageProviders = useEnvironmentScope(environmentId, AuthProvidersManageScope);
  const save = useAtomCommand(serverEnvironment.updateSettings, {
    label: "copy model settings",
    reportFailure: false,
  });
  const target = environments.find((environment) => environment.environmentId === environmentId);
  const sources = environments.filter(
    (environment) =>
      environment.environmentId !== environmentId && supportsSharedSettingsSync(environment),
  );
  if (
    !canWriteSettings ||
    !target?.serverConfig ||
    !supportsModelSettingsSync(target.serverConfig) ||
    sources.length === 0
  ) {
    return null;
  }

  const copyFrom = async (sourceId: EnvironmentId, sourceLabel: string) => {
    const scope = canManageProviders
      ? "Favorites, hidden models, model order, and custom models"
      : "Favorites, hidden models, and model order";
    const confirmed = await settlePromise(() =>
      ensureLocalApi().dialogs.confirm(
        `Replace ${environmentLabel}'s model settings with ${sourceLabel}'s?\n${scope} are replaced for providers set up the same way on both.`,
      ),
    );
    if (confirmed._tag !== "Success" || !confirmed.value) return;
    // Read at confirm time: either side may have changed while the dialog was open.
    const sourceSettings = readEnvironment(sourceId)?.serverConfig?.settings;
    const targetSettings = readEnvironment(environmentId)?.serverConfig?.settings;
    if (!sourceSettings || !targetSettings) {
      toastManager.add({
        type: "error",
        title: "Model settings not copied",
        description: `${sourceSettings ? environmentLabel : sourceLabel} disconnected. Reconnect it and try again.`,
      });
      return;
    }
    const [sourcePreferences, targetPreferences] = await Promise.all([
      readModelPreferences(sourceSettings),
      readModelPreferences(targetSettings),
    ]);
    const patch = copyModelSettingsPatch(
      { providerInstances: sourceSettings.providerInstances, ...sourcePreferences },
      { providerInstances: targetSettings.providerInstances, ...targetPreferences },
      { includeCustomModels: canManageProviders },
    );
    const result = await save({ environmentId, input: { patch } });
    if (result._tag === "Success") {
      toastManager.add({
        type: "success",
        title: "Model settings copied",
        description: `${environmentLabel} now uses ${sourceLabel}'s model settings.`,
      });
    } else if (!isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      toastManager.add({
        type: "error",
        title: "Model settings not copied",
        description: error instanceof Error ? error.message : "The settings update failed.",
      });
    }
  };

  return (
    <Menu>
      <MenuTrigger
        render={
          <Button
            size="xs"
            variant="ghost-muted"
            aria-label={`Copy model settings to ${environmentLabel}`}
          />
        }
      >
        <CopyIcon />
        <span className="hidden sm:inline">Copy models from</span>
      </MenuTrigger>
      <MenuPopup align="end">
        <MenuGroup>
          <MenuGroupLabel>Copy model settings from</MenuGroupLabel>
          {sources.map((source) => (
            <MenuItem
              key={source.environmentId}
              onClick={() => void copyFrom(source.environmentId, source.label)}
            >
              {source.label}
            </MenuItem>
          ))}
        </MenuGroup>
      </MenuPopup>
    </Menu>
  );
}
