import { DEFAULT_UNIFIED_SETTINGS, type UnifiedSettings } from "@t3tools/contracts/settings";
import { expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";

const state = vi.hoisted(() => ({
  settings: null as UnifiedSettings | null,
  confirm: vi.fn(async () => true),
}));

vi.mock("./useScopedSettings", () => ({
  useScopedSettings: () => state.settings,
  useScopedSettingsMixed: vi.fn(),
  useScopedSettingSource: vi.fn(),
  useClearScopedSettings: vi.fn(),
  useClearProjectOverrides: vi.fn(),
  useScopedSettingsWriteAllowed: vi.fn(),
  useUpdateScopedSettings: () => (patch: Partial<UnifiedSettings>) => {
    state.settings = { ...state.settings!, ...patch };
  },
}));

vi.mock("../../hooks/useTheme", () => ({
  useTheme: () => ({ theme: "system", followSystem: true, themeHalves: null }),
  readThemePreference: () => "system",
  readThemeHalves: () => null,
  readAppearanceModePreference: () => "system",
}));

vi.mock("../../localApi", () => ({
  readLocalApi: () => ({ dialogs: { confirm: state.confirm } }),
  ensureLocalApi: () => ({ dialogs: { confirm: state.confirm } }),
}));

import { useSettingsRestore } from "./SettingsPanels";

function RestoreSettings() {
  const { changedSettingLabels, restoreDefaults } = useSettingsRestore();
  return (
    <>
      <p>{changedSettingLabels.join(", ")}</p>
      <button disabled={changedSettingLabels.length === 0} onClick={restoreDefaults}>
        Restore device defaults
      </button>
    </>
  );
}

function setup() {
  state.settings = { ...DEFAULT_UNIFIED_SETTINGS, notificationSoundTheme: "retro" };
  state.confirm.mockClear();
}

it("restores a retained sound theme even when notifications are off", async () => {
  setup();
  await using screen = await render(<RestoreSettings />);

  await expect.element(screen.getByText("Sound theme", { exact: true })).toBeVisible();
  await screen.getByRole("button", { name: "Restore device defaults" }).click();
  await vi.waitFor(() => expect(state.settings?.notificationSoundTheme).toBe("default"));
  expect(state.confirm).toHaveBeenCalledWith(expect.stringContaining("Sound theme"), {
    variant: "destructive",
  });
});
