import { useAtomValue } from "@effect/atom-react";
import {
  StackActions,
  useNavigation,
  useNavigationState,
  type StaticScreenProps,
} from "@react-navigation/native";
import {
  isAgentSessionRecentlyActive,
  supportsAgentSessionImport,
} from "@t3tools/client-runtime/agentSessionImport";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import type { AgentSessionListItem, ThreadId } from "@t3tools/contracts";
import * as Haptics from "expo-haptics";
import { useEffect, useState } from "react";
import { Alert, Platform, Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppActivityIndicator } from "../../components/AppActivityIndicator";
import { AndroidScreenHeader } from "../../components/AndroidScreenHeader";
import { AppText as Text } from "../../components/AppText";
import { EmptyState } from "../../components/EmptyState";
import { MaterialScreenContent } from "../../components/MaterialScreenContent";
import { ProviderIcon } from "../../components/ProviderIcon";
import { cn } from "../../lib/cn";
import { relativeTime } from "../../lib/time";
import { NativeHeaderToolbar, NativeStackScreenOptions } from "../../native/StackHeader";
import { useEnvironmentServerConfig, useProjects } from "../../state/entities";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";

type ImportCliSessionRouteParams = {
  readonly environmentId?: string | string[];
  readonly projectId?: string | string[];
};

const SCREEN_TITLE = "Import CLI session";

type SessionsResult =
  | { readonly status: "error"; readonly message: string }
  | {
      readonly status: "loaded";
      readonly sessions: ReadonlyArray<AgentSessionListItem>;
      readonly loadedAtMs: number;
    };

function firstParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function failureMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.length > 0 ? error.message : fallback;
}

export function ImportCliSessionRouteScreen({
  route,
}: StaticScreenProps<ImportCliSessionRouteParams | undefined>) {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const environmentId = firstParam(route.params?.environmentId);
  const projectId = firstParam(route.params?.projectId);
  const project = useProjects().find(
    (candidate) => candidate.environmentId === environmentId && candidate.id === projectId,
  );
  // Opened straight from the command palette, this is the sheet's first route,
  // so the native header has no back button to leave the sheet.
  const isSheetRoot = useNavigationState((state) => state.index === 0);

  return (
    <View className="flex-1 bg-sheet" collapsable={false}>
      <NativeStackScreenOptions
        options={{ headerShown: Platform.OS !== "android", title: SCREEN_TITLE }}
      />
      {isSheetRoot ? (
        <NativeHeaderToolbar placement="left">
          <NativeHeaderToolbar.Button
            accessibilityLabel="Cancel import"
            label="Cancel"
            onPress={() => (navigation.getParent() ?? navigation).goBack()}
          />
        </NativeHeaderToolbar>
      ) : null}
      {Platform.OS === "android" ? (
        <AndroidScreenHeader
          title={SCREEN_TITLE}
          hideBottomBorder
          onBack={() => navigation.goBack()}
        />
      ) : null}
      <MaterialScreenContent>
        <ScrollView
          contentInsetAdjustmentBehavior="automatic"
          contentContainerStyle={{
            gap: 12,
            paddingBottom: Math.max(insets.bottom, 16) + 16,
            paddingHorizontal: 16,
            paddingTop: 16,
          }}
          showsVerticalScrollIndicator={false}
        >
          {project ? (
            <ProjectSessions project={project} />
          ) : (
            <EmptyState
              title="Project unavailable"
              detail="This project is not on a connected environment."
            />
          )}
        </ScrollView>
      </MaterialScreenContent>
    </View>
  );
}

