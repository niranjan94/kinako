import type { ThreadContextRecord } from "@t3tools/contracts";
import {
  collectComposerContextReferences,
  formatComposerContextReference,
} from "@t3tools/shared/composerContextReferences";

export type SideQuestionSubmissionTarget =
  | "provider-turn"
  | "pending-user-input"
  | "queued-message";

/** The question after `/btw`, `""` for a bare `/btw`, or null when the draft is not a side question. */
export function parseBtwComposerQuestion(
  text: string,
  submissionTarget: SideQuestionSubmissionTarget = "provider-turn",
): string | null {
  if (submissionTarget !== "provider-turn") return null;
  const match = /^\/btw(?:\s+([\s\S]*))?$/i.exec(text.trim());
  return match === null ? null : (match[1]?.trim() ?? "");
}

/** Appends a reference to the parent thread so the side chat's message carries it as context. */
export function withParentThreadReference(question: string, parent: ThreadContextRecord): string {
  const referenced = collectComposerContextReferences(question).some(
    (reference) => reference.contextId === parent.contextId,
  );
  return referenced ? question : `${question} ${formatComposerContextReference(parent)}`;
}
