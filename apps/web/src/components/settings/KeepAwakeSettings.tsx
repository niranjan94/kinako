import { DEFAULT_UNIFIED_SETTINGS, KeepAwakeMode, type EnvironmentId } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import * as Schema from "effect/Schema";
import { Atom } from "effect/reactivity";

import { serverEnvironment } from "../../state/server";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SettingResetButton, SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useSettingsScope } from "./SettingsScopeContext";
import {
  useScopedSettings,
  useScopedSettingsMixed,
  useUpdateScopedSettings,
} from "./useScopedSettings";

const KEEP_AWAKE_MODE_LABELS: Record<KeepAwakeMode, string> = {
  off: "Off",
  agent: "While agents work",
  always: "Always",
};

const isKeepAwakeMode = Schema.is(KeepAwakeMode);

const keepAwakeStatusesAtom = Atom.family((key: string) => {
  const environmentIds = JSON.parse(key) as ReadonlyArray<EnvironmentId>;
  return Atom.make((get) =>
    environmentIds.flatMap((environmentId) => {
      const result = get(serverEnvironment.keepAwakeStatus({ environmentId, input: {} }));
      return result._tag === "Success" ? [result.value] : [];
    }),
  );
});

export function KeepAwakeSettingsRow() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const mixed = useScopedSettingsMixed(["keepAwakeMode"]);
  const { connectedEnvironments } = useSettingsScope();
  const supported =
    connectedEnvironments.length > 0 &&
    connectedEnvironments.every(
      (target) => target.serverConfig?.environment.capabilities.keepAwake === true,
    );
  const statuses = useAtomValue(
    keepAwakeStatusesAtom(
      JSON.stringify(
        supported ? connectedEnvironments.map(({ environmentId }) => environmentId) : [],
      ),
    ),
  );
  if (!supported) return null;

  const error = statuses.find((status) => status.error !== null)?.error ?? null;
  const activeCount = statuses.filter((status) => status.active).length;
  const status =
    error !== null
      ? error
      : activeCount === 0
        ? undefined
        : connectedEnvironments.length === 1
          ? "Keeping this computer awake now."
          : `Keeping ${activeCount} of ${connectedEnvironments.length} computers awake now.`;

  return (
    <SettingsRow
      {...searchableSetting("keep-awake")}
      serverScoped
      settingKeys={["keepAwakeMode"]}
      description="Stop the computer running this environment from sleeping, so agents and remote clients stay connected. Closing a laptop lid can still put it to sleep."
      status={status}
      resetAction={
        settings.keepAwakeMode !== DEFAULT_UNIFIED_SETTINGS.keepAwakeMode ? (
          <SettingResetButton
            label="keep awake"
            onClick={() =>
              updateSettings({ keepAwakeMode: DEFAULT_UNIFIED_SETTINGS.keepAwakeMode })
            }
          />
        ) : null
      }
      control={
        <Select
          value={mixed ? null : settings.keepAwakeMode}
          onValueChange={(value) => {
            if (isKeepAwakeMode(value)) updateSettings({ keepAwakeMode: value });
          }}
        >
          <SelectTrigger size="sm" className="w-full sm:w-44" aria-label="Keep awake">
            <SelectValue>
              {(value: KeepAwakeMode | null) =>
                value === null ? "Mixed" : KEEP_AWAKE_MODE_LABELS[value]
              }
            </SelectValue>
          </SelectTrigger>
          <SelectPopup align="end" alignItemWithTrigger={false}>
            {KeepAwakeMode.literals.map((mode) => (
              <SelectItem key={mode} hideIndicator value={mode}>
                {KEEP_AWAKE_MODE_LABELS[mode]}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      }
    />
  );
}
