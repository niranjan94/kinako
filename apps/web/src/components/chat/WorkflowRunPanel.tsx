import { useAtomValue } from "@effect/atom-react";
import { resolveSubagentMetadata } from "@t3tools/client-runtime/state/subagent-display";
import {
  deriveWorkflowRun,
  findWorkflowCoordinator,
  type RuntimeSubagent,
  type SubagentWorkflowGroup,
} from "@t3tools/client-runtime/state/subagentRuntime";
import { NodeId, type ScopedThreadRef, type ServerProvider, ThreadId } from "@t3tools/contracts";
import { formatTokens } from "@t3tools/shared/usageFormat";
import { LoaderCircleIcon, SquareIcon } from "lucide-react";
import { useMemo, useState } from "react";

import ChatMarkdown from "../ChatMarkdown";
import { orchestrationEnvironment } from "../../state/orchestration";
import { environmentThreadDetails } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { CollapsibleSectionHeader } from "../ui/collapsible-section-header";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { AgentElapsed } from "./AgentElapsed";
import { ThreadRelationshipIcon } from "./ThreadRelationshipIcon";

type Phase = SubagentWorkflowGroup["phases"][number];

/** A fence longer than any backtick run in the script, so the script cannot close it. */
function fencedScript(script: string): string {
  const longestRun = Math.max(0, ...(script.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(Math.max(3, longestRun + 1));
  return `${fence}js\n${script}\n${fence}`;
}

function MemberTable({
  members,
  provider,
  onOpenThread,
}: {
  members: ReadonlyArray<RuntimeSubagent>;
  provider: ServerProvider | undefined;
  onOpenThread: (threadId: ThreadId) => void;
}) {
  return (
    <table className="w-full table-fixed border-collapse text-xs">
      <thead className="text-2xs text-muted-foreground/70">
        <tr>
          <th className="ps-8 text-left font-normal">Agent</th>
          <th className="w-28 text-left font-normal">Model</th>
          <th className="w-16 text-right font-normal">Tokens</th>
          <th className="w-16 pe-2.5 text-right font-normal">Time</th>
        </tr>
      </thead>
      <tbody>
        {members.map((member) => {
          const threadId =
            member.childThreadId === null ? null : ThreadId.make(member.childThreadId);
          return (
            <tr key={member.id} className="h-7">
              <td className="ps-2">
                <button
                  type="button"
                  disabled={threadId === null}
                  aria-label={`Open ${member.title} chat`}
                  onClick={() => threadId !== null && onOpenThread(threadId)}
                  className="flex w-full min-w-0 items-center gap-2 rounded-sm text-left text-foreground/85 enabled:cursor-pointer enabled:hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70"
                >
                  <ThreadRelationshipIcon
                    driver={provider?.driver}
                    provider={provider}
                    status={member.status}
                  />
                  <span className="min-w-0 flex-1 truncate">{member.title}</span>
                  <span className="sr-only">{member.status}</span>
                </button>
              </td>
              <td className="truncate text-muted-foreground">
                {member.model === null
                  ? ""
                  : resolveSubagentMetadata({ model: member.model, provider }).modelLabel}
              </td>
              <td className="text-right tabular-nums text-muted-foreground">
                {member.usage === null ? "" : formatTokens(member.usage.totalTokens)}
              </td>
              <td className="pe-2.5 text-right tabular-nums text-muted-foreground">
                {member.startedAt ? <AgentElapsed agent={member} /> : null}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function PhaseSection({
  phase,
  provider,
  onOpenThread,
}: {
  phase: Phase;
  provider: ServerProvider | undefined;
  onOpenThread: (threadId: ThreadId) => void;
}) {
  // Every phase starts open: the panel is the run's whole report, not a summary.
  const [open, setOpen] = useState(true);
  return (
    <li>
      <CollapsibleSectionHeader
        variant="panel"
        tone={phase.state === "running" ? "emphasized" : "muted"}
        expanded={open}
        aria-label={`${open ? "Collapse" : "Expand"} ${phase.title} phase`}
        onClick={() => setOpen((value) => !value)}
        accessory={
          <span className="shrink-0 text-2xs font-normal tabular-nums">
            {phase.settledCount}/{phase.members.length}
          </span>
        }
      >
        {phase.title}
      </CollapsibleSectionHeader>
      {open ? (
        <MemberTable members={phase.members} provider={provider} onOpenThread={onOpenThread} />
      ) : null}
    </li>
  );
}

/**
 * The run report for a Claude workflow's own thread: its phases, every member
 * with model, tokens and time, and the script it ran. Renders nothing when the
 * thread is not a workflow coordinator.
 */
export function WorkflowRunPanel({
  parentRef,
  threadId,
  providerStatuses,
  markdownCwd,
  onOpenThread,
}: {
  parentRef: ScopedThreadRef;
  threadId: ThreadId;
  providerStatuses: ReadonlyArray<ServerProvider>;
  markdownCwd: string | undefined;
  onOpenThread: (threadId: ThreadId) => void;
}) {
  const coordinator = useAtomValue(environmentThreadDetails.threadAtom(parentRef), (thread) =>
    findWorkflowCoordinator(thread?.projection.subagents, threadId),
  );
  const group = useMemo(
    () => (coordinator === null ? null : deriveWorkflowRun(coordinator)),
    [coordinator],
  );
  const stopWorkflow = useAtomCommand(orchestrationEnvironment.stopWorkflow);
  const canStop = useAtomValue(
    orchestrationEnvironment.stopWorkflow.permissionAtom(parentRef.environmentId),
  );
  const [stopping, setStopping] = useState(false);
  const [scriptOpen, setScriptOpen] = useState(false);

  if (coordinator === null || group === null) return null;
  const { workflow, name, description, phases, script } = group;
  const provider = providerStatuses.find(
    (entry) => entry.instanceId === coordinator.providerInstanceId,
  );

  const stop = async () => {
    setStopping(true);
    const result = await stopWorkflow({
      environmentId: parentRef.environmentId,
      input: { threadId: coordinator.threadId, subagentId: NodeId.make(coordinator.id) },
    });
    setStopping(false);
    if (result._tag === "Failure") {
      toastManager.add({ type: "error", title: "Could not stop workflow" });
    }
  };

  return (
    <section
      aria-label={`Workflow ${name}`}
      className="flex flex-col gap-2 rounded-lg border border-border/60 bg-card/40 p-3"
    >
      <header className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-sm font-medium text-foreground">{name}</h2>
          <p className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
            <span>Workflow</span>
            <span className="tabular-nums empty:hidden">
              <AgentElapsed agent={workflow} />
            </span>
            <span className="tabular-nums">
              {group.memberCount} {group.memberCount === 1 ? "agent" : "agents"}
            </span>
            {workflow.usage === null ? null : (
              <span className="tabular-nums">
                {formatTokens(workflow.usage.totalTokens)} tokens
              </span>
            )}
          </p>
        </div>
        {canStop && workflow.status === "running" ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="icon-xs"
                  variant="ghost-destructive"
                  aria-label={`Stop workflow ${name}`}
                  disabled={stopping}
                  onClick={stop}
                />
              }
            >
              {stopping ? (
                <LoaderCircleIcon aria-hidden className="size-3 animate-spin" />
              ) : (
                <SquareIcon aria-hidden className="size-3 fill-current" />
              )}
            </TooltipTrigger>
            <TooltipPopup side="left">Stop entire workflow</TooltipPopup>
          </Tooltip>
        ) : null}
      </header>
      {description === null ? null : <p className="text-xs text-muted-foreground">{description}</p>}
      <ul className="m-0 flex list-none flex-col gap-1 p-0">
        {phases.map((phase) => (
          <PhaseSection
            key={phase.index}
            phase={phase}
            provider={provider}
            onOpenThread={onOpenThread}
          />
        ))}
        {group.unphasedMembers.length > 0 ? (
          <li>
            <MemberTable
              members={group.unphasedMembers}
              provider={provider}
              onOpenThread={onOpenThread}
            />
          </li>
        ) : null}
        {phases.length === 0 && group.unphasedMembers.length === 0 ? (
          <li className="px-2 py-1.5 text-xs text-muted-foreground/70">No agents yet</li>
        ) : null}
        {script.length === 0 ? null : (
          <li>
            <CollapsibleSectionHeader
              variant="panel"
              expanded={scriptOpen}
              aria-label={`${scriptOpen ? "Collapse" : "Expand"} workflow script`}
              onClick={() => setScriptOpen((value) => !value)}
            >
              Script
            </CollapsibleSectionHeader>
            {scriptOpen ? (
              <ChatMarkdown
                text={fencedScript(script)}
                cwd={markdownCwd}
                environmentId={parentRef.environmentId}
                isStreaming={false}
              />
            ) : null}
          </li>
        )}
      </ul>
    </section>
  );
}
