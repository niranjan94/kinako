import {
  AuthProvidersManageScope,
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerSettings,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import {
  copyModelSettingsPatch,
  filterSharedServerPatch,
  planModelSettingsSync,
} from "./sharedSettings.ts";

describe("filterSharedServerPatch", () => {
  it("holds the restart preference until the target's config loads", () => {
    const patch = { continueThreadsAfterServerUpdate: true, sidebarAutoSettleAfterDays: 7 };
    expect(filterSharedServerPatch(patch, undefined)).toEqual({ sidebarAutoSettleAfterDays: 7 });
    expect(filterSharedServerPatch(patch, DEFAULT_SERVER_SETTINGS)).toEqual(patch);
  });

  it.each([true, false])(
    "resets a disabled default provider only on the originating environment (%s)",
    (targetIsSource) => {
      const settings = {
        ...DEFAULT_SERVER_SETTINGS,
        providerInstances: {
          codex: { driver: ProviderDriverKind.make("codex"), enabled: false, config: {} },
          claudeAgent: {
            driver: ProviderDriverKind.make("claudeAgent"),
            enabled: true,
            config: {},
          },
        },
        textGenerationModelSelection: {
          instanceId: ProviderInstanceId.make("claudeAgent"),
          model: "claude-opus-4-6",
        },
      };
      const patch = {
        textGenerationModelSelection: DEFAULT_SERVER_SETTINGS.textGenerationModelSelection,
        continueThreadsAfterServerUpdate: true,
        sidebarAutoSettleAfterDays: 7,
      };
      expect(filterSharedServerPatch(patch, settings, settings, targetIsSource)).toEqual({
        ...(targetIsSource
          ? { textGenerationModelSelection: DEFAULT_SERVER_SETTINGS.textGenerationModelSelection }
          : {}),
        continueThreadsAfterServerUpdate: true,
        sidebarAutoSettleAfterDays: 7,
      });
    },
  );

  it.each(["missing", "disabled", "different-driver", "enabled"] as const)(
    "shares a custom model only when its target provider is enabled (%s)",
    (availability) => {
      const instanceId = ProviderInstanceId.make("codex_personal");
      const selection = {
        instanceId,
        model: "gpt-5.6-luna",
        options: [{ id: "reasoningEffort", value: "low" }],
      };
      const instance = {
        driver: ProviderDriverKind.make(
          availability === "different-driver" ? "claudeAgent" : "codex",
        ),
        enabled: availability !== "disabled",
        config: {},
      };
      const settings = {
        ...DEFAULT_SERVER_SETTINGS,
        providerInstances: availability === "missing" ? {} : { [instanceId]: instance },
      };
      const patch = { sidebarAutoSettleAfterDays: 7, textGenerationModelSelection: selection };
      const sourceSettings = {
        ...settings,
        providerInstances: {
          [instanceId]: { ...instance, driver: ProviderDriverKind.make("codex"), enabled: true },
        },
      };
      expect(filterSharedServerPatch(patch, settings, sourceSettings)).toEqual(
        availability === "enabled" ? patch : { sidebarAutoSettleAfterDays: 7 },
      );
    },
  );
});

const codex = ProviderDriverKind.make("codex");
const claude = ProviderDriverKind.make("claudeAgent");
const codexDefault = ProviderInstanceId.make("codex");
const work = ProviderInstanceId.make("work");
const personal = ProviderInstanceId.make("personal");
const model = { slug: "gpt-x", name: "gpt-x" };

describe("planModelSettingsSync", () => {
  const sourceId = EnvironmentId.make("source");
  const targetId = EnvironmentId.make("target");
  const environment = (
    environmentId: EnvironmentId,
    providerInstances: ServerSettings["providerInstances"],
    modelSettingsSync = true,
  ) => ({
    environmentId,
    serverConfig: {
      settings: { ...DEFAULT_SERVER_SETTINGS, providerInstances },
      environment: { capabilities: { modelSettingsSync } },
    },
  });

  it("keeps changes only for instances that run the same driver on the target", () => {
    const source = { providerInstances: { work: { driver: codex }, personal: { driver: codex } } };
    const target = environment(targetId, { [work]: { driver: claude } });
    const patch = {
      setModelFavorites: [
        { provider: codexDefault, model: "sol", favorite: true },
        { provider: work, model: "sol", favorite: true },
        { provider: personal, model: "sol", favorite: true },
      ],
      setModelsHidden: [{ provider: work, model: "luna", hidden: true }],
      setProviderModelOrder: { provider: codexDefault, modelOrder: ["sol"] },
      setProviderCustomModels: [{ provider: work, driver: codex, customModels: [model] }],
    };
    const plan = planModelSettingsSync({
      sourceEnvironmentId: sourceId,
      source,
      patch,
      connectedTargets: [environment(sourceId, {}), target, environment(targetId, {}, false)],
      mayWrite: () => true,
    });
    expect(plan.map((entry) => entry.patch)).toEqual([
      {
        setModelFavorites: [{ provider: codexDefault, model: "sol", favorite: true }],
        setProviderModelOrder: { provider: codexDefault, modelOrder: ["sol"] },
      },
    ]);
  });

  it("drops custom models where only settings may be written", () => {
    const patch = {
      setProviderCustomModels: [{ provider: codexDefault, driver: codex, customModels: [model] }],
    };
    const plan = (mayWrite: (environmentId: EnvironmentId, scope: string) => boolean) =>
      planModelSettingsSync({
        sourceEnvironmentId: sourceId,
        source: { providerInstances: {} },
        patch,
        connectedTargets: [environment(targetId, {})],
        mayWrite,
      });
    expect(plan((_, scope) => scope !== AuthProvidersManageScope)).toEqual([]);
    expect(plan(() => true).map((entry) => entry.patch)).toEqual([patch]);
  });
});

describe("copyModelSettingsPatch", () => {
  it("mirrors matching instances and leaves the target's other instances alone", () => {
    const source = {
      providerInstances: { work: { driver: codex, config: { customModels: [model] } } },
      favorites: [
        { provider: codexDefault, model: "sol" },
        { provider: work, model: "gpt-x" },
      ],
      providerModelPreferences: { work: { hiddenModels: ["luna"], modelOrder: ["gpt-x"] } },
    };
    const target = {
      providerInstances: {
        work: { driver: codex, config: { binaryPath: "/opt/codex" } },
        personal: { driver: claude, config: { customModels: [model] } },
      },
      favorites: [
        { provider: codexDefault, model: "astra" },
        { provider: personal, model: "opus" },
      ],
      providerModelPreferences: {
        codex: { hiddenModels: ["astra"], modelOrder: [] },
        personal: { hiddenModels: ["haiku"], modelOrder: [] },
      },
    };
    expect(copyModelSettingsPatch(source, target, { includeCustomModels: true })).toEqual({
      favorites: [
        { provider: personal, model: "opus" },
        { provider: codexDefault, model: "sol" },
        { provider: work, model: "gpt-x" },
      ],
      providerModelPreferences: {
        personal: { hiddenModels: ["haiku"], modelOrder: [] },
        work: { hiddenModels: ["luna"], modelOrder: ["gpt-x"] },
      },
      setProviderCustomModels: [{ provider: work, driver: codex, customModels: ["gpt-x"] }],
    });
    expect(
      copyModelSettingsPatch(source, target, { includeCustomModels: false }),
    ).not.toHaveProperty("setProviderCustomModels");
  });
});
