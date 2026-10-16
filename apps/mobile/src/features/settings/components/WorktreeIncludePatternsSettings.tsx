import type { ServerSettingsPatch } from "@t3tools/contracts";
import { useRef } from "react";
import { View } from "react-native";

import { AppText as Text, AppTextInput } from "../../../components/ui/AppText";
import { SettingsSection } from "./SettingsSection";

export function WorktreeIncludePatternsSettings(props: {
  patterns: string | null;
  disabled: boolean;
  onChange: (patch: ServerSettingsPatch) => void;
}) {
  const edited = useRef(false);
  return (
    <SettingsSection
      title="Files to copy"
      trailing={
        props.patterns === null ? (
          <Text className="text-xs text-foreground-muted">Mixed</Text>
        ) : null
      }
    >
      <View className="gap-2 px-4 py-3">
        <Text className="text-sm text-foreground-muted">
          Gitignored files to copy from the main checkout into new worktrees, one .gitignore pattern
          per line. A repository's .worktreeinclude file replaces this list.
        </Text>
        <AppTextInput
          key={props.patterns}
          accessibilityLabel="Files to copy"
          onChangeText={() => {
            edited.current = true;
          }}
          defaultValue={props.patterns ?? ""}
          placeholder={
            props.patterns === null
              ? "Mixed. Enter patterns for all selected targets."
              : ".env*\nconfig/local.json"
          }
          editable={!props.disabled}
          multiline
          autoCapitalize="none"
          autoCorrect={false}
          className="min-h-24 rounded-xl px-3 py-2 text-base text-foreground"
          onEndEditing={(event) => {
            const value = event.nativeEvent.text.trim();
            if (
              !props.disabled &&
              edited.current &&
              (props.patterns === null || value !== props.patterns)
            )
              props.onChange({ worktreeIncludePatterns: value });
            edited.current = false;
          }}
        />
      </View>
    </SettingsSection>
  );
}
