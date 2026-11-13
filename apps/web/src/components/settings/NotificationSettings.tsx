import { settlePromise } from "@t3tools/client-runtime/state/runtime";
import { NotificationSoundTheme } from "@t3tools/contracts/settings";
import * as Schema from "effect/Schema";
import { PlayIcon } from "lucide-react";
import { useState } from "react";

import {
  hasDesktopNotifications,
  hasNotificationSound,
  NOTIFICATION_MODE_LABELS,
  playNotificationSound,
  unlockNotificationAudio,
} from "../../threadNotifications";
import { getClientSettings } from "../../hooks/useSettings";
import { NOTIFICATION_SOUND_THEMES } from "../../notificationSounds";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";
import { APP_BASE_NAME } from "~/branding";

const isNotificationSoundTheme = Schema.is(NotificationSoundTheme);

export function NotificationSettings() {
  const mode = useScopedSettings((settings) => settings.notificationMode);
  const theme = useScopedSettings((settings) => settings.notificationSoundTheme);
  const updateSettings = useUpdateScopedSettings();
  const [permissionMessage, setPermissionMessage] = useState<string | null>(null);
  const [requesting, setRequesting] = useState(false);

  return (
    <>
      <SettingsRow
        {...searchableSetting("thread-notifications")}
        description={
          permissionMessage ??
          `System alerts when a thread finishes, fails, or needs input or approval. Applies to this device while ${APP_BASE_NAME} is open.`
        }
        control={
          <Select
            value={mode}
            disabled={requesting}
            onValueChange={async (value) => {
              if (
                value !== "off" &&
                value !== "notifications" &&
                value !== "sound" &&
                value !== "notifications-and-sound"
              )
                return;
              setPermissionMessage(null);
              if (hasNotificationSound(value)) unlockNotificationAudio(theme);
              if (hasDesktopNotifications(value)) {
                if (typeof Notification === "undefined" || !window.isSecureContext) {
                  setPermissionMessage(
                    "Notifications need a supported browser over HTTPS, or the desktop app. Sound only is still available.",
                  );
                  return;
                }
                setRequesting(true);
                const permission = await settlePromise(() => Notification.requestPermission());
                setRequesting(false);
                if (permission._tag === "Failure") {
                  setPermissionMessage(
                    "Notifications are unavailable in this browser. Sound only is still available.",
                  );
                  return;
                }
                if (permission.value !== "granted") {
                  setPermissionMessage(
                    "Allow notifications in your browser or system settings, then choose this option again. Sound only is still available.",
                  );
                  return;
                }
              }
              updateSettings({ notificationMode: value });
            }}
          >
            <SelectTrigger size="sm" className="w-full sm:w-56" aria-label="Thread notifications">
              <SelectValue>{NOTIFICATION_MODE_LABELS[mode]}</SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              {Object.entries(NOTIFICATION_MODE_LABELS).map(([value, label]) => (
                <SelectItem key={value} hideIndicator value={value}>
                  {label}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
      />
      {hasNotificationSound(mode) && (
        <SettingsRow
          title="Sound theme"
          description={
            <>
              Choose a pair for completed threads and threads needing attention. Additional themes
              from{" "}
              <a
                href="https://www.sounds.sh"
                target="_blank"
                rel="noreferrer"
                className="underline underline-offset-2"
              >
                sounds.sh
              </a>
              .
            </>
          }
          control={
            <div className="flex w-full flex-col gap-2 sm:w-56">
              <Select
                value={theme}
                onValueChange={(value) => {
                  if (!isNotificationSoundTheme(value)) return;
                  unlockNotificationAudio(value);
                  updateSettings({ notificationSoundTheme: value });
                }}
              >
                <SelectTrigger size="sm" aria-label="Notification sound theme">
                  <SelectValue>{NOTIFICATION_SOUND_THEMES[theme].label}</SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  {Object.entries(NOTIFICATION_SOUND_THEMES).map(([value, soundTheme]) => (
                    <SelectItem key={value} hideIndicator value={value}>
                      {soundTheme.label}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
              <div className="flex flex-wrap gap-2">
                {(["completion", "input"] as const).map((kind) => (
                  <Button
                    key={kind}
                    variant="outline"
                    size="xs"
                    aria-label={`Preview ${kind === "completion" ? "completion" : "attention"} sound`}
                    onClick={async () => {
                      await unlockNotificationAudio(theme);
                      void playNotificationSound(
                        kind,
                        () => {
                          const current = getClientSettings();
                          return (
                            hasNotificationSound(current.notificationMode) &&
                            current.notificationSoundTheme === theme
                          );
                        },
                        theme,
                      );
                    }}
                  >
                    <PlayIcon aria-hidden="true" />
                    {kind === "completion" ? "Completed" : "Attention"}
                  </Button>
                ))}
              </div>
            </div>
          }
        />
      )}
    </>
  );
}
