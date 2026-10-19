import { create } from "zustand";

/** The table tab each thread's bottom drawer shows instead of its terminals. */
export const useDatabaseDrawerTable = create<{ byThread: Record<string, string> }>(() => ({
  byThread: {},
}));

export const showDatabaseDrawerTable = (threadKey: string, tabId: string | null) =>
  useDatabaseDrawerTable.setState((state) => {
    const { [threadKey]: _previous, ...byThread } = state.byThread;
    return { byThread: tabId === null ? byThread : { ...byThread, [threadKey]: tabId } };
  });
