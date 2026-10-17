import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { create } from "zustand";

export const useDatabasePanelIntent = create<{
  byThread: Record<string, "explorer" | "query" | "table">;
}>(() => ({ byThread: {} }));
export const databasePanelIntent = {
  set: (ref: ScopedThreadRef, intent: "explorer" | "query" | "table") =>
    useDatabasePanelIntent.setState((state) => ({
      byThread: { ...state.byThread, [scopedThreadKey(ref)]: intent },
    })),
  consume: (ref: ScopedThreadRef) =>
    useDatabasePanelIntent.setState((state) => {
      const byThread = { ...state.byThread };
      delete byThread[scopedThreadKey(ref)];
      return { byThread };
    }),
};
