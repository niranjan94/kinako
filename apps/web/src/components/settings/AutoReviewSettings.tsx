import { useNavigate } from "@tanstack/react-router";
import { type ModelSelection, type ProviderInstanceId } from "@t3tools/contracts";
import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";
import { createModelSelection, pickModelSelection } from "@t3tools/shared/model";
import { resolveAutoReviewModelSelection } from "@t3tools/shared/serverSettings";
import { T, useGT } from "gt-react";
import { useRef } from "react";

import { APP_BASE_NAME } from "../../branding";
import { useDecisionApiTargets } from "../../decisionApis";
import {
  getTextGenerationModelOptionsByInstance,
  resolveAppModelSelectionState,
  selectsPlanAgent,
} from "../../modelSelection";
import { useEnvironmentProviders } from "../../state/environments";
import { EMPTY_SERVER_PROVIDERS } from "../../state/server";
import { useTextGenerationTargets } from "../../textGenerators";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { TraitsPicker } from "../chat/TraitsPicker";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";
import { ScopedSwitch } from "./ScopedSwitch";
import { useSettingsScope } from "./SettingsScopeContext";
import {
  SETTINGS_PICKER_TRIGGER_CLASSNAME,
  SettingResetButton,
  SettingsRow,
  SettingsSection,
} from "./settingsLayout";
import { useSearchableSetting } from "./settingsSearch";
import { useScopedModelDisabledReason } from "./useScopedModelAvailability";
import {
  useScopedSettings,
  useScopedSettingsMixed,
  useUpdateScopedSettings,
} from "./useScopedSettings";

const CONFIDENCE_THRESHOLD_PRESETS = [0.7, 0.8, 0.85, 0.9, 0.95, 0.99];

const formatPercent = new Intl.NumberFormat(undefined, {
  style: "percent",
  maximumFractionDigits: 0,
}).format;

