import { useAtomValue } from "@effect/atom-react";
import { StackActions, useNavigation } from "@react-navigation/native";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThread } from "@t3tools/client-runtime/state/shell";
import { resolveSubagentMetadata } from "@t3tools/client-runtime/state/subagent-display";
import {
  deriveWorkflowRun,
  findWorkflowCoordinator,
  type RuntimeSubagent,
  type SubagentWorkflowGroup,
} from "@t3tools/client-runtime/state/subagentRuntime";
import {
  NodeId,
  type EnvironmentId,
  type OrchestrationV2Subagent,
  type ServerProvider,
  type ThreadId,
} from "@t3tools/contracts";
import { formatTokens } from "@t3tools/shared/usageFormat";
import * as DateTime from "effect/DateTime";
import { Atom } from "effect/reactivity";
import { useMemo, useState } from "react";
import { Pressable, ScrollView, View, type ColorValue } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import * as Dialog from "../../components/ui/Dialog";
import { useAtomCommand } from "../../state/use-atom-command";
import { orchestrationEnvironment } from "../../state/orchestration";
import { serverEnvironment } from "../../state/server";
import { environmentThreadDetails } from "../../state/threads";
import { SubagentElapsed } from "./thread-subagent-group";
import { SubagentStatusDot } from "./SubagentStatusDot";
import { subagentStatusTone } from "./threadAgentsPresentation";

const NO_PARENT_THREAD_ATOM = Atom.make<EnvironmentThread | null>(null).pipe(
  Atom.withLabel("mobile-workflow-parent-thread:none"),
);

/** The workflow coordinator whose own thread this is, or null for any other thread. */
export function useWorkflowCoordinator(
  environmentId: EnvironmentId,
  parentThreadId: ThreadId | null,
  threadId: ThreadId,
): OrchestrationV2Subagent | null {
  return useAtomValue(
    parentThreadId === null
      ? NO_PARENT_THREAD_ATOM
      : environmentThreadDetails.threadAtom(scopeThreadRef(environmentId, parentThreadId)),
    (thread) => findWorkflowCoordinator(thread?.projection.subagents, threadId),
  );
}

function timing(agent: RuntimeSubagent) {
  return {
    status: agent.status,
    startedAt: agent.startedAt === null ? null : DateTime.makeUnsafe(agent.startedAt),
    completedAt: agent.completedAt === null ? null : DateTime.makeUnsafe(agent.completedAt),
  };
}

function MemberRow(props: {
  readonly environmentId: EnvironmentId;
  readonly member: RuntimeSubagent;
  readonly provider: ServerProvider | undefined;
}) {
  const navigation = useNavigation();
  const { member } = props;
  const threadId = member.childThreadId;
  const modelLabel =
    member.model === null
      ? null
      : resolveSubagentMetadata({ model: member.model, provider: props.provider }).modelLabel;
  const detail = [
    modelLabel,
    member.usage === null ? null : `${formatTokens(member.usage.totalTokens)} tokens`,
  ]
    .filter((part) => part !== null)
    .join(" · ");
  return (
    <Pressable
      accessible
      accessibilityRole={threadId === null ? undefined : "link"}
      accessibilityLabel={`${member.title}, ${member.status}`}
      accessibilityHint={threadId === null ? undefined : "Opens this agent's thread"}
      disabled={threadId === null}
      onPress={() => {
        // Push, not navigate: navigate reuses this Thread route, so back would
        // skip the workflow thread.
        if (threadId !== null)
          navigation.dispatch(
            StackActions.push("Thread", {
              environmentId: String(props.environmentId),
              threadId,
            }),
          );
      }}
      className="min-h-11 flex-row items-center gap-3 rounded-lg px-3 py-2 active:bg-subtle"
    >
      <SubagentStatusDot tone={subagentStatusTone(member.status)} placement="sheet" />
      <View className="min-w-0 flex-1 gap-0.5">
        <Text numberOfLines={1} className="text-sm text-foreground">
          {member.title}
        </Text>
        {detail.length > 0 ? (
          <Text numberOfLines={1} className="text-xs text-foreground-muted">
            {detail}
          </Text>
        ) : null}
      </View>
      <SubagentElapsed agents={[timing(member)]} />
    </Pressable>
  );
}

