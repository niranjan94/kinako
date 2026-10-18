import type {
  DatabaseWorkspace,
  DatabaseWorkspaceTab,
} from "@t3tools/client-runtime/state/database";
import { DatabaseConnectionId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { createMemoryStorage, type StateStorage } from "../../lib/storage";

const STORAGE_PREFIX = "t3code:database-consoles:v1";
const INDEX_KEY = `${STORAGE_PREFIX}:index`;
const MAX_THREADS = 50;
const WRITE_DELAY_MS = 300;

const StoredTab = Schema.Struct({
  id: Schema.String,
  connectionId: DatabaseConnectionId,
  title: Schema.String,
  sql: Schema.String,
  filePath: Schema.optionalKey(Schema.String),
  savedSql: Schema.optionalKey(Schema.String),
  table: Schema.optionalKey(
    Schema.Struct({
      schema: Schema.String,
      object: Schema.String,
      where: Schema.String,
      orderBy: Schema.String,
    }),
  ),
});
const StoredWorkspace = Schema.Struct({
  tabs: Schema.Array(StoredTab),
  activeId: Schema.NullOr(Schema.String),
});
const StoredIndex = Schema.Record(Schema.String, Schema.Number);
const isStoredWorkspace = Schema.is(StoredWorkspace);
const isStoredIndex = Schema.is(StoredIndex);

const storage: StateStorage =
  typeof localStorage !== "undefined" ? localStorage : createMemoryStorage();
const itemKey = (key: string) => `${STORAGE_PREFIX}:${key}`;

const readJson = <A>(name: string, is: (value: unknown) => value is A): A | null => {
  try {
    const raw = storage.getItem(name);
    const parsed: unknown = typeof raw === "string" ? JSON.parse(raw) : null;
    return is(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

// Each thread is its own item, and the index is re-read before every write, so windows
// editing different threads never overwrite each other.
const write = (key: string, value: string | null) => {
  const index = readJson(INDEX_KEY, isStoredIndex) ?? {};
  const { [key]: _previous, ...others } = index;
  const evictable = Object.entries(others).toSorted(([, a], [, b]) => a - b);
  for (const [stale] of evictable.splice(0, Math.max(0, evictable.length - (MAX_THREADS - 1))))
    storage.removeItem(itemKey(stale));
  const kept: Record<string, number> = Object.fromEntries(evictable);
  if (value === null) {
    storage.removeItem(itemKey(key));
    storage.setItem(INDEX_KEY, JSON.stringify(kept));
    return;
  }
  for (;;) {
    try {
      storage.setItem(itemKey(key), value);
      storage.setItem(INDEX_KEY, JSON.stringify({ ...kept, [key]: Date.now() }));
      return;
    } catch (error) {
      // Over quota: drop the least recently used thread and try again.
      const oldest = Object.entries(kept).toSorted(([, a], [, b]) => a - b)[0];
      if (!oldest) {
        console.warn("Could not save database consoles", error);
        return;
      }
      storage.removeItem(itemKey(oldest[0]));
      delete kept[oldest[0]];
    }
  }
};

const pending = new Map<string, { value: string | null; timer: ReturnType<typeof setTimeout> }>();
const written = new Map<string, string | null>();
const flush = (key: string) => {
  const entry = pending.get(key);
  if (!entry) return;
  clearTimeout(entry.timer);
  pending.delete(key);
  write(key, entry.value);
  written.set(key, entry.value);
};
if (typeof window !== "undefined" && typeof window.addEventListener === "function")
  window.addEventListener("beforeunload", () => {
    for (const key of pending.keys()) flush(key);
  });

const storedTab = (tab: DatabaseWorkspaceTab): typeof StoredTab.Type => ({
  id: tab.id,
  connectionId: tab.connectionId,
  title: tab.title,
  sql: tab.sql,
  ...(tab.filePath !== undefined ? { filePath: tab.filePath } : {}),
  ...(tab.savedSql !== undefined ? { savedSql: tab.savedSql } : {}),
  ...(tab.table
    ? {
        table: {
          schema: tab.table.schema,
          object: tab.table.object,
          where: tab.table.where,
          orderBy: tab.table.orderBy,
        },
      }
    : {}),
});

/** Restores console SQL and table tabs; sessions and results never outlive the page. */
export function restoreDatabaseWorkspace(key: string): DatabaseWorkspace | null {
  const stored = readJson(itemKey(key), isStoredWorkspace);
  if (!stored?.tabs.length) return null;
  return {
    activeId: stored.tabs.some((tab) => tab.id === stored.activeId)
      ? stored.activeId
      : (stored.tabs[0]?.id ?? null),
    tabs: stored.tabs.map(({ table, ...tab }) => ({
      ...tab,
      loading: false,
      ...(table ? { table: { ...table, offset: 0, after: null } } : {}),
    })),
  };
}

export function persistDatabaseWorkspace(key: string, workspace: DatabaseWorkspace) {
  const value = workspace.tabs.length
    ? JSON.stringify({ tabs: workspace.tabs.map(storedTab), activeId: workspace.activeId })
    : null;
  const previous = pending.has(key) ? pending.get(key)!.value : written.get(key);
  if (previous === value) return;
  const entry = pending.get(key);
  if (entry) clearTimeout(entry.timer);
  pending.set(key, { value, timer: setTimeout(() => flush(key), WRITE_DELAY_MS) });
}

/** Writes any pending workspace immediately. */
export function flushDatabaseWorkspaces() {
  for (const key of pending.keys()) flush(key);
}
