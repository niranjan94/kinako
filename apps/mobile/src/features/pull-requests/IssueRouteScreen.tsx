import { useAtomValue } from "@effect/atom-react";
import { useFocusEffect, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import {
  EnvironmentId,
  ProjectId,
  type IssueDetail,
  type IssueListEntry,
} from "@t3tools/contracts";
import { useCallback, useState, type ReactElement } from "react";
import { Linking, Platform, Pressable, RefreshControl, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AndroidScreenHeader } from "../../components/ui/AndroidScreenHeader";
import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import { Button } from "../../components/ui/Button";
import { EmptyState } from "../../components/ui/EmptyState";
import { IconButton } from "../../components/ui/IconButton";
import { Menu } from "../../components/ui/Menu";
import { Toolbar } from "../../components/ui/Toolbar";
import { useAndroidControlSizing } from "../../components/ui/useAndroidControlSizing";
import { relativeTime } from "../../lib/time";
import { NativeScrollViewMarker as ScrollViewMarker } from "../../native/NativeScrollViewMarker";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { composerPullRequests } from "../../state/pull-requests";
import { useEnvironmentQuery } from "../../state/query";
import { usePullToRefresh } from "../../state/use-pull-to-refresh";
import { useAdaptiveWorkspaceLayout } from "../layout/AdaptiveWorkspaceLayout";
import { AndroidWorkspaceSidebarButton } from "../layout/workspace-sidebar-toolbar";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import { useAndroidWorkspaceBack } from "../workspace/useAndroidWorkspaceNavigation";
import {
  issueHandoffProjectActions,
  parseIssueHandoffEvent,
  type HandoffIssueItem,
  type IssueHandoffMode,
} from "./issueHandoffActions";
import { issueTarget, type IssueParams } from "./issueRoute";
import { issueStatus } from "./issueStatus";
import { openOnProviderLabel } from "./pullRequestActions";
import { PullRequestDescription } from "./PullRequestDescription";
import { pullRequestLabelColor } from "./pullRequestList";
import { PullRequestMarkdownRepository } from "./PullRequestMarkdown";
import { PullRequestAvatar } from "./PullRequestPresentation";
import { PullRequestSectionHeading } from "./PullRequestSectionHeading";
import { TimelineComment } from "./PullRequestTimeline";
import { usePullRequestConnected } from "./usePullRequestConnected";
import { usePullRequestEnvironmentFallback } from "./usePullRequestEnvironmentFallback";
import { useIssueHandoff } from "./useIssueHandoff";

function IssueIdentity(props: { readonly issue: IssueDetail | IssueListEntry }) {
  const { issue } = props;
  const status = issueStatus(issue.state);
  return (
    <View className="gap-3">
      <View className="min-h-8 flex-row items-center gap-1.5">
        <SymbolView name={status.icon} size={14} tintColorClassName={status.tint} />
        <Text className={`text-xs font-t3-medium ${status.text}`}>{status.label}</Text>
        <Text className="min-w-0 flex-1 text-2xs text-foreground-muted" numberOfLines={1}>
          {" "}
          · {issue.repository}#{issue.number}
        </Text>
      </View>
      <Text selectable className="text-xl font-t3-bold leading-7">
        {issue.title}
      </Text>
      <View className="flex-row items-center gap-2">
        <PullRequestAvatar actor={issue.author} size={20} />
        <Text className="min-w-0 flex-1 text-xs font-t3-medium" numberOfLines={1}>
          {issue.author?.login ?? "Unknown author"}
        </Text>
        <Text className="shrink text-right text-2xs text-foreground-muted" numberOfLines={1}>
          Updated {relativeTime(issue.updatedAt)} ago
        </Text>
      </View>
      {issue.labels.length ? (
        <View className="flex-row flex-wrap gap-2">
          {issue.labels.map((label) => {
            const color = pullRequestLabelColor(label.color);
            return (
              <View
                key={label.name}
                className="flex-row items-center gap-1.5 rounded-full bg-grouped-card px-3 py-1"
                style={color ? { backgroundColor: `${color}20` } : undefined}
              >
                {color ? (
                  <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: color }} />
                ) : null}
                <Text className="text-2xs text-foreground-muted">{label.name}</Text>
              </View>
            );
          })}
        </View>
      ) : null}
      {issue.assignees.length ? (
        <View className="flex-row flex-wrap items-center gap-2">
          <Text className="text-2xs text-foreground-muted">Assigned to</Text>
          {issue.assignees.map((assignee) => (
            <View key={assignee.login} className="flex-row items-center gap-1">
              <PullRequestAvatar actor={assignee} size={16} />
              <Text className="text-2xs font-t3-medium">{assignee.login}</Text>
            </View>
          ))}
        </View>
      ) : null}
    </View>
  );
}

