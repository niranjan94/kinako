import { CommonActions, useNavigation, useRoute, StackActions } from "@react-navigation/native";
import { nativePullRequestDestination } from "../lib/pullRequestNavigation";
import { useCallback } from "react";
import { Platform } from "react-native";
import { resetAndroidWorkspace } from "../lib/android-workspace-navigation";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useThreadShell } from "../state/entities";
import { tryOpenExternalUrl } from "../lib/openExternalUrl";

type PullRequestContext = { readonly environmentId: string; readonly projectId: string };

// Route-free so navigator layouts such as the workspace sidebar, which have no
// route context for useRoute, can open pull requests for any thread.
export function useNavigateToPullRequest(options?: { readonly replace?: boolean }) {
  const navigation = useNavigation();
  const replace = options?.replace;
  return useCallback(
    async (url: string, context: PullRequestContext | null) => {
      const destination = nativePullRequestDestination(url, context);
      if (!destination) return tryOpenExternalUrl(url, "pull-request");
      if (Platform.OS === "android") resetAndroidWorkspace(navigation, destination);
      else if (replace)
        navigation.dispatch(StackActions.replace(destination.name, destination.params));
      else navigation.dispatch(CommonActions.navigate(destination));
      return true;
    },
    [navigation, replace],
  );
}

export function useOpenPullRequest(options?: {
  readonly replace?: boolean;
  readonly context?: PullRequestContext;
}) {
  const route = useRoute();
  const routeContext = route.params as
    | {
        environmentId?: string | string[];
        projectId?: string | string[];
        threadId?: string | string[];
      }
    | undefined;
  const first = (value: string | string[] | undefined) => {
    const text = Array.isArray(value) ? value[0] : value;
    return text?.trim() ? text : undefined;
  };
  const environmentId = options?.context?.environmentId ?? first(routeContext?.environmentId);
  const threadId = first(routeContext?.threadId);
  const thread = useThreadShell(
    environmentId && threadId
      ? { environmentId: EnvironmentId.make(environmentId), threadId: ThreadId.make(threadId) }
      : null,
  );
  const projectId =
    options?.context?.projectId ?? first(routeContext?.projectId) ?? thread?.projectId;
  const navigateToPullRequest = useNavigateToPullRequest({ replace: options?.replace });
  return useCallback(
    (url: string) =>
      navigateToPullRequest(
        url,
        environmentId && projectId
          ? { environmentId: String(environmentId), projectId: String(projectId) }
          : null,
      ),
    [environmentId, projectId, navigateToPullRequest],
  );
}
