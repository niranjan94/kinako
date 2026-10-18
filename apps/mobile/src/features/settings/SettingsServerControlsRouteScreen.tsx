import { FORK_PROJECT_FILE_NAME } from "@t3tools/shared/forkBrand";
import { useNavigation } from "@react-navigation/native";
import { SettingsRow } from "./components/SettingsRow";
import { AuthSettingsWriteScope } from "@t3tools/contracts";
import { readEnvironmentScope, useEnvironmentsWithScope } from "../../state/session";
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { AppText as Text } from "../../components/ui/AppText";
import {
  EnvironmentId,
  type KeepAwakeMode,
  type ResponseStreamingMode,
  type ServerSettings,
  type ServerSettingsPatch,
  type ThreadEnvMode,
  type WorktreeSubmodules,
  PROJECT_SCOPED_SERVER_SETTING_KEYS,
  type ProjectScopedServerSettingKey,
} from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { Atom } from "effect/reactivity";
import { useMemo, useRef, useState } from "react";
import { View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { RUNTIME_MODE_CHOICES } from "../threads/thread-settings-options";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsScreen } from "./components/SettingsScreen";
import {
  AndroidSettingsEnvironmentFilter,
  SettingsEnvironmentFilterHeader,
} from "./components/SettingsEnvironmentFilterHeader";
import { BranchNamingSettings } from "./components/BranchNamingSettings";
import { WorktreeIncludePatternsSettings } from "./components/WorktreeIncludePatternsSettings";
import { DatabaseStorageNotice } from "./components/DatabaseStorageNotice";
import { SettingsChoiceRow } from "./components/SettingsChoiceRow";
import { SettingsSection } from "./components/SettingsSection";
import { SettingsSwitchRow } from "./components/SettingsSwitchRow";
import { SettingsProjectOverridesSection } from "./components/SettingsProjectOverridesSection";
import { useSettingsEnvironmentFilter } from "./settings-environment-filter";
import {
  planMobileScopedSettingsClear,
  planMobileScopedSettingsPatch,
  resolveMobileSettingsTargets,
  uniformMobileSetting,
  type ScopedMobileSettingsTarget,
} from "./settings-scoped-server";
import { PullRequestGlyph } from "../pull-requests/pullRequestGlyphs";

type SettingsPage = "new-threads" | "source-control" | "agent-behavior" | "maintenance";

const PAGE_TITLES: Record<SettingsPage, string> = {
  "new-threads": "New threads",
  "source-control": "Source control",
  "agent-behavior": "Agent behavior",
  maintenance: "Maintenance",
};

const PAGE_PROJECT_KEYS: Record<SettingsPage, readonly ProjectScopedServerSettingKey[]> = {
  "new-threads": [
    "defaultThreadEnvMode",
    "worktreeSubmodules",
    "worktreeIncludePatterns",
    "defaultRuntimeMode",
  ],
  "source-control": [
    "defaultAutoPull",
    "removeAgentCreditsOnMerge",
    "newWorktreesStartFromOrigin",
    "branchNamingMode",
    "branchNamePrefix",
    "branchNameInstructions",
  ],
  "agent-behavior": ["responseStreamingMode", "enableAgentBrowserAccess"],
  maintenance: ["continueThreadsAfterServerUpdate"],
};

const SUBMODULE_CHOICES: ReadonlyArray<{
  readonly mode: WorktreeSubmodules | null;
  readonly label: string;
  readonly description: string;
}> = [
  {
    mode: null,
    label: "Inherit",
    description: `Use the repository's ${FORK_PROJECT_FILE_NAME} or t3.json, or initialize recursively.`,
  },
  { mode: "recursive", label: "Recursive", description: "Initialize nested submodules too." },
  {
    mode: "top-level",
    label: "Top level only",
    description: "Skip submodules declared inside other submodules.",
  },
  { mode: "none", label: "Skip", description: "Leave submodules empty for a setup script." },
];

const WORKSPACE_CHOICES: ReadonlyArray<{
  readonly mode: ThreadEnvMode | null;
  readonly label: string;
  readonly description: string;
}> = [
  {
    mode: null,
    label: "Inherit",
    description: `Use the repository's ${FORK_PROJECT_FILE_NAME} or t3.json, or the current checkout.`,
  },
  {
    mode: "local",
    label: "Current checkout",
    description: "Start new threads in the existing workspace.",
  },
  {
    mode: "worktree",
    label: "New worktree",
    description: "Give each new thread a separate checkout.",
  },
];

