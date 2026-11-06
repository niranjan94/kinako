import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useEffect } from "react";

// Counted, since one thread can be on screen in more than one place.
const onScreen = new Map<string, number>();

/** A thread the user can see right now: the routed thread, or one shown beside it. */
export function isThreadOnScreen(ref: ScopedThreadRef): boolean {
  return (onScreen.get(scopedThreadKey(ref)) ?? 0) > 0;
}

export function showThreadOnScreen(ref: ScopedThreadRef): () => void {
  const key = scopedThreadKey(ref);
  onScreen.set(key, (onScreen.get(key) ?? 0) + 1);
  return () => {
    const count = (onScreen.get(key) ?? 1) - 1;
    if (count > 0) onScreen.set(key, count);
    else onScreen.delete(key);
  };
}

export function useThreadOnScreen(ref: ScopedThreadRef | null): void {
  const environmentId = ref?.environmentId;
  const threadId = ref?.threadId;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- registers the thread in a module registry the notification service reads outside React
  useEffect(() => {
    if (!environmentId || !threadId) return;
    return showThreadOnScreen({ environmentId, threadId });
  }, [environmentId, threadId]);
}
