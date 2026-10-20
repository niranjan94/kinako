import { useAtomValue } from "@effect/atom-react";
import {
  useNavigation,
  useNavigationState,
  type StaticScreenProps,
} from "@react-navigation/native";
import {
  AGENT_SESSION_AGE_WINDOWS,
  AgentSessionProjectCreateInterrupted,
  DEFAULT_AGENT_SESSION_AGE_WINDOW,
  EMPTY_AGENT_SESSION_IMPORT_PROGRESS,
  agentSessionImportRetryPlan,
  agentSessionKey,
  applyAgentSessionImportEvent,
  createAgentSessionProjectEnsurer,
  groupAgentSessionProjects,
  runAgentSessionHistoryImport,
  summarizeAgentSessionImport,
  supportsAgentSessionHistoryImport,
  type AgentSessionAgeWindow,
  type AgentSessionImportFolder,
  type AgentSessionImportProgress,
} from "@t3tools/client-runtime/agentSessionHistoryImport";
import { buildProjectCreateCommand } from "@t3tools/client-runtime/operations/projects";
import { findProjectByPath } from "@t3tools/client-runtime/state/projects";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  CommandId,
  EnvironmentId,
  ProjectId,
  type AgentSessionProjectCandidate,
  type AgentSessionScanResult,
} from "@t3tools/contracts";
import { FORK_DISPLAY_NAME } from "@t3tools/shared/forkBrand";
import * as Haptics from "expo-haptics";
import { useEffect, useRef, useState } from "react";
import { Platform, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AndroidScreenHeader } from "../../components/ui/AndroidScreenHeader";
import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { EmptyState } from "../../components/ui/EmptyState";
import { ListSection } from "../../components/ui/ListSection";
import { ListToggleRow } from "../../components/ui/ListToggleRow";
import { ScreenContent } from "../../components/ui/ScreenContent";
import { SegmentedControl } from "../../components/ui/SegmentedControl";
import { Toolbar } from "../../components/ui/Toolbar";
import { uuidv4 } from "../../lib/uuid";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { appAtomRegistry } from "../../state/atom-registry";
import { useEnvironmentServerConfig } from "../../state/entities";
import { useEnvironments } from "../../state/environments";
import { environmentProjects, projectEnvironment } from "../../state/projects";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";

type ImportCliHistoryRouteParams = {
  readonly environmentId?: string | string[];
};

const SCREEN_TITLE = "Import CLI history";

type ScanState =
  | { readonly status: "error"; readonly message: string }
  | { readonly status: "loaded"; readonly scan: AgentSessionScanResult };

function maxAgeInputFor(ageWindow: AgentSessionAgeWindow) {
  return ageWindow.maxAgeMs === undefined ? {} : { maxAgeMs: ageWindow.maxAgeMs };
}

function firstParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function failureMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.length > 0 ? error.message : fallback;
}

export function ImportCliHistoryRouteScreen({
  route,
}: StaticScreenProps<ImportCliHistoryRouteParams | undefined>) {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const environmentId = firstParam(route.params?.environmentId);
  const isSheetRoot = useNavigationState((state) => state.index === 0);

  return (
    <View className="flex-1 bg-sheet" collapsable={false}>
      <NativeStackScreenOptions
        options={{ headerShown: Platform.OS !== "android", title: SCREEN_TITLE }}
      />
      {isSheetRoot ? (
        <Toolbar placement="left">
          <Toolbar.Button
            accessibilityLabel="Close import"
            label="Close"
            onPress={() => (navigation.getParent() ?? navigation).goBack()}
          />
        </Toolbar>
      ) : null}
      {Platform.OS === "android" ? (
        <AndroidScreenHeader
          title={SCREEN_TITLE}
          hideBottomBorder
          onBack={() => navigation.goBack()}
        />
      ) : null}
      <ScreenContent>
        <ScrollView
          contentInsetAdjustmentBehavior="automatic"
          contentContainerStyle={{
            gap: 16,
            paddingBottom: Math.max(insets.bottom, 16) + 16,
            paddingHorizontal: 16,
            paddingTop: 16,
          }}
          showsVerticalScrollIndicator={false}
        >
          {environmentId ? (
            <HistoryImport environmentId={EnvironmentId.make(environmentId)} />
          ) : (
            <EmptyState
              title="Environment unavailable"
              detail="Choose a connected environment first."
            />
          )}
        </ScrollView>
      </ScreenContent>
    </View>
  );
}

