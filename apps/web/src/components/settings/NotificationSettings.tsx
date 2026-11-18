import { settlePromise } from "@t3tools/client-runtime/state/runtime";
import { NotificationSoundTheme } from "@t3tools/contracts/settings";
import * as Schema from "effect/Schema";
import { PlayIcon } from "lucide-react";
import { T, useGT, useMessages } from "gt-react";
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
import { useSearchableSetting } from "./settingsSearch";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";
import { APP_BASE_NAME } from "~/branding";

const isNotificationSoundTheme = Schema.is(NotificationSoundTheme);

export function NotificationSettings() {
  const searchableSetting = useSearchableSetting();
  const gt = useGT();
  const m = useMessages();
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
          gt(
            "System alerts when a thread finishes, fails, or needs input or approval. Applies to this device while {app} is open.",
            { app: APP_BASE_NAME },
          )
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
                    gt(
                      "Notifications need a supported browser over HTTPS, or the desktop app. Sound only is still available.",
                    ),
                  );
                  return;
                }
                setRequesting(true);
                const permission = await settlePromise(() => Notification.requestPermission());
                setRequesting(false);
                if (permission._tag === "Failure") {
                  setPermissionMessage(
                    gt(
                      "Notifications are unavailable in this browser. Sound only is still available.",
                    ),
                  );
                  return;
                }
                if (permission.value !== "granted") {
                  setPermissionMessage(
                    gt(
                      "Allow notifications in your browser or system settings, then choose this option again. Sound only is still available.",
                    ),
                  );
                  return;
                }
              }
              updateSettings({ notificationMode: value });
            }}
          >
            <SelectTrigger
              size="sm"
              className="w-full sm:w-56"
              aria-label={gt("Thread notifications")}
            >
              <SelectValue>{m(NOTIFICATION_MODE_LABELS[mode])}</SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              {Object.entries(NOTIFICATION_MODE_LABELS).map(([value, label]) => (
                <SelectItem key={value} hideIndicator value={value}>
                  {m(label)}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
      />
      {hasNotificationSound(mode) && (
        <SettingsRow
          title={gt("Sound theme")}
          description={
            <T>
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
            </T>
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
                <SelectTrigger size="sm" aria-label={gt("Notification sound theme")}>
                  <SelectValue>{m(NOTIFICATION_SOUND_THEMES[theme].label)}</SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  {Object.entries(NOTIFICATION_SOUND_THEMES).map(([value, soundTheme]) => (
                    <SelectItem key={value} hideIndicator value={value}>
                      {m(soundTheme.label)}
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
                    aria-label={
                      kind === "completion"
                        ? gt("Preview completion sound")
                        : gt("Preview attention sound")
                    }
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
                    {kind === "completion"
                      ? gt("Completed", { $context: "sound preview button" })
                      : gt("Attention", { $context: "sound preview button" })}
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