function ProjectSessions(props: { readonly project: EnvironmentProject }) {
  const { environmentId, id: projectId } = props.project;
  const navigation = useNavigation();
  const serverConfig = useEnvironmentServerConfig(environmentId);
  const supported = supportsAgentSessionImport(serverConfig);
  const canImport = useAtomValue(
    serverEnvironment.importAgentSession.permissionAtom(environmentId),
  );
  const listSessions = useAtomCommand(serverEnvironment.listAgentSessions, {
    label: "agent session list",
    reportFailure: false,
  });
  const importSession = useAtomCommand(serverEnvironment.importAgentSession, {
    label: "agent session import",
    reportFailure: false,
  });
  const [loadAttempt, setLoadAttempt] = useState(0);
  const requestKey = `${environmentId}:${projectId}:${loadAttempt}`;
  const [response, setResponse] = useState<{
    readonly requestKey: string;
    readonly result: SessionsResult;
  } | null>(null);
  const [importingKey, setImportingKey] = useState<string | null>(null);

  useEffect(() => {
    if (!supported) return;
    let active = true;
    void listSessions({ environmentId, input: { projectId } }).then((result) => {
      if (!active || isAtomCommandInterrupted(result)) return;
      setResponse({
        requestKey,
        result:
          result._tag === "Success"
            ? { status: "loaded", sessions: result.value.sessions, loadedAtMs: Date.now() }
            : {
                status: "error",
                message: failureMessage(
                  squashAtomCommandFailure(result),
                  "The sessions could not be loaded.",
                ),
              },
      });
    });
    return () => {
      active = false;
    };
  }, [environmentId, listSessions, projectId, requestKey, supported]);
  const state = response?.requestKey === requestKey ? response.result : null;

  const openThread = (threadId: ThreadId) => {
    (navigation.getParent() ?? navigation).dispatch(
      StackActions.replace("Thread", {
        environmentId: String(environmentId),
        threadId: String(threadId),
      }),
    );
  };

  const runImport = async (session: AgentSessionListItem) => {
    if (importingKey !== null) return;
    void Haptics.selectionAsync();
    setImportingKey(sessionKey(session));
    try {
      const result = await importSession({
        environmentId,
        input: {
          projectId,
          providerInstanceId: session.providerInstanceId,
          providerSessionId: session.providerSessionId,
        },
      });
      if (result._tag === "Success") {
        openThread(result.value.threadId);
        return;
      }
      if (!isAtomCommandInterrupted(result)) {
        Alert.alert(
          "Could not import session",
          failureMessage(squashAtomCommandFailure(result), "The session could not be imported."),
        );
      }
    } finally {
      setImportingKey(null);
    }
  };

  if (serverConfig === null) {
    return <LoadingState />;
  }
  if (!supported) {
    return (
      <EmptyState
        title="Not available on this environment"
        detail="Update T3 Code on this environment to import CLI sessions."
      />
    );
  }
  if (state === null) {
    return <LoadingState />;
  }
  if (state.status === "error") {
    return (
      <EmptyState
        title="Could not load sessions"
        detail={state.message}
        actionLabel="Try again"
        onAction={() => setLoadAttempt((attempt) => attempt + 1)}
      />
    );
  }
  if (state.sessions.length === 0) {
    return (
      <EmptyState
        title="No sessions"
        detail="No Claude Code or Codex sessions found for this folder."
      />
    );
  }

  return (
    <View
      className={
        Platform.OS === "android"
          ? "overflow-hidden rounded-[28px] bg-grouped-card"
          : "overflow-hidden rounded-2xl bg-grouped-card"
      }
    >
      {state.sessions.map((session, index) => {
        const key = sessionKey(session);
        const importedThreadId = session.importedThreadId;
        return (
          <SessionRow
            key={key}
            session={session}
            isLast={index === state.sessions.length - 1}
            recentlyActive={isAgentSessionRecentlyActive(session, state.loadedAtMs)}
            actionLabel={importedThreadId ? "Open" : "Import"}
            importing={importingKey === key}
            disabled={importedThreadId ? false : !canImport || importingKey !== null}
            onPress={() => {
              if (importedThreadId) openThread(importedThreadId);
              else void runImport(session);
            }}
          />
        );
      })}
    </View>
  );
}

function sessionKey(session: AgentSessionListItem): string {
  return `${session.providerInstanceId}:${session.providerSessionId}`;
}

function LoadingState() {
  return (
    <View className="items-center py-16">
      <AppActivityIndicator colorClassName="accent-icon" />
      <Text className="mt-3 text-sm text-foreground-muted">Loading sessions...</Text>
    </View>
  );
}

function SessionRow(props: {
  readonly session: AgentSessionListItem;
  readonly isLast: boolean;
  readonly recentlyActive: boolean;
  readonly actionLabel: string;
  readonly importing: boolean;
  readonly disabled: boolean;
  readonly onPress: () => void;
}) {
  const title = props.session.title.trim() || "Untitled session";
  const providerLabel = props.session.provider === "claudeAgent" ? "Claude Code" : "Codex";
  const subtitle = `${providerLabel} · ${relativeTime(props.session.updatedAt)}`;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${props.actionLabel} ${title}, ${subtitle}`}
      accessibilityState={{ disabled: props.disabled, busy: props.importing }}
      className={cn(
        "min-h-14 flex-row items-center gap-3 bg-grouped-card px-4 py-3 active:bg-subtle",
        !props.isLast && "border-b border-border-subtle",
      )}
      disabled={props.disabled}
      onPress={props.onPress}
    >
      <ProviderIcon provider={props.session.provider} size={Platform.OS === "android" ? 24 : 18} />
      <View className="min-w-0 flex-1 gap-0.5">
        <Text className="text-base font-t3-medium text-foreground" numberOfLines={2}>
          {title}
        </Text>
        <Text className="text-xs text-foreground-muted" numberOfLines={1}>
          {subtitle}
        </Text>
        {props.recentlyActive ? (
          <Text className="text-xs font-t3-medium text-warning-foreground">
            May still be open in a terminal. Close it there first.
          </Text>
        ) : null}
      </View>
      {props.importing ? (
        <AppActivityIndicator colorClassName="accent-icon-muted" />
      ) : (
        <Text
          className={cn(
            "text-sm font-t3-bold",
            props.disabled ? "text-foreground-muted" : "text-primary-text",
          )}
        >
          {props.actionLabel}
        </Text>
      )}
    </Pressable>
  );
}