function IssueActionToolbar(props: {
  readonly issue: HandoffIssueItem | null;
  readonly onHeightChange: (height: number) => void;
}) {
  const insets = useSafeAreaInsets();
  const { themeVariables: colors } = useAppearancePreferences();
  const handoff = useIssueHandoff();
  const { issue } = props;
  if (!issue || !handoff.canStart(issue.environmentId)) return null;
  const projects = handoff.projectsFor(issue);
  const disabled = handoff.busy || projects.length === 0;
  const start = (mode: IssueHandoffMode, projectId?: string) =>
    void handoff.start(mode, issue, projectId);
  const select = (event: string) => {
    const parsed = parseIssueHandoffEvent(event);
    if (parsed) start(parsed.mode, parsed.projectId);
  };
  const choose = projects.length > 1;
  if (Platform.OS === "android") {
    const send = (
      <Button
        label="Send to agent"
        tone="primary"
        disabled={disabled}
        onPress={() => {
          if (!choose) start("send");
        }}
      />
    );
    const ask = (
      <IconButton
        icon="questionmark.bubble"
        accessibilityLabel="Ask about issue"
        disabled={disabled}
        onPress={() => {
          if (!choose) start("ask");
        }}
      />
    );
    const menu = (mode: IssueHandoffMode, child: ReactElement) =>
      choose ? (
        <Menu
          title="Choose a project"
          actions={issueHandoffProjectActions(mode, projects)}
          onPressAction={({ nativeEvent }) => select(nativeEvent.event)}
        >
          <View pointerEvents="none">{child}</View>
        </Menu>
      ) : (
        child
      );
    return (
      <View
        pointerEvents="box-none"
        className="absolute inset-x-0 bottom-0 z-10 items-center px-4 pt-2"
        style={{ paddingBottom: insets.bottom + 16 }}
        onLayout={(event) => props.onHeightChange(event.nativeEvent.layout.height)}
      >
        <Toolbar>
          <View className="flex-row items-center gap-2">
            {menu("ask", ask)}
            <View className="min-w-0 shrink">{menu("send", send)}</View>
          </View>
        </Toolbar>
      </View>
    );
  }
  const projectItems = (mode: IssueHandoffMode) =>
    projects.map((project) => (
      <Toolbar.MenuAction
        key={project.id}
        icon="folder"
        subtitle={project.workspaceRoot}
        onPress={() => start(mode, project.id)}
      >
        <Toolbar.Label>{project.title}</Toolbar.Label>
      </Toolbar.MenuAction>
    ));
  return (
    <Toolbar placement="bottom">
      {choose ? (
        <Toolbar.Menu
          identifier="issue-ask"
          icon="questionmark.bubble"
          title="Ask about issue"
          accessibilityLabel="Ask about issue"
          disabled={disabled}
          separateBackground
        >
          {projectItems("ask")}
        </Toolbar.Menu>
      ) : (
        <Toolbar.Button
          identifier="issue-ask"
          icon="questionmark.bubble"
          accessibilityLabel="Ask about issue"
          disabled={disabled}
          onPress={() => start("ask")}
          separateBackground
        />
      )}
      <Toolbar.Spacer flexible />
      {choose ? (
        <Toolbar.Menu
          identifier="issue-send"
          title="Send to agent"
          accessibilityLabel="Send to agent"
          variant="prominent"
          tintColor={colors["--color-prominent-action"]}
          disabled={disabled}
          separateBackground
        >
          {projectItems("send")}
        </Toolbar.Menu>
      ) : (
        <Toolbar.Button
          identifier="issue-send"
          label="Send to agent"
          accessibilityLabel="Send to agent"
          variant="prominent"
          tintColor={colors["--color-prominent-action"]}
          disabled={disabled}
          onPress={() => start("send")}
          separateBackground
        />
      )}
      <Toolbar.Spacer flexible />
    </Toolbar>
  );
}