function HistoryImport(props: { readonly environmentId: EnvironmentId }) {
  const { environmentId } = props;
  const serverConfig = useEnvironmentServerConfig(environmentId);
  const supported = supportsAgentSessionHistoryImport(serverConfig);
  const environmentLabel =
    useEnvironments().environments.find(
      (environment) => environment.environmentId === environmentId,
    )?.label ?? "this environment";
  const canImport = useAtomValue(
    serverEnvironment.importAgentSession.permissionAtom(environmentId),
  );
  const scanSessions = useAtomCommand(serverEnvironment.scanAgentSessions, {
    label: "agent session scan",
    reportFailure: false,
  });
  const listSessions = useAtomCommand(serverEnvironment.listAgentSessions, {
    label: "agent session list",
    reportFailure: false,
  });
  const importSession = useAtomCommand(serverEnvironment.importAgentSession, {
    label: "agent session import",
    reportFailure: false,
  });
  const createProject = useAtomCommand(projectEnvironment.create, { reportFailure: false });

  const [ageWindow, setAgeWindow] = useState<AgentSessionAgeWindow>(
    DEFAULT_AGENT_SESSION_AGE_WINDOW,
  );
  const [scanAttempt, setScanAttempt] = useState(0);
  const scanRequestKey = `${environmentId}:${ageWindow.key}:${scanAttempt}`;
  const [scanResponse, setScanResponse] = useState<{
    readonly requestKey: string;
    readonly state: ScanState;
  } | null>(null);
  const [selectedPaths, setSelectedPaths] = useState<ReadonlySet<string>>(() => new Set());
  const [progress, setProgress] = useState<AgentSessionImportProgress | null>(null);
  const [running, setRunning] = useState(false);
  const [stopping, setStopping] = useState(false);
  const stopRef = useRef(false);
  const ensureProjectRef = useRef<ReturnType<typeof createAgentSessionProjectEnsurer> | null>(null);
  const maxAgeInput = maxAgeInputFor(ageWindow);

  useEffect(() => {
    if (!supported) return;
    let active = true;
    void scanSessions({ environmentId, input: maxAgeInputFor(ageWindow) }).then((result) => {
      if (!active) return;
      setScanResponse({
        requestKey: scanRequestKey,
        state:
          result._tag === "Success"
            ? { status: "loaded", scan: result.value }
            : {
                status: "error",
                message: isAtomCommandInterrupted(result)
                  ? "Scanning was interrupted."
                  : failureMessage(
                      squashAtomCommandFailure(result),
                      "The folders could not be scanned.",
                    ),
              },
      });
    });
    return () => {
      active = false;
    };
  }, [ageWindow, environmentId, scanRequestKey, scanSessions, supported]);
  const scanState = scanResponse?.requestKey === scanRequestKey ? scanResponse.state : null;

  const ensureProject = () => {
    if (ensureProjectRef.current !== null) return ensureProjectRef.current;
    ensureProjectRef.current = createAgentSessionProjectEnsurer({
      findProjectId: (path) =>
        findProjectByPath(
          appAtomRegistry
            .get(environmentProjects.projectsAtom)
            .filter((project) => project.environmentId === environmentId),
          path,
        )?.id ?? null,
      newIds: () => ({
        projectId: ProjectId.make(uuidv4()),
        commandId: CommandId.make(uuidv4()),
      }),
      createProject: async ({ projectId, commandId, folder }) => {
        const result = await createProject({
          environmentId,
          input: {
            ...buildProjectCreateCommand({ commandId, projectId, workspaceRoot: folder.path }),
            title: folder.title,
            createWorkspaceRootIfMissing: false,
          },
        });
        if (result._tag === "Success") return;
        if (isAtomCommandInterrupted(result)) throw new AgentSessionProjectCreateInterrupted();
        throw new Error(
          failureMessage(squashAtomCommandFailure(result), "Could not add the project."),
        );
      },
    });
    return ensureProjectRef.current;
  };

  const runImport = async (plan: ReadonlyArray<AgentSessionImportFolder>) => {
    if (running || plan.length === 0) return;
    void Haptics.selectionAsync();
    stopRef.current = false;
    setStopping(false);
    setRunning(true);
    setProgress((current) => current ?? EMPTY_AGENT_SESSION_IMPORT_PROGRESS);
    await runAgentSessionHistoryImport(plan, {
      nowMs: Date.now,
      listSessions: async (folder, cursor) => {
        const result = await listSessions({
          environmentId,
          input: {
            workspaceRoot: folder.path,
            ...maxAgeInput,
            ...(cursor === undefined ? {} : { cursor }),
          },
        });
        if (result._tag === "Success") return result.value;
        throw new Error(
          isAtomCommandInterrupted(result)
            ? "Listing sessions was interrupted."
            : failureMessage(squashAtomCommandFailure(result), "Could not list sessions."),
        );
      },
      ensureProject: ensureProject(),
      importSession: async (projectId, session) => {
        const result = await importSession({
          environmentId,
          input: {
            projectId,
            providerInstanceId: session.providerInstanceId,
            providerSessionId: session.providerSessionId,
          },
        });
        if (result._tag === "Success") return result.value;
        throw new Error(
          isAtomCommandInterrupted(result)
            ? "The import was interrupted."
            : failureMessage(squashAtomCommandFailure(result), "Could not import the session."),
        );
      },
      shouldStop: () => stopRef.current,
      onEvent: (event) =>
        setProgress((current) =>
          applyAgentSessionImportEvent(current ?? EMPTY_AGENT_SESSION_IMPORT_PROGRESS, event),
        ),
    }).finally(() => {
      setRunning(false);
      setStopping(false);
      setSelectedPaths(new Set());
      setScanAttempt((attempt) => attempt + 1);
    });
  };

  if (serverConfig === null) return <LoadingState label="Loading..." />;
  if (!supported) {
    return (
      <EmptyState
        title="Not available on this environment"
        detail={`Update ${FORK_DISPLAY_NAME} on this environment to import CLI history.`}
      />
    );
  }

  const candidates = scanState?.status === "loaded" ? scanState.scan.candidates : [];
  const { repositories, other } = groupAgentSessionProjects(candidates);
  const sections = [
    ...repositories.map((group) => ({
      key: group.key,
      title: group.label,
      items: group.candidates,
    })),
    ...(other.length > 0 ? [{ key: "other", title: "Other folders", items: other }] : []),
  ];
  const plan: ReadonlyArray<AgentSessionImportFolder> = candidates
    .filter((candidate) => selectedPaths.has(candidate.path))
    .map((candidate) => ({
      path: candidate.path,
      title: candidate.title,
      projectId: candidate.projectId ?? null,
      selection: "all",
    }));
  const retryPlan = progress === null ? [] : agentSessionImportRetryPlan(progress);
  const summary = progress === null ? null : summarizeAgentSessionImport(progress);
  const failures =
    progress === null
      ? []
      : [
          ...[...progress.failedFolders.values()].map(({ folder, reason }) => ({
            key: `folder:${folder.path}`,
            label: folder.title,
            reason,
          })),
          ...[...progress.sessions.values()].flatMap(({ folder, session, result }) =>
            result.status === "failed"
              ? [
                  {
                    key: agentSessionKey(session),
                    label: `${session.title.trim() || "Untitled session"} (${folder.title})`,
                    reason: result.reason,
                  },
                ]
              : [],
          ),
        ];

  const toggleFolder = (candidate: AgentSessionProjectCandidate, checked: boolean) =>
    setSelectedPaths((current) => {
      const next = new Set(current);
      if (checked) next.add(candidate.path);
      else next.delete(candidate.path);
      return next;
    });

  return (
    <>
      <Text className="text-sm text-foreground-muted">
        Claude Code and Codex sessions found on {environmentLabel}. Folders without a project are
        added as projects. Sessions that may still be open in a terminal are left out.
      </Text>
      <SegmentedControl
        options={AGENT_SESSION_AGE_WINDOWS.map((option) => ({
          value: option.key,
          label: option.label,
        }))}
        selected={ageWindow.key}
        onSelect={(key) => {
          if (running) return;
          const next = AGENT_SESSION_AGE_WINDOWS.find((option) => option.key === key);
          if (next === undefined) return;
          setAgeWindow(next);
          setSelectedPaths(new Set());
        }}
      />
      {summary !== null ? (
        <ListSection
          title={running ? (stopping ? "Stopping after current" : "Importing") : "Import results"}
        >
          <View className="gap-2 px-4 py-3">
            <Text className="text-sm text-foreground">
              {summary.imported} imported, {summary.alreadyImported} already imported,{" "}
              {summary.failed} failed.
            </Text>
            {failures.map((failure) => (
              <View key={failure.key}>
                <Text className="text-sm font-t3-medium text-foreground">{failure.label}</Text>
                <Text className="text-xs text-danger-foreground">{failure.reason}</Text>
              </View>
            ))}
          </View>
        </ListSection>
      ) : null}
      <View className="gap-2">
        {running ? (
          <Button
            label="Stop after current"
            tone="secondary"
            disabled={stopping}
            onPress={() => {
              stopRef.current = true;
              setStopping(true);
            }}
          />
        ) : (
          <>
            <Button
              label={`Import ${plan.length} ${plan.length === 1 ? "folder" : "folders"}`}
              disabled={!canImport || plan.length === 0}
              onPress={() => void runImport(plan)}
            />
            {retryPlan.length > 0 ? (
              <Button
                label="Retry failed"
                tone="secondary"
                disabled={!canImport}
                onPress={() => void runImport(retryPlan)}
              />
            ) : null}
          </>
        )}
      </View>
      {scanState === null ? (
        <LoadingState label="Looking for sessions..." />
      ) : scanState.status === "error" ? (
        <EmptyState
          title="Could not scan folders"
          detail={scanState.message}
          actionLabel="Try again"
          onAction={() => setScanAttempt((attempt) => attempt + 1)}
        />
      ) : candidates.length === 0 ? (
        <EmptyState
          title="No sessions"
          detail="No Claude Code or Codex sessions found in this period."
        />
      ) : (
        <>
          {scanState.scan.truncated ? (
            <Text className="text-xs text-foreground-muted">
              Scan limit reached. Some folders or sessions may be missing.
            </Text>
          ) : null}
          {sections.map((section) => (
            <ListSection key={section.key} title={section.title}>
              {section.items.map((candidate) => (
                <ListToggleRow
                  key={candidate.path}
                  label={candidate.title}
                  description={`${candidate.path} · ${candidate.threadCount} ${candidate.threadCount === 1 ? "session" : "sessions"}`}
                  disabled={running}
                  value={selectedPaths.has(candidate.path)}
                  onValueChange={(checked) => toggleFolder(candidate, checked)}
                />
              ))}
            </ListSection>
          ))}
        </>
      )}
    </>
  );
}

function LoadingState(props: { readonly label: string }) {
  return (
    <View className="items-center py-16">
      <AppActivityIndicator colorClassName="accent-icon" />
      <Text className="mt-3 text-sm text-foreground-muted">{props.label}</Text>
    </View>
  );
}
