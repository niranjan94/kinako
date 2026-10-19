import type { ThreadContextRecord } from "@t3tools/contracts";
import {
  collectComposerContextReferences,
  formatComposerContextReference,
} from "@t3tools/shared/composerContextReferences";

/** Appends a reference to the parent thread so the side chat's message carries it as context. */
export function withParentThreadReference(question: string, parent: ThreadContextRecord): string {
  const referenced = collectComposerContextReferences(question).some(
    (reference) => reference.contextId === parent.contextId,
  );
  return referenced ? question : `${question} ${formatComposerContextReference(parent)}`;
}