export function IssueRouteScreen({ route }: StaticScreenProps<IssueParams>) {
  const returnToList = useAndroidWorkspaceBack("pullRequests");
  const { layout } = useAdaptiveWorkspaceLayout();
  const navigation = useNavigation();
  const params = route.params;
  usePullRequestEnvironmentFallback(params);
  const connected = usePullRequestConnected(params.environmentId);
  const target = issueTarget(params);
  const detailAtom = composerPullRequests.issueDetail(target);
  const result = useEnvironmentQuery(detailAtom);
  const pullRefresh = usePullToRefresh(detailAtom);
  const { refresh: refreshDetail } = result;
  useFocusEffect(useCallback(() => refreshDetail(), [refreshDetail]));
  const canPostComment = useAtomValue(
    composerPullRequests.issueComment.permissionAtom(target.environmentId),
  );
  const issue = result.data;
  const identity = issue ?? params.initialSummary ?? null;
  const canComment = connected && canPostComment && issue?.canComment === true;
  const [descriptionExpanded, setDescriptionExpanded] = useState(false);
  const { buttonSize } = useAndroidControlSizing();
  const insets = useSafeAreaInsets();
  const [toolbarHeight, setToolbarHeight] = useState(() =>
    Platform.OS === "android" ? insets.bottom + buttonSize + 40 : 0,
  );
  const handoffIssue: HandoffIssueItem | null = identity
    ? {
        environmentId: EnvironmentId.make(params.environmentId),
        projectId: ProjectId.make(params.projectId),
        host: identity.host,
        repository: identity.repository,
        number: identity.number,
        title: identity.title,
        url: identity.url,
        state: identity.state,
      }
    : null;
  const openComment = () => navigation.navigate("IssueComment", params);
  const providerLabel = identity ? openOnProviderLabel(identity.provider) : null;
  return (
    <PullRequestMarkdownRepository
      params={params}
      value={issue?.provider === "github" ? issue.url : null}
    >
      <View className={Platform.OS === "android" ? "flex-1 bg-header" : "flex-1 bg-screen"}>
        <NativeStackScreenOptions
          options={{
            title: `#${params.number}`,
            headerTitle: `#${params.number}`,
            unstable_headerSubtitle: connected
              ? params.repository
              : `${params.repository} · Offline`,
          }}
        />
        {Platform.OS === "android" ? (
          <AndroidScreenHeader
            title={`#${params.number}${connected ? "" : " · Offline"}`}
            subtitle={params.repository}
            onBack={layout.usesSplitView ? undefined : returnToList}
            leading={layout.usesSplitView ? <AndroidWorkspaceSidebarButton /> : undefined}
            actions={[
              ...(canComment
                ? [
                    {
                      accessibilityLabel: "Add comment",
                      icon: "plus.bubble" as const,
                      onPress: openComment,
                    },
                  ]
                : []),
              ...(identity && providerLabel
                ? [
                    {
                      accessibilityLabel: providerLabel,
                      icon: "arrow.up.right" as const,
                      onPress: () => void Linking.openURL(identity.url),
                    },
                  ]
                : []),
            ]}
          />
        ) : null}
        <Toolbar placement="right">
          <Toolbar.Menu title="Issue" accessibilityLabel="Issue actions" icon="ellipsis">
            {canComment ? (
              <Toolbar.MenuAction icon="plus.bubble" onPress={openComment}>
                <Toolbar.Label>Add comment</Toolbar.Label>
              </Toolbar.MenuAction>
            ) : null}
            {identity && providerLabel ? (
              <Toolbar.MenuAction
                icon="arrow.up.right"
                onPress={() => void Linking.openURL(identity.url)}
              >
                <Toolbar.Label>{providerLabel}</Toolbar.Label>
              </Toolbar.MenuAction>
            ) : null}
          </Toolbar.Menu>
        </Toolbar>
        <View
          className={
            Platform.OS === "android"
              ? "flex-1 overflow-hidden rounded-t-[28px] bg-sheet-solid"
              : "flex-1"
          }
          style={{ marginHorizontal: Platform.OS === "android" && layout.usesSplitView ? 4 : 0 }}
        >
          <ScrollViewMarker style={{ flex: 1 }}>
            <ScrollView
              className="flex-1"
              contentInsetAdjustmentBehavior="automatic"
              alwaysBounceVertical
              refreshControl={
                <RefreshControl
                  refreshing={pullRefresh.refreshing}
                  onRefresh={pullRefresh.onRefresh}
                />
              }
              contentContainerStyle={{
                paddingHorizontal: 16,
                paddingTop: 8,
                paddingBottom: 24 + toolbarHeight,
                gap: 20,
              }}
            >
              {identity ? (
                <IssueIdentity issue={identity} />
              ) : result.isPending ? (
                <AppActivityIndicator className="my-12" colorClassName="accent-icon" />
              ) : null}
              {result.error && !issue ? (
                <EmptyState
                  title={connected ? "Couldn't load this issue" : "Environment offline"}
                  detail={
                    connected
                      ? result.error
                      : "Reconnect to load this issue. Only issues read before are saved on this device."
                  }
                  variant="plain"
                />
              ) : null}
              {issue ? (
                <>
                  <PullRequestDescription
                    markdown={issue.body}
                    onCollapse={() => undefined}
                    expanded={descriptionExpanded}
                    onExpandedChange={setDescriptionExpanded}
                  />
                  <View className="gap-3">
                    <PullRequestSectionHeading>
                      {issue.comments.length
                        ? `Comments · ${issue.commentCount}`
                        : "No comments yet"}
                    </PullRequestSectionHeading>
                    <View>
                      {issue.comments.map((comment) => (
                        <TimelineComment key={comment.id} comment={comment} />
                      ))}
                    </View>
                    {issue.commentsTruncated ? (
                      <Pressable
                        accessibilityRole="link"
                        onPress={() => void Linking.openURL(issue.url)}
                        className="py-2 active:opacity-70"
                      >
                        <Text className="text-xs text-foreground-muted">
                          Showing the first {issue.comments.length} comments.{" "}
                          <Text className="text-xs font-t3-medium text-link">
                            {openOnProviderLabel(issue.provider)}
                          </Text>{" "}
                          to read the rest.
                        </Text>
                      </Pressable>
                    ) : null}
                  </View>
                </>
              ) : identity && result.isPending ? (
                <AppActivityIndicator className="my-8" colorClassName="accent-icon" />
              ) : null}
            </ScrollView>
          </ScrollViewMarker>
        </View>
        <IssueActionToolbar issue={handoffIssue} onHeightChange={setToolbarHeight} />
      </View>
    </PullRequestMarkdownRepository>
  );
}
