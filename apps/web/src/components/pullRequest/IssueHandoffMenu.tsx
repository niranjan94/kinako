import type { HandoffIssue } from "@t3tools/client-runtime/issue-handoff";
import type { EnvironmentId } from "@t3tools/contracts";
import { BotIcon, MessageCircleQuestionIcon, type LucideIcon } from "lucide-react";
import { useState, type ReactElement } from "react";

import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
} from "../ui/menu";
import {
  readIssueHandoffProjects,
  useIssueHandoff,
  type IssueHandoffKind,
  type IssueHandoffProject,
} from "./itemHandoff";

const ACTIONS: ReadonlyArray<{
  readonly kind: IssueHandoffKind;
  readonly label: string;
  readonly description: string;
  readonly Icon: LucideIcon;
}> = [
  {
    kind: "ask",
    label: "Ask about this issue",
    description: "A new thread that knows which issue you mean. It asks before changing anything.",
    Icon: MessageCircleQuestionIcon,
  },
  {
    kind: "send",
    label: "Send to agent",
    description: "A new thread with the task in its composer, ready for you to send.",
    Icon: BotIcon,
  },
];

function ActionLabel({ label, description }: { label: string; description: string }) {
  return (
    <span className="flex min-w-0 flex-col">
      <span>{label}</span>
      <span className="text-xs text-muted-foreground">{description}</span>
    </span>
  );
}

/**
 * Ask and Send to agent for one issue. The projects are looked up when the menu opens rather than
 * subscribed to, so a long list of rows costs nothing until one is used.
 */
export function IssueHandoffMenu({
  issue,
  trigger,
}: {
  issue: HandoffIssue & { readonly environmentId: EnvironmentId; readonly host: string };
  trigger: ReactElement;
}) {
  const [projects, setProjects] = useState<ReadonlyArray<IssueHandoffProject>>([]);
  const { start, pending } = useIssueHandoff();
  return (
    <Menu
      onOpenChange={(open) => {
        if (open) setProjects(readIssueHandoffProjects(issue));
      }}
    >
      <MenuTrigger disabled={pending !== null} render={trigger} />
      <MenuPopup align="end" side="bottom">
        {projects.length === 0 ? (
          <MenuItem disabled>
            <ActionLabel
              label="No project for this repository"
              description={`Add a checkout of ${issue.repository} to hand this issue to an agent.`}
            />
          </MenuItem>
        ) : (
          ACTIONS.map((action) => {
            const [only] = projects;
            if (projects.length === 1 && only !== undefined) {
              return (
                <MenuItem key={action.kind} onClick={() => void start(action.kind, issue, only)}>
                  <action.Icon className="mt-1 size-3.5 shrink-0 self-start" />
                  <ActionLabel label={action.label} description={action.description} />
                </MenuItem>
              );
            }
            return (
              <MenuSub key={action.kind}>
                <MenuSubTrigger>
                  <action.Icon className="mt-1 size-3.5 shrink-0 self-start" />
                  <ActionLabel label={action.label} description={action.description} />
                </MenuSubTrigger>
                <MenuSubPopup>
                  {projects.map((project) => (
                    <MenuItem
                      key={project.id}
                      onClick={() => void start(action.kind, issue, project)}
                    >
                      <ActionLabel label={project.title} description={project.workspaceRoot} />
                    </MenuItem>
                  ))}
                </MenuSubPopup>
              </MenuSub>
            );
          })
        )}
      </MenuPopup>
    </Menu>
  );
}
