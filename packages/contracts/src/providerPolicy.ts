import {
  ChatImageAttachment,
  ChatFileAttachment,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
} from "./chatAttachment.ts";
import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";

export const ProviderApprovalPolicy = Schema.Literals([
  "untrusted",
  "on-failure",
  "on-request",
  "never",
]);
export type ProviderApprovalPolicy = typeof ProviderApprovalPolicy.Type;

export const ProviderSandboxMode = Schema.Literals([
  "read-only",
  "workspace-write",
  "danger-full-access",
]);
export type ProviderSandboxMode = typeof ProviderSandboxMode.Type;

// `host-auto` is this fork's host-managed reviewer. It sorts before `auto` so a clamp to an
// `auto` ceiling keeps landing on the provider's own Auto, as upstream does.
export const RuntimeMode = Schema.Literals([
  "approval-required",
  "auto-accept-edits",
  "host-auto",
  "auto",
  "full-access",
]);
export type RuntimeMode = typeof RuntimeMode.Type;
export const DEFAULT_RUNTIME_MODE: RuntimeMode = "full-access";

/** The modes a provider adapter understands. Host-managed modes resolve to one of these first. */
export const ProviderAdapterRuntimeMode = Schema.Literals([
  "approval-required",
  "auto-accept-edits",
  "auto",
  "full-access",
]);
export type ProviderAdapterRuntimeMode = typeof ProviderAdapterRuntimeMode.Type;

const RUNTIME_MODE_RANK: Record<RuntimeMode, number> = {
  "approval-required": 0,
  "auto-accept-edits": 1,
  auto: 2,
  "host-auto": 2,
  "full-access": 3,
};

/** How much a runtime mode allows, narrowest first. */
export const runtimeModeRank = (mode: RuntimeMode): number => RUNTIME_MODE_RANK[mode];

/** Whether `mode` grants the agent more than `ceiling`; no ceiling allows every mode. */
export const isRuntimeModeAbove = (mode: RuntimeMode, ceiling: RuntimeMode | undefined): boolean =>
  ceiling !== undefined && RUNTIME_MODE_RANK[mode] > RUNTIME_MODE_RANK[ceiling];

// Codex's and Claude's own reviewers settle requests inside the provider instead of handing them
// to the host, so host review runs over Auto-accept edits. ACP Registry agents have no shared
// reviewer and allow edits anywhere under Auto-accept edits, so every request comes to the host.
const HOST_AUTO_BASE_BY_DRIVER: Readonly<Record<string, ProviderAdapterRuntimeMode>> = {
  codex: "auto-accept-edits",
  claudeAgent: "auto-accept-edits",
  acpRegistry: "approval-required",
};

/**
 * What a provider actually runs while a thread is in `host-auto`: its own Auto where it has one,
 * so native rules run first, else the narrowest mode that still sends requests to the host.
 * No supported list means the provider offers every mode.
 */
export function hostAutoBaseRuntimeMode(
  driver: string,
  supportedRuntimeModes: ReadonlyArray<RuntimeMode> | undefined,
): ProviderAdapterRuntimeMode {
  const offers = (mode: ProviderAdapterRuntimeMode) =>
    supportedRuntimeModes === undefined ||
    supportedRuntimeModes.length === 0 ||
    supportedRuntimeModes.includes(mode);
  const preferred = HOST_AUTO_BASE_BY_DRIVER[driver];
  if (preferred !== undefined && offers(preferred)) return preferred;
  if (offers("auto")) return "auto";
  if (offers("auto-accept-edits")) return "auto-accept-edits";
  return "approval-required";
}

export const ProviderInteractionMode = Schema.Literals(["default", "plan"]);
export type ProviderInteractionMode = typeof ProviderInteractionMode.Type;
export const DEFAULT_PROVIDER_INTERACTION_MODE: ProviderInteractionMode = "default";

export const ProviderRequestKind = Schema.Literals([
  "command",
  "file-read",
  "file-change",
  "mcp-elicitation",
  "permission",
]);
export type ProviderRequestKind = typeof ProviderRequestKind.Type;

export const ProviderApprovalDecision = Schema.Literals([
  "accept",
  "acceptForSession",
  "acceptAlways",
  "decline",
  "cancel",
]);
export type ProviderApprovalDecision = typeof ProviderApprovalDecision.Type;

// Why an approval reached the user although the thread runs with full access:
// the user's own ask rule, or a check the provider enforces even when bypassed.
export const ProviderApprovalFullAccessOverride = Schema.Literals(["ask_rule", "provider_check"]);
export type ProviderApprovalFullAccessOverride = typeof ProviderApprovalFullAccessOverride.Type;

export const ProviderApprovalOption = Schema.Struct({
  decision: ProviderApprovalDecision,
  label: TrimmedNonEmptyString,
  warning: Schema.optional(TrimmedNonEmptyString),
});
export type ProviderApprovalOption = typeof ProviderApprovalOption.Type;

/**
 * What an approval to run a repository's push hooks names. Clients show it as the request's
 * details; the item's `prompt` stays the whole question in one sentence.
 */
export const ProviderApprovalPushHooks = Schema.Struct({
  branch: Schema.String,
  /** Hook files, relative to the checkout when they are in it. */
  files: Schema.Array(Schema.String),
  /** Hooks Git's configuration defines. */
  commands: Schema.Array(Schema.Struct({ name: Schema.String, command: Schema.String })),
});
export type ProviderApprovalPushHooks = typeof ProviderApprovalPushHooks.Type;

export const ProviderUserInputAnswers = Schema.Record(Schema.String, Schema.Unknown);
export type ProviderUserInputAnswers = typeof ProviderUserInputAnswers.Type;

export const UserInputAttachments = Schema.Record(
  Schema.String,
  Schema.Array(Schema.Union([ChatImageAttachment, ChatFileAttachment])).pipe(
    Schema.check(Schema.isMaxLength(PROVIDER_SEND_TURN_MAX_ATTACHMENTS)),
  ),
);
export type UserInputAttachments = typeof UserInputAttachments.Type;

export const UserInputAttachmentAnswerPayload = Schema.Struct({
  requestId: TrimmedNonEmptyString,
  questionTextById: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  answers: ProviderUserInputAnswers,
  attachmentsByQuestionId: UserInputAttachments,
});
export type UserInputAttachmentAnswerPayload = typeof UserInputAttachmentAnswerPayload.Type;
