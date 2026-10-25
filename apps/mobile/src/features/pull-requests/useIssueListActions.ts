import * as Clipboard from "expo-clipboard";
import { useCallback } from "react";
import { Keyboard, Linking, Platform, Share } from "react-native";
import type { MenuProps } from "../../components/ui/Menu.types";
import { useSelectWorkspaceDetail } from "../workspace/useSelectWorkspaceDetail";
import {
  issueHandoffMenuAction,
  parseIssueHandoffEvent,
  type HandoffIssueItem,
} from "./issueHandoffActions";
import type { EnvironmentIssueListEntry } from "./issueList";
import { openOnProviderLabel } from "./pullRequestActions";
import { useIssueHandoff } from "./useIssueHandoff";

export function issueRouteParams(item: EnvironmentIssueListEntry) {
  return {
    environmentId: String(item.environmentId),
    projectId: String(item.projectId),
    repository: item.repository,
    number: item.number,
    host: item.host,
    initialSummary: item,
  };
}

/** Opens an issue the way a pull request opens: as the workspace's detail page. */
export function useOpenIssue() {
  const selectDetail = useSelectWorkspaceDetail();
  return useCallback(
    (item: EnvironmentIssueListEntry) => {
      Keyboard.dismiss();
      selectDetail({ name: "Issue", params: issueRouteParams(item) });
    },
    [selectDetail],
  );
}

export function useIssueListActions() {
  const open = useOpenIssue();
  const handoff = useIssueHandoff();
  const { projectsFor, canStart, start } = handoff;
  const actions = useCallback(
    (entry: EnvironmentIssueListEntry): MenuProps["actions"] => {
      const projects = projectsFor(entry);
      const disabled = !canStart(entry.environmentId);
      return [
        {
          id: "open",
          title: "Open issue",
          image: Platform.OS === "ios" ? "arrow.up.right" : "open_in_new",
        },
        issueHandoffMenuAction(
          "send",
          projects,
          Platform.OS === "ios" ? "sparkles" : "auto_awesome",
          disabled,
        ),
        issueHandoffMenuAction(
          "ask",
          projects,
          Platform.OS === "ios" ? "questionmark.bubble" : "chat",
          disabled,
        ),
        {
          id: "share",
          title: "Share…",
          image: Platform.OS === "ios" ? "square.and.arrow.up" : "share",
        },
        { id: "copy", title: "Copy link", image: "link" },
        {
          id: "provider",
          title: openOnProviderLabel(entry.provider),
          image: Platform.OS === "ios" ? "safari" : "open_in_browser",
        },
      ];
    },
    [projectsFor, canStart],
  );
  const select = useCallback(
    (entry: EnvironmentIssueListEntry, action: string) => {
      const handoffEvent = parseIssueHandoffEvent(action);
      if (handoffEvent) {
        const issue: HandoffIssueItem = entry;
        void start(handoffEvent.mode, issue, handoffEvent.projectId);
        return;
      }
      if (action === "open") open(entry);
      else if (action === "copy") void Clipboard.setStringAsync(entry.url);
      else if (action === "provider") void Linking.openURL(entry.url);
      else if (action === "share")
        void Share.share(
          Platform.OS === "ios"
            ? { url: entry.url, title: entry.title }
            : { message: entry.url, title: entry.title },
        );
    },
    [open, start],
  );
  return { actions, select, busy: handoff.busy };
}