const STREAMING_CHOICES: ReadonlyArray<{
  readonly mode: ResponseStreamingMode;
  readonly label: string;
  readonly description: string;
}> = [
  {
    mode: "turn",
    label: "After the turn",
    description: "Show the answer when the agent finishes.",
  },
  {
    mode: "paragraph",
    label: "Finished paragraphs",
    description: "Show each paragraph or code block as it completes.",
  },
];

const KEEP_AWAKE_CHOICES: ReadonlyArray<{
  readonly mode: KeepAwakeMode;
  readonly label: string;
  readonly description: string;
}> = [
  { mode: "off", label: "Off", description: "Let the computer sleep as usual." },
  {
    mode: "agent",
    label: "While agents work",
    description: "Stay awake while a turn runs or waits for you.",
  },
  { mode: "always", label: "Always", description: "Stay awake while the server runs." },
];

function useKeepAwakeFooter(
  environmentIds: ReadonlyArray<EnvironmentId>,
  enabled: boolean,
): string | undefined {
  const environmentKey = enabled ? environmentIds.join("\n") : "";
  const statuses = useAtomValue(
    useMemo(
      () =>
        Atom.make((get) =>
          environmentKey === ""
            ? []
            : environmentKey.split("\n").flatMap((environmentId) => {
                const result = get(
                  serverEnvironment.keepAwakeStatus({
                    environmentId: EnvironmentId.make(environmentId),
                    input: {},
                  }),
                );
                return result._tag === "Success" ? [result.value] : [];
              }),
        ),
      [environmentKey],
    ),
  );
  const error = statuses.find((status) => status.error !== null)?.error;
  if (error) return error;
  const activeCount = statuses.filter((status) => status.active).length;
  if (activeCount === 0) return undefined;
  return environmentIds.length === 1
    ? "Keeping this computer awake now."
    : `Keeping ${activeCount} of ${environmentIds.length} computers awake now.`;
}

export function SettingsEnvironmentNewThreadsRouteScreen() {
  return <ServerSettingsDetail page="new-threads" />;
}

export function SettingsEnvironmentSourceControlRouteScreen() {
  return <ServerSettingsDetail page="source-control" />;
}

export function SettingsEnvironmentAgentBehaviorRouteScreen() {
  return <ServerSettingsDetail page="agent-behavior" />;
}

export function SettingsEnvironmentMaintenanceRouteScreen() {
  return <ServerSettingsDetail page="maintenance" />;
}

