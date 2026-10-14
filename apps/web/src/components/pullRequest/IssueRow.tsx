import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";
import { BotIcon, MessageSquareIcon } from "lucide-react";
import { memo } from "react";

import { cn } from "~/lib/utils";

import { Button } from "../ui/button";
import { IssueHandoffMenu } from "./IssueHandoffMenu";
import type { EnvironmentIssueEntry } from "./issue.logic";
import { openOnHostLabel, showPullRequestLinkContextMenu } from "./pullRequestLinkContextMenu";
import { ISSUE_STATE_PRESENTATION } from "./pullRequestIcons";
import {
  PULL_REQUEST_ROW_CLASS,
  PULL_REQUEST_ROW_NUMBER_CLASS,
  PullRequestRowAuthor,
  PullRequestRowLines,
} from "./PullRequestListRow";
import { PAGE_ROW_CLASS, PullRequestRowLabels } from "./PullRequestRow";
import { PullRequestActorAvatar } from "./pullRequestPresentation";

const MAX_ASSIGNEE_AVATARS = 3;

function IssueRowImpl({
  entry,
  selected,
  environmentLabel,
  onSelect,
}: {
  entry: EnvironmentIssueEntry;
  selected: boolean;
  /** Names the server this row was read from, where the list spans more than one. */
  environmentLabel?: string;
  onSelect: (entry: EnvironmentIssueEntry) => void;
}) {
  const state = ISSUE_STATE_PRESENTATION[entry.state];
  return (
    <div
      className={cn(
        "group/issue-row flex items-center rounded-md [content-visibility:auto] [contain-intrinsic-block-size:56.5px]",
        selected ? "bg-accent" : "hover:bg-accent/60",
      )}
    >
      <button
        type="button"
        aria-current={selected ? "true" : undefined}
        onClick={() => onSelect(entry)}
        className={cn(
          PULL_REQUEST_ROW_CLASS,
          PAGE_ROW_CLASS,
          "min-w-0 flex-1 cursor-pointer transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring",
        )}
      >
        <span className="mt-0.75 flex w-4 shrink-0 self-start justify-center">
          <state.Icon aria-label={state.label} className={cn("size-4", state.toneClassName)} />
        </span>
        <PullRequestRowLines
          number={
            <span
              className={PULL_REQUEST_ROW_NUMBER_CLASS}
              onContextMenu={(event) => {
                event.preventDefault();
                event.stopPropagation();
                void showPullRequestLinkContextMenu({
                  url: entry.url,
                  openLabel: openOnHostLabel(sourceControlClients.get(entry.provider)),
                  position: { x: event.clientX, y: event.clientY },
                });
              }}
            >
              #{entry.number}
            </span>
          }
          title={entry.title}
          status={
            <>
              {entry.assignees.length > 0 ? (
                <span
                  className="flex items-center -space-x-1"
                  aria-label={`Assigned to ${entry.assignees.map((actor) => actor.login).join(", ")}`}
                >
                  {entry.assignees.slice(0, MAX_ASSIGNEE_AVATARS).map((actor) => (
                    <PullRequestActorAvatar
                      key={actor.login}
                      actor={actor}
                      className="size-3.5 ring-1 ring-background"
                    />
                  ))}
                </span>
              ) : null}
              {entry.commentCount > 0 ? (
                <span
                  className="flex items-center gap-0.5 tabular-nums text-muted-foreground"
                  aria-label={`${entry.commentCount} comments`}
                >
                  <MessageSquareIcon aria-hidden className="size-3" />
                  {entry.commentCount}
                </span>
              ) : null}
            </>
          }
          metaClassName="@container/pr-row-meta"
          meta={
            <>
              <PullRequestRowAuthor
                actor={entry.author}
                className="min-w-3.5 max-w-40"
                labelClassName="sr-only @xs/pr-row-meta:not-sr-only @xs/pr-row-meta:truncate"
              />
              <span className="truncate">{entry.repository}</span>
              {environmentLabel ? (
                <span className="min-w-0 max-w-32 truncate">{environmentLabel}</span>
              ) : null}
              {entry.labels.length > 0 ? <PullRequestRowLabels labels={entry.labels} /> : null}
            </>
          }
          updatedAt={entry.updatedAt}
        />
      </button>
      {/* Revealed with the row so a long list stays quiet, and held while its menu is open. */}
      <span className="flex shrink-0 pr-2 opacity-0 transition-opacity group-hover/issue-row:opacity-100 focus-within:opacity-100 has-data-popup-open:opacity-100">
        <IssueHandoffMenu
          issue={entry}
          trigger={
            <Button size="icon-xs" variant="ghost" aria-label={`Hand off issue #${entry.number}`}>
              <BotIcon className="size-3.5" />
            </Button>
          }
        />
      </span>
    </div>
  );
}

/** Memoized for the same reason the pull request row is: the route hands it a stable `onSelect`. */
export const IssueRow = memo(IssueRowImpl);