function PhaseSection(props: {
  readonly environmentId: EnvironmentId;
  readonly phase: SubagentWorkflowGroup["phases"][number];
  readonly provider: ServerProvider | undefined;
  readonly iconColor: ColorValue;
}) {
  const [open, setOpen] = useState(true);
  const { phase } = props;
  return (
    <View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${phase.title} phase, ${phase.settledCount} of ${phase.members.length} done`}
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen((value) => !value)}
        className="min-h-9 flex-row items-center gap-2 rounded-lg px-3 active:bg-subtle"
      >
        <Text
          numberOfLines={1}
          className={
            phase.state === "running"
              ? "min-w-0 flex-1 font-t3-medium text-sm text-foreground"
              : "min-w-0 flex-1 font-t3-medium text-sm text-foreground-muted"
          }
        >
          {phase.title}
        </Text>
        <Text className="text-xs tabular-nums text-foreground-muted">
          {phase.settledCount}/{phase.members.length}
        </Text>
        <SymbolView
          name={open ? "chevron.up" : "chevron.down"}
          size={11}
          tintColor={props.iconColor}
        />
      </Pressable>
      {open
        ? phase.members.map((member) => (
            <MemberRow
              key={member.id}
              environmentId={props.environmentId}
              member={member}
              provider={props.provider}
            />
          ))
        : null}
    </View>
  );
}

/** The run report shown at the top of a Claude workflow's own thread. */
export function WorkflowRunCard(props: {
  readonly environmentId: EnvironmentId;
  readonly coordinator: OrchestrationV2Subagent;
  readonly iconColor: ColorValue;
}) {
  const { coordinator } = props;
  const run = useMemo(() => deriveWorkflowRun(coordinator), [coordinator]);
  const config = useAtomValue(serverEnvironment.configValueAtom(props.environmentId));
  const stopWorkflow = useAtomCommand(orchestrationEnvironment.stopWorkflow);
  const canStop = useAtomValue(
    orchestrationEnvironment.stopWorkflow.permissionAtom(props.environmentId),
  );
  const [stopping, setStopping] = useState(false);
  const [scriptOpen, setScriptOpen] = useState(false);

  if (run === null) return null;
  const { workflow, name, description, phases, script } = run;
  const provider = config?.providers.find(
    (entry) => entry.instanceId === coordinator.providerInstanceId,
  );
  const summary = [
    `${run.memberCount} ${run.memberCount === 1 ? "agent" : "agents"}`,
    workflow.usage === null ? null : `${formatTokens(workflow.usage.totalTokens)} tokens`,
  ]
    .filter((part) => part !== null)
    .join(" · ");

  const stop = async () => {
    setStopping(true);
    const result = await stopWorkflow({
      environmentId: props.environmentId,
      input: { threadId: coordinator.threadId, subagentId: NodeId.make(coordinator.id) },
    });
    setStopping(false);
    if (result._tag === "Failure") {
      Dialog.alert("Could not stop workflow", "Try again.");
    }
  };

  return (
    <View className="mb-4 gap-2 rounded-xl border border-border bg-card/30 p-2">
      <View className="flex-row items-start gap-3 px-2 pt-1">
        <View className="min-w-0 flex-1 gap-0.5">
          <Text numberOfLines={1} className="font-t3-medium text-base text-foreground">
            {name}
          </Text>
          <View className="flex-row items-center gap-2">
            <Text className="text-xs text-foreground-muted">Workflow</Text>
            <SubagentElapsed agents={[timing(workflow)]} />
            <Text className="text-xs tabular-nums text-foreground-muted">{summary}</Text>
          </View>
        </View>
        {canStop && workflow.status === "running" ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Stop workflow ${name}`}
            disabled={stopping}
            onPress={stop}
            className="h-8 w-8 items-center justify-center rounded-lg active:bg-subtle"
          >
            <SymbolView name="stop.fill" size={13} tintColor={props.iconColor} />
          </Pressable>
        ) : null}
      </View>
      {description === null ? null : (
        <Text className="px-2 text-sm text-foreground-muted">{description}</Text>
      )}
      {phases.map((phase) => (
        <PhaseSection
          key={phase.index}
          environmentId={props.environmentId}
          phase={phase}
          provider={provider}
          iconColor={props.iconColor}
        />
      ))}
      {run.unphasedMembers.map((member) => (
        <MemberRow
          key={member.id}
          environmentId={props.environmentId}
          member={member}
          provider={provider}
        />
      ))}
      {phases.length === 0 && run.unphasedMembers.length === 0 ? (
        <Text className="px-3 py-1 text-sm text-foreground-muted">No agents yet</Text>
      ) : null}
      {script.length === 0 ? null : (
        <View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Workflow script"
            accessibilityState={{ expanded: scriptOpen }}
            onPress={() => setScriptOpen((value) => !value)}
            className="min-h-9 flex-row items-center gap-2 rounded-lg px-3 active:bg-subtle"
          >
            <Text className="min-w-0 flex-1 font-t3-medium text-sm text-foreground-muted">
              Script
            </Text>
            <SymbolView
              name={scriptOpen ? "chevron.up" : "chevron.down"}
              size={11}
              tintColor={props.iconColor}
            />
          </Pressable>
          {scriptOpen ? (
            <ScrollView horizontal className="mx-1 rounded-lg bg-subtle p-2">
              <Text selectable className="font-mono text-xs leading-normal text-foreground">
                {script}
              </Text>
            </ScrollView>
          ) : null}
        </View>
      )}
    </View>
  );
}
