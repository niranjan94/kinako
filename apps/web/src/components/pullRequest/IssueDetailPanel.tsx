import { useAtomValue } from "@effect/atom-react";
import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";
import type {
  EnvironmentId,
  IssueDetail,
  IssueRef,
  PullRequestComment,
  ScopedThreadRef,
} from "@t3tools/contracts";
import { BotIcon, ExternalLinkIcon, SendIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { cn } from "~/lib/utils";
import { readLocalApi } from "~/localApi";
import { pullRequestEnvironment } from "~/state/pullRequests";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import { formatRelativeTimeLabel } from "~/timestampFormat";

import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { RefreshIcon } from "../ui/refresh-icon";
import { Spinner } from "../ui/spinner";
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { IssueHandoffMenu } from "./IssueHandoffMenu";
import { PullRequestCommentBody } from "./PullRequestCommentBody";
import { openOnHostLabel } from "./pullRequestLinkContextMenu";
import { PullRequestMarkdown, PullRequestMarkdownContext } from "./PullRequestMarkdown";
import { ISSUE_STATE_PRESENTATION } from "./pullRequestIcons";
import { PullRequestActorLabel, PullRequestLabelChip } from "./pullRequestPresentation";
import { PullRequestsUnavailableState } from "./PullRequestsUnavailableState";

function IssueComment({
  comment,
  detail,
  environmentId,
}: {
  comment: PullRequestComment;
  detail: IssueDetail;
  environmentId: EnvironmentId;
}) {
  const profileUrl = comment.author
    ? sourceControlClients.get(detail.provider).authorProfileUrl(comment.author.login, detail.url)
    : null;
  return (
    <article className="rounded-lg border border-border/60 bg-background [contain-intrinsic-block-size:160px] [content-visibility:auto]">
      <div className="flex min-w-0 flex-wrap items-center gap-2 rounded-t-lg bg-muted/25 px-3 py-2.5 text-xs">
        <PullRequestActorLabel actor={comment.author} profileUrl={profileUrl} />
        <time dateTime={comment.createdAt} className="text-muted-foreground">
          {formatRelativeTimeLabel(comment.createdAt)}
        </time>
      </div>
      <PullRequestCommentBody
        className="px-3 py-3"
        text={comment.body}
        cwd={detail.workspaceRoot}
        environmentId={environmentId}
      />
    </article>
  );
}

function IssueCommentForm({
  environmentId,
  reference,
}: {
  environmentId: EnvironmentId;
  reference: IssueRef;
}) {
  const [body, setBody] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const postComment = useAtomCommand(pullRequestEnvironment.issueComment, {
    reportFailure: false,
  });
  const submit = async () => {
    const trimmed = body.trim();
    if (trimmed.length === 0 || submitting) return;
    setSubmitting(true);
    const result = await postComment({ environmentId, input: { ...reference, body: trimmed } });
    setSubmitting(false);
    if (result._tag === "Failure") {
      toastManager.add({ type: "error", title: "Could not post the comment" });
      return;
    }
    setBody("");
  };
  return (
    <div className="space-y-2">
      <Textarea
        // Locked while posting: the body is cleared on success, which would otherwise throw
        // away a new draft typed while the request was still in flight.
        disabled={submitting}
        value={body}
        rows={3}
        placeholder="Leave a comment"
        aria-label="Comment on this issue"
        onChange={(event) => setBody(event.target.value)}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing || event.keyCode === 229) return;
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && !event.shiftKey) {
            event.preventDefault();
            event.stopPropagation();
            if (!event.repeat) void submit();
          }
        }}
      />
      <div className="flex justify-end">
        <Button
          size="xs"
          variant="outline"
          disabled={body.trim().length === 0 || submitting}
          onClick={() => void submit()}
        >
          <SendIcon className="size-3.5" />
          {submitting ? "Posting..." : "Comment"}
        </Button>
      </div>
    </div>
  );
}

