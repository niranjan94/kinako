import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";

import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";

const NO_COLLAPSED_GROUPS: readonly string[] = [];

export function useThreadListV2ShelfPreferences() {
  const preferencesResult = useAtomValue(mobilePreferencesAtom);
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  const loaded = AsyncResult.isSuccess(preferencesResult);
  const snoozedShelfExpanded =
    loaded && preferencesResult.value.threadListSnoozedShelfExpanded === true;
  const settledShelfExpanded =
    loaded && preferencesResult.value.threadListSettledShelfExpanded === true;
  const workingShelfEnabled = loaded && preferencesResult.value.workingShelfEnabled === true;
  const workingShelfExpanded =
    loaded && preferencesResult.value.threadListWorkingShelfExpanded === true;
  const collapsedGroups = loaded
    ? (preferencesResult.value.threadListCollapsedGroups ?? NO_COLLAPSED_GROUPS)
    : NO_COLLAPSED_GROUPS;

  // A transform reads the optimistic value, so two presses before the next
  // render still toggle twice instead of writing the same value.
  const toggleSnoozedShelf = () => {
    if (!loaded) return;
    savePreferences({
      transform: (current) => ({
        threadListSnoozedShelfExpanded: current.threadListSnoozedShelfExpanded !== true,
      }),
    });
  };
  const toggleSettledShelf = () => {
    if (!loaded) return;
    savePreferences({
      transform: (current) => ({
        threadListSettledShelfExpanded: current.threadListSettledShelfExpanded !== true,
      }),
    });
  };
  const toggleWorkingShelf = () => {
    if (!loaded) return;
    savePreferences({
      transform: (current) => ({
        threadListWorkingShelfExpanded: current.threadListWorkingShelfExpanded !== true,
      }),
    });
  };

  const toggleGroup = (group: string) => {
    if (!loaded) return;
    savePreferences({
      transform: (current) => {
        const collapsed = current.threadListCollapsedGroups ?? [];
        return {
          threadListCollapsedGroups: collapsed.includes(group)
            ? collapsed.filter((name) => name !== group)
            : [...collapsed, group],
        };
      },
    });
  };
  const renameCollapsedGroup = (from: string, to: string) => {
    if (!loaded) return;
    savePreferences({
      transform: (current) => {
        const collapsed = current.threadListCollapsedGroups ?? [];
        return collapsed.includes(from)
          ? { threadListCollapsedGroups: [...collapsed.filter((name) => name !== from), to] }
          : {};
      },
    });
  };

  return {
    loaded,
    collapsedGroups,
    toggleGroup,
    renameCollapsedGroup,
    settledShelfExpanded,
    snoozedShelfExpanded,
    workingShelfEnabled,
    workingShelfExpanded,
    toggleSettledShelf,
    toggleSnoozedShelf,
    toggleWorkingShelf,
  } as const;
}
