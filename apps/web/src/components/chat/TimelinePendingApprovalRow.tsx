import {
  FULL_ACCESS_OVERRIDE_QUESTION,
  fullAccessOverrideExplanation,
} from "@t3tools/client-runtime/state/thread-requests";
import { msg, T, useMessages, Var } from "gt-react";
import { BotIcon, ShieldIcon } from "lucide-react";
import { APP_BASE_NAME } from "~/branding";
import { memo, use } from "react";
import { type PendingApproval } from "../../session-logic";
import { InlineButton } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { ComposerPendingApprovalActions } from "./ComposerPendingApprovalActions";
import { ToolActivityIconView, type WorkEntryIconName } from "./TimelineToolActivityIcon";
import { TimelineRowCtx } from "./timelineRowContext";
import { WorkLogRow } from "./WorkLog";

const APPROVAL_PRESENTATION = {
  command: {
    icon: "terminal",
    label: msg("Command approval"),
    detailLabel: msg("Command", { $context: "noun, shell command awaiting approval" }),
  },
  "file-change": {
    icon: "square-pen",
    label: msg("File change approval"),
    detailLabel: msg("File change"),
  },
  "file-read": { icon: "eye", label: msg("File read approval"), detailLabel: msg("File to read") },
  permission: {
    icon: "wrench",
    label: msg("App permission approval"),
    detailLabel: msg("Permission request"),
  },
  "mcp-elicitation": {
    icon: "hammer",
    label: msg("App access approval"),
    detailLabel: msg("App access request"),
  },
} satisfies Record<
  PendingApproval["requestKind"],
  { icon: WorkEntryIconName; label: string; detailLabel: string }
>;

export const TimelinePendingApprovalRow = memo(function TimelinePendingApprovalRow({
  approval,
}: {
  approval: PendingApproval;
}) {
  const { respondingRequestIds, canOperateThread, onRespondToApproval } = use(TimelineRowCtx);
  const m = useMessages();
  const presentation = APPROVAL_PRESENTATION[approval.requestKind];
  const canRespond = approval.responseCapability === "live";
  const reviewing = approval.autoReview?.state === "reviewing";
  const escalationReason =
    approval.autoReview?.state === "escalated" ? approval.autoReview.reason : undefined;
  return (
    <WorkLogRow
      role="group"
      aria-label={m(presentation.label)}
      data-v2-item-type="approval_request"
      wrapLabel
      icon={
        <ToolActivityIconView
          icon={undefined}
          fallbackName={presentation.icon}
          className="block size-4 shrink-0 stroke-2 text-icon-muted"
          muted
        />
      }
      label={
        <code
          aria-label={m(presentation.detailLabel)}
          className="block max-h-40 min-w-0 overflow-auto whitespace-pre-wrap font-mono text-xs leading-5 text-foreground select-text! wrap-anywhere [scrollbar-width:thin] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70"
          data-approval-detail="complete"
          tabIndex={0}
        >
          {approval.detail || m(presentation.label)}
        </code>
      }
    >
      <div className="ms-7.5 flex min-w-0 flex-col gap-1 pb-1 text-xs">
        {approval.appName ? (
          <span className="text-muted-foreground wrap-anywhere">{approval.appName}</span>
        ) : null}
        {approval.reason ? (
          <span className="text-muted-foreground select-text wrap-anywhere">{approval.reason}</span>
        ) : null}
        {escalationReason ? (
          <span className="inline-flex min-w-0 items-start gap-1 text-muted-foreground wrap-anywhere">
            <BotIcon aria-hidden className="mt-0.5 size-3 shrink-0" />
            <T>
              <Var>{APP_BASE_NAME}</Var> Auto asked you:{" "}
              <span className="select-text">
                <Var>{escalationReason}</Var>
              </span>
            </T>
          </span>
        ) : null}
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          {canRespond ? (
            <>
              {reviewing ? (
                <span className="inline-flex items-center gap-1 text-muted-foreground">
                  <BotIcon aria-hidden className="size-3 shrink-0" />
                  <T>
                    <Var>{APP_BASE_NAME}</Var> Auto is reviewing
                  </T>
                </span>
              ) : (
                <span className="inline-flex items-center gap-1 text-warning">
                  <ShieldIcon aria-hidden className="size-3 shrink-0" />
                  <T>Waiting for approval</T>
                </span>
              )}
              {onRespondToApproval ? (
                <>
                  <span aria-hidden className="text-muted-foreground">
                    ·
                  </span>
                  <ComposerPendingApprovalActions
                    presentation="inline"
                    requestId={approval.requestId}
                    disabled={!canOperateThread}
                    isResponding={respondingRequestIds.includes(approval.requestId)}
                    canRespond={canRespond}
                    options={approval.options}
                    onRespondToApproval={onRespondToApproval}
                  />
                </>
              ) : null}
            </>
          ) : (
            <span className="text-warning">
              <T>Provider process is gone. Interrupt or restart the run to respond.</T>
            </span>
          )}
          {approval.fullAccessOverride ? (
            <Popover>
              <PopoverTrigger openOnHover render={<InlineButton tone="muted" />}>
                {m(FULL_ACCESS_OVERRIDE_QUESTION)}
              </PopoverTrigger>
              <PopoverPopup
                aria-label={m(FULL_ACCESS_OVERRIDE_QUESTION)}
                tooltipStyle
                side="top"
                className="max-w-[min(22rem,calc(100vw-2rem))] whitespace-normal"
              >
                {fullAccessOverrideExplanation(approval.fullAccessOverride, m)}
              </PopoverPopup>
            </Popover>
          ) : null}
        </div>
      </div>
    </WorkLogRow>
  );
});
