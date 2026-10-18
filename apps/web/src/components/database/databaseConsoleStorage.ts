import type {
  DatabaseWorkspace,
  DatabaseWorkspaceTab,
} from "@t3tools/client-runtime/state/database";
import { DatabaseConnectionId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { createDeferredStorage, createMemoryStorage } from "../../lib/storage";

const STORAGE_KEY = "t3code:database-consoles:v1";
const MAX_THREADS = 50;

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
const StoredWorkspaces = Schema.Record(
  Schema.String,
  Schema.Struct({
    tabs: Schema.Array(StoredTab),
    activeId: Schema.NullOr(Schema.String),
    updatedAt: Schema.Number,
  }),
);
type StoredWorkspaces = typeof StoredWorkspaces.Type;
const isStoredWorkspaces = Schema.is(StoredWorkspaces);

const storage = createDeferredStorage<StoredWorkspaces>(
  typeof localStorage !== "undefined" ? localStorage : createMemoryStorage(),
  (value) => JSON.stringify(value),
);
if (typeof window !== "undefined" && typeof window.addEventListener === "function")
  window.addEventListener("beforeunload", () => storage.flush());

let cache: StoredWorkspaces | null = null;
const read = (): StoredWorkspaces => {
  if (cache) return cache;
  try {
    const raw = storage.getItem(STORAGE_KEY);
    const parsed: unknown = typeof raw === "string" ? JSON.parse(raw) : {};
    cache = isStoredWorkspaces(parsed) ? parsed : {};
  } catch {
    cache = {};
  }
  return cache;
};

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
  const stored = read()[key];
  if (!stored?.tabs.length) return null;
  return {
    activeId: stored.activeId,
    tabs: stored.tabs.map(({ table, ...tab }) => ({
      ...tab,
      loading: false,
      ...(table ? { table: { ...table, offset: 0, after: null } } : {}),
    })),
  };
}

export function persistDatabaseWorkspace(key: string, workspace: DatabaseWorkspace) {
  const tabs = workspace.tabs.map(storedTab);
  const current = read();
  const previous = current[key];
  if (
    previous &&
    previous.activeId === workspace.activeId &&
    JSON.stringify(previous.tabs) === JSON.stringify(tabs)
  )
    return;
  const { [key]: _removed, ...rest } = current;
  const kept = Object.entries(rest)
    .toSorted(([, a], [, b]) => b.updatedAt - a.updatedAt)
    .slice(0, MAX_THREADS - 1);
  cache = Object.fromEntries(
    tabs.length
      ? [[key, { tabs, activeId: workspace.activeId, updatedAt: Date.now() }], ...kept]
      : kept,
  );
  storage.setItem(STORAGE_KEY, cache);
}
