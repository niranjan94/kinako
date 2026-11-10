import { ScopedThreadRef } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "./lib/storage";
import { addTab, closeTab, moveTab, pruneTabs, type TabOwnerState } from "./openThreadTabs.logic";

interface OpenThreadTabsState {
  tabs: readonly ScopedThreadRef[];
  open: (ref: ScopedThreadRef) => void;
  /** Returns the tab to show next when `ref` was the visible one. */
  close: (ref: ScopedThreadRef) => ScopedThreadRef | null;
  move: (from: number, to: number) => void;
  prune: (ownerState: (ref: ScopedThreadRef) => TabOwnerState) => void;
}

const isThreadRef = Schema.is(ScopedThreadRef);

// The active tab is never stored: it is always the thread on screen.
export const useOpenThreadTabsStore = create<OpenThreadTabsState>()(
  persist(
    (set, get) => ({
      tabs: [],
      open: (ref) => set((state) => ({ tabs: addTab(state.tabs, ref) })),
      close: (ref) => {
        const { tabs, successor } = closeTab(get().tabs, ref);
        set({ tabs });
        return successor;
      },
      move: (from, to) => set((state) => ({ tabs: moveTab(state.tabs, from, to) })),
      prune: (ownerState) => set((state) => ({ tabs: pruneTabs(state.tabs, ownerState) })),
    }),
    {
      name: "t3code:open-thread-tabs:v1",
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      version: 1,
      migrate: (persisted) => {
        const tabs = (persisted as { tabs?: unknown } | null)?.tabs;
        return { tabs: Array.isArray(tabs) ? tabs.filter(isThreadRef) : [] };
      },
      partialize: ({ tabs }) => ({ tabs }),
    },
  ),
);
