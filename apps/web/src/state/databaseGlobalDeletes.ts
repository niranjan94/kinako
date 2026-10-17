import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { resolveStorage } from "../lib/storage";

/** Local cleanup reminders only; reconnecting never applies a deletion automatically. */
export const useDatabaseGlobalDeletes = create(
  persist<{
    pending: Record<string, string[]>;
    remember: (id: string, environmentIds: string[]) => void;
    clear: (id: string) => void;
  }>(
    (set) => ({
      pending: {},
      remember: (id, environmentIds) =>
        set((state) => ({ pending: { ...state.pending, [id]: environmentIds } })),
      clear: (id) =>
        set((state) => {
          const pending = { ...state.pending };
          delete pending[id];
          return { pending };
        }),
    }),
    {
      name: "t3code:database-delete-reminders:v1",
      storage: createJSONStorage(() => resolveStorage(globalThis.localStorage)),
    },
  ),
);