export function AutoReviewSettingsSection() {
  const setting = useSearchableSetting();
  const gt = useGT();
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const navigate = useNavigate();
  const { environment, connectedEnvironments, targets, target } = useSettingsScope();
  const environmentId = environment?.environmentId ?? null;
  const hasServerTargets = connectedEnvironments.length > 0;
  const providersByEnvironment = useEnvironmentProviders();
  const serverProviders =
    (environment?.serverConfig
      ? providersByEnvironment.get(environment.environmentId)
      : undefined) ?? EMPTY_SERVER_PROVIDERS;
  const mixedRulesOnly = useScopedSettingsMixed(["autoReviewRulesOnly"]);
  const mixedModel = useScopedSettingsMixed(["autoReviewModelSelection"]);
  const mixedThreshold = useScopedSettingsMixed(["autoReviewConfidenceThreshold"]);
  const mixedInstructions = useScopedSettingsMixed(["autoReviewPolicyInstructions"]);
  const instructionsEdited = useRef(false);
  const scopeKey = targets.map((target) => `${target.environmentId}:${target.projectId}`).join(",");

  const textTargets = useTextGenerationTargets({
    environmentId,
    settings,
    providers: serverProviders.filter((provider) => provider.supportsTextGeneration !== false),
    projectId: target?.projectId ?? null,
    selections: [settings.autoReviewModelSelection, settings.textGenerationModelSelection],
  });
  const decisionTargets = useDecisionApiTargets({
    environmentId,
    settings,
    selections: [settings.autoReviewModelSelection],
  });
  const usableTextProviders = textTargets.providers.filter((provider) =>
    textTargets.entries.some(
      (entry) => entry.instanceId === provider.instanceId && entry.enabled && entry.isAvailable,
    ),
  );
  const defaultSelection = resolveAppModelSelectionState(settings, usableTextProviders);
  const resolved = resolveAutoReviewModelSelection(settings, usableTextProviders);
  const usesDecisionApi = Object.hasOwn(settings.decisionApis, resolved.instanceId);
  const activeSelection = usesDecisionApi
    ? resolved
    : resolveAppModelSelectionState(
        { ...settings, textGenerationModelSelection: resolved },
        usableTextProviders,
      );
  const entries = [...textTargets.entries, ...decisionTargets.entries];
  const modelOptionsByInstance = getTextGenerationModelOptionsByInstance(
    settings,
    [...textTargets.providers, ...decisionTargets.providers],
    activeSelection.instanceId,
    activeSelection.model,
  );
  const activeEntry = entries.find((entry) => entry.instanceId === activeSelection.instanceId);
  const usesDedicatedModel = settings.autoReviewModelSelection !== null;
  const firstDecisionEntry = decisionTargets.entries.find((entry) => entry.models.length > 0);
  const seed = textTargets.entries.some(
    (entry) =>
      entry.instanceId === defaultSelection.instanceId && entry.enabled && entry.isAvailable,
  )
    ? defaultSelection
    : firstDecisionEntry
      ? createModelSelection(firstDecisionEntry.instanceId, firstDecisionEntry.models[0]!.slug)
      : null;
  const textModelDisabledReason = useScopedModelDisabledReason(settings, textTargets.entries, true);
  // Decision API lists load for the shown environment only; others must reach the same API.
  const modelDisabledReason = (instanceId: ProviderInstanceId, model: string) => {
    const shown = settings.decisionApis[instanceId];
    if (shown === undefined) return textModelDisabledReason(instanceId, model);
    return targets.every((candidate) => {
      const config = candidate.settings.decisionApis[instanceId];
      return config?.enabled === true && config.baseUrl === shown.baseUrl;
    })
      ? null
      : gt(
          "This decision API is not set up on every selected environment. Select an environment to choose its reviewer separately.",
        );
  };
  const saveModel = (selection: ModelSelection | null) =>
    updateSettings({ autoReviewModelSelection: selection });
  const rejectModel = (reason: string) =>
    toastManager.add({ type: "error", title: gt("Reviewer model not saved"), description: reason });

  const threshold = settings.autoReviewConfidenceThreshold;
  const thresholdOptions = [...new Set([...CONFIDENCE_THRESHOLD_PRESETS, threshold])].toSorted(
    (a, b) => a - b,
  );
  const showModelRows = mixedRulesOnly || !settings.autoReviewRulesOnly;

  return (
    <SettingsSection id="auto-review" title={gt("{app} Auto", { app: APP_BASE_NAME })}>
      <SettingsRow
        serverScoped
        settingKeys={["autoReviewRulesOnly"]}
        {...setting("auto-review-rules-only")}
        description={gt(
          "In {app} Auto, routine local actions run and risky ones ask you first. The provider's sandbox still applies. Rules only skips the reviewer model, so anything the rules don't settle asks you.",
          { app: APP_BASE_NAME },
        )}
        control={
          <ScopedSwitch
            settingKeys={["autoReviewRulesOnly"]}
            checked={settings.autoReviewRulesOnly}
            onCheckedChange={(checked) => updateSettings({ autoReviewRulesOnly: Boolean(checked) })}
            aria-label={gt("Rules only")}
          />
        }
      />

      {showModelRows ? (
        <SettingsRow
          serverScoped
          settingKeys={["autoReviewModelSelection"]}
          {...setting("auto-review-model")}
          description={gt(
            "Reviews requests the rules don't settle. Decision APIs from Providers also appear here. When off, the text generation model reviews.",
          )}
          control={
            !hasServerTargets ? (
              <span className="text-sm text-muted-foreground">
                <T>Connect an environment to choose its reviewer model.</T>
              </span>
            ) : (
              <div className="flex flex-wrap items-center justify-end gap-2">
                {usesDedicatedModel || mixedModel ? (
                  <ProviderModelPicker
                    environmentId={environmentId}
                    activeInstanceId={activeSelection.instanceId}
                    model={activeSelection.model}
                    lockedProvider={null}
                    instanceEntries={entries}
                    modelOptionsByInstance={modelOptionsByInstance}
                    triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
                    triggerAriaLabel={gt("Reviewer model")}
                    {...(mixedModel ? { triggerLabel: gt("Mixed") } : {})}
                    {...(environmentId
                      ? {
                          onOpenProviderSetup: (instanceId: ProviderInstanceId) => {
                            void navigate({
                              to: "/settings/providers",
                              search: { environmentId, instanceId },
                            });
                          },
                        }
                      : {})}
                    getModelDisabledReason={modelDisabledReason}
                    onInstanceModelChange={(instanceId, model) => {
                      const reason = modelDisabledReason(instanceId, model);
                      if (reason) {
                        rejectModel(reason);
                        return;
                      }
                      saveModel(
                        pickModelSelection(mixedModel ? null : activeSelection, instanceId, model),
                      );
                    }}
                  />
                ) : null}
                {usesDedicatedModel && !mixedModel && !usesDecisionApi && activeEntry ? (
                  <TraitsPicker
                    provider={activeEntry.driverKind}
                    models={activeEntry.models}
                    model={activeSelection.model}
                    modelOptions={activeSelection.options ?? []}
                    allowPromptInjectedEffort={false}
                    includePlanAgent={selectsPlanAgent(activeSelection.options)}
                    triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
                    onModelOptionsChange={(options) =>
                      saveModel(
                        createModelSelection(
                          activeSelection.instanceId,
                          activeSelection.model,
                          options,
                        ),
                      )
                    }
                  />
                ) : null}
                <Switch
                  mixed={mixedModel}
                  checked={mixedModel ? false : usesDedicatedModel}
                  disabled={!usesDedicatedModel && seed === null}
                  onCheckedChange={(checked) => {
                    if (!checked) {
                      saveModel(null);
                      return;
                    }
                    if (seed === null) return;
                    const reason = modelDisabledReason(seed.instanceId, seed.model);
                    if (reason) {
                      rejectModel(reason);
                      return;
                    }
                    saveModel(createModelSelection(seed.instanceId, seed.model, seed.options));
                  }}
                  aria-label={gt("Use a separate reviewer model")}
                />
              </div>
            )
          }
        />
      ) : null}

      {showModelRows && usesDecisionApi ? (
        <SettingsRow
          serverScoped
          settingKeys={["autoReviewConfidenceThreshold"]}
          {...setting("auto-review-confidence")}
          description={gt(
            "How sure the decision API must be that a request is safe before it runs. Anything less certain asks you.",
          )}
          resetAction={
            threshold !== DEFAULT_UNIFIED_SETTINGS.autoReviewConfidenceThreshold ? (
              <SettingResetButton
                ariaLabel={gt("Reset reviewer confidence to default")}
                onClick={() =>
                  updateSettings({
                    autoReviewConfidenceThreshold:
                      DEFAULT_UNIFIED_SETTINGS.autoReviewConfidenceThreshold,
                  })
                }
              />
            ) : null
          }
          control={
            <Select
              value={mixedThreshold ? null : String(threshold)}
              onValueChange={(value) => {
                if (value !== null)
                  updateSettings({ autoReviewConfidenceThreshold: Number(value) });
              }}
            >
              <SelectTrigger
                size="sm"
                className="w-full sm:w-32"
                aria-label={gt("Reviewer confidence")}
              >
                <SelectValue>
                  {(value: string | null) =>
                    value === null ? gt("Mixed") : formatPercent(Number(value))
                  }
                </SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                {thresholdOptions.map((option) => (
                  <SelectItem key={option} hideIndicator value={String(option)}>
                    {formatPercent(option)}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          }
        />
      ) : null}

      {showModelRows ? (
        <SettingsRow
          serverScoped
          settingKeys={["autoReviewPolicyInstructions"]}
          {...setting("auto-review-instructions")}
          description={gt(
            "Tell the reviewer what this work allows or should always ask about. Built-in safety rules still apply.",
          )}
          resetAction={
            mixedInstructions || settings.autoReviewPolicyInstructions !== "" ? (
              <SettingResetButton
                ariaLabel={gt("Reset reviewer instructions to default")}
                onClick={() => updateSettings({ autoReviewPolicyInstructions: "" })}
              />
            ) : null
          }
        >
          <div className="mt-3 max-w-2xl pb-3.5">
            <Textarea
              key={`${scopeKey}:${mixedInstructions}:${settings.autoReviewPolicyInstructions}`}
              aria-label={gt("Reviewer instructions")}
              onChange={() => {
                instructionsEdited.current = true;
              }}
              rows={4}
              defaultValue={mixedInstructions ? "" : settings.autoReviewPolicyInstructions}
              placeholder={
                mixedInstructions
                  ? gt("Mixed. Enter instructions to apply to all selected targets.")
                  : gt(
                      "Running the test suite and installing dev dependencies is fine. Always ask before touching the database or anything outside this repository.",
                    )
              }
              onBlur={(event) => {
                const value = event.target.value.trim();
                if (
                  instructionsEdited.current &&
                  (mixedInstructions || value !== settings.autoReviewPolicyInstructions)
                )
                  updateSettings({ autoReviewPolicyInstructions: value });
                instructionsEdited.current = false;
              }}
            />
          </div>
        </SettingsRow>
      ) : null}
    </SettingsSection>
  );
}
