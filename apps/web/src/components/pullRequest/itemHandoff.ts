import { useComposerDraftStore, type DraftId } from "../../composerDraftStore";

/**
 * A question should not change anything without the reader agreeing first. ChatView reads a
 * local draft's mode from its session context rather than the composer, so both are set.
 */
export function requireApprovalForDraft(draftId: DraftId): void {
  const store = useComposerDraftStore.getState();
  store.setRuntimeMode(draftId, "approval-required");
  store.setDraftThreadContext(draftId, { runtimeMode: "approval-required" });
}