/** One issue beside the list: what it says, who said what since, and the way to answer. */
export function IssueDetailPanel({
  environmentId,
  reference,
  refreshToken = 0,
  threadRef = null,
}: {
  environmentId: EnvironmentId;
  reference: IssueRef;
  /** Bumped by the page's own refresh, which asks for this panel's read again too. */
  refreshToken?: number;
  /** The thread whose panel holds this issue, so links in it open beside that thread. */
  threadRef?: ScopedThreadRef | null;
}) {
  const query = useEnvironmentQuery(
    pullRequestEnvironment.issueDetail({ environmentId, input: reference }),
  );
  const detail = query.data;
  const canPost = useAtomValue(pullRequestEnvironment.issueComment.permissionAtom(environmentId));
  const invalidate = useAtomCommand(pullRequestEnvironment.invalidate, { reportFailure: false });
  const [invalidating, setInvalidating] = useState(false);
  const refreshDetail = query.refresh;
  const refreshFromHost = async () => {
    setInvalidating(true);
    return await (async () => {
      await invalidate({ environmentId, input: { reference } });
      refreshDetail();
    })().finally(() => {
      setInvalidating(false);
    });
  };
  const appliedRefreshToken = useRef(refreshToken);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- refetches the issue from its host when the parent bumps refreshToken
  useEffect(() => {
    if (appliedRefreshToken.current === refreshToken) return;
    appliedRefreshToken.current = refreshToken;
    void refreshFromHost();
  }, [refreshToken, refreshFromHost]);
  const hostClient = sourceControlClients.get(detail?.provider);
  const repositoryUrl =
    detail === null
      ? null
      : (sourceControlClients.parseIssueUrl(detail.url)?.link.repositoryUrl ?? null);
  const markdownContext = (() => {
    const find = hostClient.referenceAutolinks;
    return {
      autolinks:
        find === undefined || repositoryUrl === null
          ? null
          : (text: string) => find(text, repositoryUrl),
      lineBreaks: hostClient.hardLineBreaks ?? false,
      threadRef,
    };
  })();

  if (detail === null) {
    return (
      <div className="flex h-full min-h-0 w-full flex-col items-center justify-center bg-background">
        {query.error ? (
          <PullRequestsUnavailableState
            title="Could not load the issue"
            error={query.error}
            refreshing={query.isPending}
            onRetry={refreshDetail}
          />
        ) : (
          <Spinner aria-label="Loading issue" />
        )}
      </div>
    );
  }

  const state = ISSUE_STATE_PRESENTATION[detail.state];
  const refreshing = invalidating || query.isPending;
  return (
    <PullRequestMarkdownContext value={markdownContext}>
      <div className="flex h-full min-h-0 w-full flex-col bg-background">
        <div className="flex h-7 min-w-0 shrink-0 items-center gap-1 border-b border-border/60 pr-2 pl-4 text-sm text-muted-foreground sm:text-xs">
          {repositoryUrl ? (
            <button
              type="button"
              onClick={() => void readLocalApi()?.shell.openExternal(repositoryUrl)}
              className="min-w-0 cursor-pointer truncate text-left font-medium text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
            >
              {detail.repository}
            </button>
          ) : (
            <span className="min-w-0 truncate font-medium">{detail.repository}</span>
          )}
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  onClick={() => void readLocalApi()?.shell.openExternal(detail.url)}
                  className={cn(
                    "inline-flex shrink-0 cursor-pointer items-center gap-0.5 font-medium underline-offset-2 hover:underline",
                    state.toneClassName,
                  )}
                  aria-label={`Open issue #${detail.number} on host`}
                >
                  #{detail.number}
                  <ExternalLinkIcon aria-hidden className="size-2.5" />
                </button>
              }
            />
            <TooltipPopup side="top">{openOnHostLabel(hostClient)}</TooltipPopup>
          </Tooltip>
          <span className="min-w-0 flex-1" />
          <IssueHandoffMenu
            issue={{ ...detail, environmentId }}
            trigger={
              <Button size="xs" variant="outline">
                <BotIcon aria-hidden className="size-3.5" />
                Hand off
              </Button>
            }
          />
          <Button
            size="icon-xs"
            variant="ghost-muted"
            aria-label="Refresh issue"
            disabled={refreshing}
            onClick={() => void refreshFromHost()}
          >
            <RefreshIcon size="sm" refreshing={refreshing} />
          </Button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="space-y-4 px-4 py-4">
            <header className="space-y-2">
              <h2 className="text-base font-semibold text-foreground">{detail.title}</h2>
              <div className="flex min-w-0 flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <Badge size="control" variant="outline">
                  <span className={cn("flex items-center gap-1", state.toneClassName)}>
                    <state.Icon className="size-3.5" />
                    {state.label}
                  </span>
                </Badge>
                <PullRequestActorLabel
                  actor={detail.author}
                  profileUrl={
                    detail.author
                      ? hostClient.authorProfileUrl(detail.author.login, detail.url)
                      : null
                  }
                />
                <span>opened {formatRelativeTimeLabel(detail.createdAt)}</span>
              </div>
              {detail.labels.length > 0 ? (
                <div className="flex flex-wrap gap-1">
                  {detail.labels.map((label) => (
                    <PullRequestLabelChip key={label.name} label={label} size="default" />
                  ))}
                </div>
              ) : null}
              {detail.assignees.length > 0 ? (
                <div className="flex min-w-0 flex-wrap items-center gap-2 text-xs text-muted-foreground">
                  <span>Assigned to</span>
                  {detail.assignees.map((actor) => (
                    <PullRequestActorLabel key={actor.login} actor={actor} />
                  ))}
                </div>
              ) : null}
            </header>
            {detail.body.trim().length > 0 ? (
              <PullRequestMarkdown
                text={detail.body}
                cwd={detail.workspaceRoot}
                environmentId={environmentId}
              />
            ) : (
              <p className="text-xs text-muted-foreground">No description provided.</p>
            )}
            <section className="space-y-3">
              <h3 className="text-xs font-medium text-muted-foreground">
                {detail.commentCount === 1 ? "1 comment" : `${detail.commentCount} comments`}
              </h3>
              {detail.commentsTruncated ? (
                <p className="rounded-md border border-warning/30 bg-warning-surface px-2 py-1.5 text-xs">
                  This conversation is longer than this page reads in one go. The first{" "}
                  {detail.comments.length} are here; open it on the host to read the rest.
                </p>
              ) : null}
              {detail.comments.map((comment) => (
                <IssueComment
                  key={`${detail.url}:${comment.id}`}
                  comment={comment}
                  detail={detail}
                  environmentId={environmentId}
                />
              ))}
              {detail.canComment && canPost ? (
                <IssueCommentForm environmentId={environmentId} reference={reference} />
              ) : null}
            </section>
          </div>
        </div>
      </div>
    </PullRequestMarkdownContext>
  );
}
