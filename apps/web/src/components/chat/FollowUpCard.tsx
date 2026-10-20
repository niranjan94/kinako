import { useAtomValue } from "@effect/atom-react";
import {
  followUpDisplay,
  followUpFailureMessage,
  type FollowUpItem,
} from "@t3tools/client-runtime/follow-up";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  FollowUpStartInput,
  OrchestrationV2ProjectedTurnItem,
  ThreadId,
} from "@t3tools/contracts";
import { CheckIcon, ChevronDownIcon, MinusIcon, SquarePlusIcon } from "lucide-react";
import { useState } from "react";

import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Group, GroupSeparator } from "../ui/group";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { WorkLogRow } from "./WorkLog";

export function FollowUpCard(props: {
  readonly environmentId: EnvironmentId;
  readonly item: FollowUpItem;
  readonly visibility: OrchestrationV2ProjectedTurnItem["visibility"];
  readonly onOpenThread: (threadId: ThreadId) => void;
}) {
  const { item } = props;
  const display = followUpDisplay(item, props.visibility);
  const icon = <SquarePlusIcon className="size-3.5 text-icon-muted" aria-hidden />;
  switch (display.kind) {
    case "suggested":
      return <SuggestedFollowUp environmentId={props.environmentId} item={item} />;
    case "dismissed":
      return <DismissedFollowUp environmentId={props.environmentId} item={item} />;
    case "started": {
      const threadId = display.threadId;
      return (
        <WorkLogRow
          data-v2-item-type={item.type}
          icon={<CheckIcon className="size-3.5 text-icon-muted" aria-hidden />}
          label={<>{item.label} · Started in a new thread</>}
          {...(threadId === null ? {} : { onClick: () => props.onOpenThread(threadId) })}
        />
      );
    }
    case "elsewhere":
      return (
        <WorkLogRow
          data-v2-item-type={item.type}
          icon={icon}
          label={<>{item.label} · Suggested in the original thread</>}
        />
      );
  }
}

function useFollowUpAction(environmentId: EnvironmentId) {
  const canOperate = useAtomValue(serverEnvironment.startFollowUp.permissionAtom(environmentId));
  const start = useAtomCommand(serverEnvironment.startFollowUp, { label: "start follow-up" });
  const setDismissed = useAtomCommand(serverEnvironment.setFollowUpDismissed, {
    label: "update follow-up",
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (action: () => ReturnType<typeof start> | ReturnType<typeof setDismissed>) => {
    setBusy(true);
    setError(null);
    const result = await action().finally(() => setBusy(false));
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      setError(followUpFailureMessage(squashAtomCommandFailure(result)));
    }
  };
  return { start, setDismissed, disabled: busy || !canOperate, error, run };
}

function SuggestedFollowUp(props: {
  readonly environmentId: EnvironmentId;
  readonly item: FollowUpItem;
}) {
  const { item, environmentId } = props;
  const { start, setDismissed, disabled, error, run } = useFollowUpAction(environmentId);
  // Omitting the workspace follows the project's default for new threads.
  const startIn = (workspace?: NonNullable<FollowUpStartInput["workspace"]>) =>
    void run(() =>
      start({
        environmentId,
        input: {
          threadId: item.threadId,
          turnItemId: item.id,
          ...(workspace === undefined ? {} : { workspace }),
        },
      }),
    );

  return (
    <div
      data-v2-item-type={item.type}
      className="flex min-w-0 flex-col gap-2 rounded-xl border border-border/60 bg-card p-3"
    >
      <div className="flex min-w-0 items-start gap-2">
        <SquarePlusIcon className="mt-0.5 size-3.5 shrink-0 text-icon-muted" aria-hidden />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <p className="text-sm font-medium text-foreground">{item.label}</p>
          <p className="line-clamp-3 text-xs text-muted-foreground">{item.prompt}</p>
        </div>
      </div>
      {error !== null ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
      <div className="flex min-w-0 items-center justify-end gap-2">
        <Button
          type="button"
          size="xs"
          variant="ghost-muted"
          disabled={disabled}
          onClick={() =>
            void run(() =>
              setDismissed({
                environmentId,
                input: { threadId: item.threadId, turnItemId: item.id, dismissed: true },
              }),
            )
          }
        >
          Dismiss
        </Button>
        <Group>
          <Button
            type="button"
            size="xs"
            variant="outline"
            disabled={disabled}
            onClick={() => startIn()}
          >
            Start thread
          </Button>
          <GroupSeparator />
          <Menu>
            <MenuTrigger
              disabled={disabled}
              render={
                <Button
                  type="button"
                  size="icon-xs"
                  variant="outline"
                  aria-label="More ways to start"
                />
              }
            >
              <ChevronDownIcon />
            </MenuTrigger>
            <MenuPopup align="end">
              <MenuItem onClick={() => startIn("current")}>Start in this checkout</MenuItem>
              <MenuItem onClick={() => startIn("worktree")}>Start in a new worktree</MenuItem>
            </MenuPopup>
          </Menu>
        </Group>
      </div>
    </div>
  );
}

function DismissedFollowUp(props: {
  readonly environmentId: EnvironmentId;
  readonly item: FollowUpItem;
}) {
  const { item, environmentId } = props;
  const { setDismissed, disabled, error, run } = useFollowUpAction(environmentId);
  return (
    <WorkLogRow
      data-v2-item-type={item.type}
      icon={<MinusIcon className="size-3.5 text-icon-muted" aria-hidden />}
      label={
        <>
          {item.label} · {error ?? "Dismissed"}
        </>
      }
      trailing={
        <Button
          type="button"
          size="xs"
          variant="ghost-muted"
          disabled={disabled}
          onClick={() =>
            void run(() =>
              setDismissed({
                environmentId,
                input: { threadId: item.threadId, turnItemId: item.id, dismissed: false },
              }),
            )
          }
        >
          Restore
        </Button>
      }
    />
  );
}
