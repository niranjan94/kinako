import { ScopedThreadRef } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "./lib/storage";
import { randomUUID } from "./lib/utils";
import {
  clampRatio,
  findLeafByThread,
  focusAfterRemove,
  leaves,
  MAX_SPLIT_DEPTH,
  type PaneNode,
  removePane,
  replacePaneThread,
  resizeSplit,
  type SplitDirection,
  splitPane,
} from "./splitView.logic";

interface SplitViewState {
  /** Null when the chat shows a single thread. */
  root: PaneNode | null;
  focusedPaneId: string | null;
  /** Splits the focused pane, or starts a split from `current`, and focuses the new pane. */
  split: (current: ScopedThreadRef, direction: SplitDirection, threadRef: ScopedThreadRef) => void;
  /** Closes a pane; a single remaining pane ends the split. Returns the thread to show. */
  close: (paneId: string) => ScopedThreadRef | null;
  focus: (paneId: string) => void;
  resize: (splitId: string, ratio: number) => void;
  /** Follows navigation: focus the pane showing `ref`, else put `ref` in the focused pane. */
  followRoute: (ref: ScopedThreadRef) => void;
}

const isThreadRef = Schema.is(ScopedThreadRef);

function isPaneNode(node: unknown, depth = 0): node is PaneNode {
  const pane = node as PaneNode | null;
  if (!pane || typeof pane.id !== "string") return false;
  if (pane.kind === "leaf") return isThreadRef(pane.threadRef);
  return (
    pane.kind === "split" &&
    depth < MAX_SPLIT_DEPTH &&
    (pane.direction === "row" || pane.direction === "column") &&
    typeof pane.ratio === "number" &&
    isPaneNode(pane.first, depth + 1) &&
    isPaneNode(pane.second, depth + 1)
  );
}

const single = (root: PaneNode | null) => root === null || root.kind === "leaf";

export const useSplitViewStore = create<SplitViewState>()(
  persist(
    (set, get) => ({
      root: null,
      focusedPaneId: null,
      split: (current, direction, threadRef) => {
        const state = get();
        const root: PaneNode = state.root ?? { kind: "leaf", id: randomUUID(), threadRef: current };
        const paneId =
          state.focusedPaneId ?? findLeafByThread(root, current)?.id ?? leaves(root)[0]!.id;
        const ids = { split: randomUUID(), leaf: randomUUID() };
        const next = splitPane(root, paneId, direction, threadRef, ids);
        if (next === root) return;
        set({ root: next, focusedPaneId: ids.leaf });
      },
      close: (paneId) => {
        const { root, focusedPaneId } = get();
        if (!root) return null;
        const next = removePane(root, paneId);
        const focused = focusAfterRemove(root, paneId, focusedPaneId);
        if (single(next)) {
          set({ root: null, focusedPaneId: null });
          return next?.kind === "leaf" ? next.threadRef : null;
        }
        set({ root: next, focusedPaneId: focused });
        const leaf = leaves(next!).find((pane) => pane.id === focused);
        return leaf?.threadRef ?? null;
      },
      focus: (paneId) => {
        const { root } = get();
        if (root && leaves(root).some((leaf) => leaf.id === paneId)) set({ focusedPaneId: paneId });
      },
      resize: (splitId, ratio) => {
        const { root } = get();
        if (root) set({ root: resizeSplit(root, splitId, clampRatio(ratio)) });
      },
      followRoute: (ref) => {
        const { root, focusedPaneId } = get();
        if (!root) return;
        const shown = findLeafByThread(root, ref);
        if (shown) {
          if (shown.id !== focusedPaneId) set({ focusedPaneId: shown.id });
          return;
        }
        if (focusedPaneId) set({ root: replacePaneThread(root, focusedPaneId, ref) });
      },
    }),
    {
      name: "t3code:split-view:v1",
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      version: 1,
      migrate: (persisted) => {
        const state = persisted as Partial<Pick<SplitViewState, "root" | "focusedPaneId">> | null;
        const root = isPaneNode(state?.root) && !single(state.root) ? state.root : null;
        const focusedPaneId =
          root && leaves(root).some((leaf) => leaf.id === state?.focusedPaneId)
            ? state!.focusedPaneId!
            : root
              ? leaves(root)[0]!.id
              : null;
        return { root, focusedPaneId };
      },
      partialize: ({ root, focusedPaneId }) => ({ root, focusedPaneId }),
    },
  ),
);