function ServerSettingsDetail(props: { readonly page: SettingsPage }) {
  const insets = useSafeAreaInsets();
  const navigation = useNavigation();
  const { selectedTargets, projectGroups, selectedProjectKey } = useSettingsEnvironmentFilter();
  const selectedProject = projectGroups.find((group) => group.key === selectedProjectKey);
  const writableEnvironments = useEnvironmentsWithScope(selectedTargets, AuthSettingsWriteScope);
  const projectSelected = selectedProjectKey !== null;
  const targets = resolveMobileSettingsTargets(
    selectedTargets,
    projectSelected ? (selectedProject?.members.map((member) => member.project) ?? []) : null,
  );
  const [pendingWrites, setPendingWrites] = useState(0);
  const writeInFlight = useRef(false);
  const [pendingTargets, setPendingTargets] = useState<
    readonly ScopedMobileSettingsTarget[] | null
  >(null);
  const canWriteSettings =
    targets.length > 0 &&
    targets.every((target) => writableEnvironments.has(target.environment.environmentId));
  const displayTargets = pendingWrites > 0 && pendingTargets !== null ? pendingTargets : targets;
  const hasConnectedSelection = targets.length > 0;
  const reference = displayTargets[0] ?? null;
  const uniform = <K extends keyof ServerSettings>(key: K) =>
    uniformMobileSetting(displayTargets, key);
  // `uniform` folds a real null into "mixed"; nullable keys need the distinction.
  const isMixed = (key: keyof ServerSettings) =>
    reference === null ||
    displayTargets.some((entry) => entry.settings[key] !== reference.settings[key]);
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, {
    label: "environment settings update",
    reportFailure: true,
  });
  const write = (patch: ServerSettingsPatch) => {
    if (
      writeInFlight.current ||
      !hasConnectedSelection ||
      !targets.every((target) =>
        readEnvironmentScope(target.environment.environmentId, AuthSettingsWriteScope),
      )
    )
      return;
    const writes = planMobileScopedSettingsPatch(targets, projectSelected, patch);
    if (writes.length === 0) return;
    writeInFlight.current = true;
    setPendingTargets(targets);
    setPendingWrites((count) => count + 1);
    void Promise.allSettled(
      writes.map((entry) =>
        updateSettings({ environmentId: entry.environmentId, input: { patch: entry.patch } }),
      ),
    ).finally(() => {
      writeInFlight.current = false;
      setPendingTargets(null);
      setPendingWrites((count) => count - 1);
    });
  };
  const clearProjectOverrides = () => {
    if (
      writeInFlight.current ||
      !targets.every((target) =>
        readEnvironmentScope(target.environment.environmentId, AuthSettingsWriteScope),
      )
    )
      return;
    const writes = planMobileScopedSettingsClear(targets, PAGE_PROJECT_KEYS[props.page]);
    if (writes.length === 0) return;
    writeInFlight.current = true;
    setPendingTargets(targets);
    setPendingWrites((count) => count + 1);
    void Promise.allSettled(
      writes.map((entry) =>
        updateSettings({ environmentId: entry.environmentId, input: { patch: entry.patch } }),
      ),
    ).finally(() => {
      writeInFlight.current = false;
      setPendingTargets(null);
      setPendingWrites((count) => count - 1);
    });
  };
  const supportsProjectOverrides = targets.every(
    (target) =>
      target.environment.serverConfig.environment.capabilities.projectSettingsOverrides === true,
  );
  const disabled =
    !canWriteSettings ||
    pendingWrites > 0 ||
    !hasConnectedSelection ||
    (projectSelected && !supportsProjectOverrides);
  const supportsContinuation = targets.every(
    (target) =>
      target.environment.serverConfig.environment.capabilities.threadRestartContinuation === true,
  );
  const supportsKeepAwake = targets.every(
    (target) => target.environment.serverConfig.environment.capabilities.keepAwake === true,
  );
  const keepAwakeFooter = useKeepAwakeFooter(
    targets.map((target) => target.environment.environmentId),
    props.page === "maintenance" && !projectSelected && hasConnectedSelection && supportsKeepAwake,
  );
  const supportsIncludePatterns = targets.every(
    (target) =>
      target.environment.serverConfig.environment.capabilities.worktreeIncludePatterns === true,
  );
  const disabledFor = (key: string) =>
    disabled ||
    (projectSelected &&
      !PROJECT_SCOPED_SERVER_SETTING_KEYS.includes(
        key as (typeof PROJECT_SCOPED_SERVER_SETTING_KEYS)[number],
      ));

  return (
    <>
      <SettingsEnvironmentFilterHeader />
      <SettingsScreen
        title={PAGE_TITLES[props.page]}
        trailing={<AndroidSettingsEnvironmentFilter />}
      >
        <ScrollView
          contentInsetAdjustmentBehavior="automatic"
          showsVerticalScrollIndicator={false}
          className="flex-1"
          contentContainerClassName="gap-6 px-5 pt-4"
          contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
        >
          {!hasConnectedSelection || reference === null ? (
            <Text className="px-2 text-base text-foreground-muted">
              {projectSelected
                ? "Select a project with a checkout on a connected environment."
                : "Use the filter above to select a connected environment."}
            </Text>
          ) : (
            <>
              {projectSelected ? (
                <SettingsProjectOverridesSection
                  projectLabel={selectedProject?.label ?? "Unavailable project"}
                  hasOverrides={targets.some((target) =>
                    PAGE_PROJECT_KEYS[props.page].some((key) => target.sources[key] === "project"),
                  )}
                  supportsOverrides={supportsProjectOverrides}
                  pending={pendingWrites > 0}
                  disabled={!canWriteSettings}
                  onClear={clearProjectOverrides}
                />
              ) : null}
              {props.page === "new-threads" ? (
                <>
                  <SettingsSection
                    title="Default workspace"
                    trailing={
                      pendingWrites === 0 && isMixed("defaultThreadEnvMode") ? (
                        <MixedValuesLabel projectSelected={projectSelected} />
                      ) : null
                    }
                  >
                    {WORKSPACE_CHOICES.filter(
                      (choice) => choice.mode !== null || !projectSelected,
                    ).map((choice, index) => (
                      <SettingsChoiceRow
                        key={choice.mode ?? "inherit"}
                        label={choice.label}
                        description={choice.description}
                        selected={
                          !isMixed("defaultThreadEnvMode") &&
                          uniform("defaultThreadEnvMode") === choice.mode
                        }
                        separated={index > 0}
                        disabled={disabledFor("defaultThreadEnvMode")}
                        onPress={() => write({ defaultThreadEnvMode: choice.mode })}
                      />
                    ))}
                  </SettingsSection>
                  <SettingsSection
                    title="Worktree submodules"
                    trailing={
                      pendingWrites === 0 && isMixed("worktreeSubmodules") ? (
                        <MixedValuesLabel projectSelected={projectSelected} />
                      ) : null
                    }
                  >
                    {SUBMODULE_CHOICES.filter(
                      (choice) => choice.mode !== null || !projectSelected,
                    ).map((choice, index) => (
                      <SettingsChoiceRow
                        key={choice.mode ?? "inherit"}
                        label={choice.label}
                        description={choice.description}
                        selected={
                          !isMixed("worktreeSubmodules") &&
                          uniform("worktreeSubmodules") === choice.mode
                        }
                        separated={index > 0}
                        disabled={disabledFor("worktreeSubmodules")}
                        onPress={() => write({ worktreeSubmodules: choice.mode })}
                      />
                    ))}
                  </SettingsSection>
                  {supportsIncludePatterns ? (
                    <WorktreeIncludePatternsSettings
                      key={targets
                        .map((target) => `${target.environment.environmentId}:${target.projectId}`)
                        .join(",")}
                      patterns={uniform("worktreeIncludePatterns")}
                      disabled={disabledFor("worktreeIncludePatterns")}
                      onChange={write}
                    />
                  ) : null}
                  <SettingsSection
                    title="Default permissions"
                    trailing={
                      pendingWrites === 0 && uniform("defaultRuntimeMode") === null ? (
                        <MixedValuesLabel projectSelected={projectSelected} />
                      ) : null
                    }
                  >
                    {RUNTIME_MODE_CHOICES.map((choice, index) => (
                      <SettingsChoiceRow
                        key={choice.mode}
                        label={choice.label}
                        description={choice.description}
                        selected={uniform("defaultRuntimeMode") === choice.mode}
                        separated={index > 0}
                        disabled={disabledFor("defaultRuntimeMode")}
                        onPress={() => write({ defaultRuntimeMode: choice.mode })}
                      />
                    ))}
                  </SettingsSection>
                </>
              ) : null}

              {props.page === "source-control" ? (
                <>
                  <BranchNamingSettings
                    key={targets
                      .map((target) => `${target.environment.environmentId}:${target.projectId}`)
                      .join(",")}
                    mode={uniform("branchNamingMode")}
                    prefix={uniform("branchNamePrefix")}
                    instructions={uniform("branchNameInstructions")}
                    disabled={disabledFor("branchNamingMode")}
                    onChange={write}
                  />
                  <SettingsSection title="Pull requests">
                    <SettingsSwitchRow
                      icon={PullRequestGlyph.merged}
                      label="Remove agent credits when merging"
                      subtitle="Remove recognized agent credits from GitHub merge and squash messages, keeping human co-authors. Includes auto-merge. Excludes merge queues, stack merges, and existing commits."
                      value={uniform("removeAgentCreditsOnMerge")}
                      disabled={disabledFor("removeAgentCreditsOnMerge")}
                      onValueChange={(value) => write({ removeAgentCreditsOnMerge: value })}
                    />
                  </SettingsSection>
                  <SettingsSection title="Default branch">
                    <SettingsSwitchRow
                      icon="arrow.down.circle"
                      label="Automatically pull"
                      subtitle="Keep the default branch current when there are no local changes."
                      value={uniform("defaultAutoPull")}
                      disabled={disabledFor("defaultAutoPull")}
                      onValueChange={(value) => write({ defaultAutoPull: value })}
                    />
                  </SettingsSection>
                  <SettingsSection title="Worktrees">
                    <SettingsSwitchRow
                      icon="arrow.triangle.branch"
                      label="Start from origin"
                      subtitle="Base new worktrees on the remote branch."
                      value={uniform("newWorktreesStartFromOrigin")}
                      disabled={disabledFor("newWorktreesStartFromOrigin")}
                      onValueChange={(value) => write({ newWorktreesStartFromOrigin: value })}
                    />
                  </SettingsSection>
                </>
              ) : null}

              {props.page === "agent-behavior" ? (
                <>
                  <SettingsSection
                    title="Response streaming"
                    trailing={
                      pendingWrites === 0 && uniform("responseStreamingMode") === null ? (
                        <MixedValuesLabel projectSelected={projectSelected} />
                      ) : null
                    }
                  >
                    {STREAMING_CHOICES.map((choice, index) => (
                      <SettingsChoiceRow
                        key={choice.mode}
                        label={choice.label}
                        description={choice.description}
                        selected={uniform("responseStreamingMode") === choice.mode}
                        separated={index > 0}
                        disabled={disabledFor("responseStreamingMode")}
                        onPress={() => write({ responseStreamingMode: choice.mode })}
                      />
                    ))}
                  </SettingsSection>
                  <SettingsSection title="Preview browser">
                    <SettingsSwitchRow
                      icon="globe"
                      label="Agent browser access"
                      subtitle="Allow agents to use the in-app preview browser."
                      value={uniform("enableAgentBrowserAccess")}
                      disabled={disabledFor("enableAgentBrowserAccess")}
                      onValueChange={(value) => write({ enableAgentBrowserAccess: value })}
                    />
                  </SettingsSection>
                </>
              ) : null}

              {props.page === "maintenance" ? (
                <>
                  {!projectSelected &&
                    selectedTargets
                      .filter(
                        (target) =>
                          target.serverConfig.environment.capabilities.databaseStorage === true,
                      )
                      .map((target) => (
                        <DatabaseStorageNotice key={target.environmentId} target={target} />
                      ))}
                  {!projectSelected ? (
                    <SettingsSection title="Manage environments">
                      {selectedTargets.map((target) => (
                        <SettingsRow
                          key={target.environmentId}
                          icon="server.rack"
                          label={target.label}
                          value="Server and provider updates"
                          onPress={() =>
                            navigation.navigate("SettingsSheet", {
                              screen: "SettingsContent",
                              params: {
                                screen: "SettingsEnvironmentDetail",
                                params: { environmentId: target.environmentId },
                              },
                            })
                          }
                        />
                      ))}
                    </SettingsSection>
                  ) : null}
                  <SettingsSection title="Updates">
                    <SettingsSwitchRow
                      icon="arrow.clockwise"
                      label="Check provider updates"
                      subtitle={
                        projectSelected
                          ? "Environment-wide setting. Select All projects to change it."
                          : "Check installed provider CLIs for newer versions and fetch model catalog updates. When off, new models may not appear."
                      }
                      value={uniform("enableProviderUpdateChecks")}
                      disabled={disabledFor("enableProviderUpdateChecks")}
                      onValueChange={(value) => write({ enableProviderUpdateChecks: value })}
                    />
                    <View className="border-t border-border-subtle">
                      <SettingsSwitchRow
                        icon="arrow.uturn.forward"
                        label="Continue after restart"
                        subtitle={
                          supportsContinuation
                            ? "Resume interrupted threads after an update or restart."
                            : "Update older servers to control restart continuation."
                        }
                        value={uniform("continueThreadsAfterServerUpdate")}
                        disabled={
                          disabledFor("continueThreadsAfterServerUpdate") || !supportsContinuation
                        }
                        onValueChange={(value) =>
                          write({ continueThreadsAfterServerUpdate: value })
                        }
                      />
                    </View>
                  </SettingsSection>
                  {!projectSelected && hasConnectedSelection && supportsKeepAwake ? (
                    <SettingsSection
                      title="Keep awake"
                      footer={keepAwakeFooter}
                      trailing={
                        pendingWrites === 0 && uniform("keepAwakeMode") === null ? (
                          <MixedValuesLabel projectSelected={projectSelected} />
                        ) : null
                      }
                    >
                      {KEEP_AWAKE_CHOICES.map((choice, index) => (
                        <SettingsChoiceRow
                          key={choice.mode}
                          label={choice.label}
                          description={choice.description}
                          selected={uniform("keepAwakeMode") === choice.mode}
                          separated={index > 0}
                          disabled={disabledFor("keepAwakeMode")}
                          onPress={() => write({ keepAwakeMode: choice.mode })}
                        />
                      ))}
                    </SettingsSection>
                  ) : null}
                </>
              ) : null}
            </>
          )}
        </ScrollView>
      </SettingsScreen>
    </>
  );
}

function MixedValuesLabel(props: { readonly projectSelected: boolean }) {
  return (
    <Text
      accessibilityLabel={
        props.projectSelected
          ? "Selected project checkouts use different values"
          : "Selected environments use different values"
      }
      className="px-2 text-sm text-foreground-muted android:px-4"
    >
      Mixed
    </Text>
  );
}
