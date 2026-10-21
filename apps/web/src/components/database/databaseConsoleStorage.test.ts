import { describe, expect, it } from "@effect/vitest";
import { DatabaseConnectionId, DatabaseQueryId, DatabaseSessionId } from "@t3tools/contracts";
import {
  flushDatabaseWorkspaces,
  persistDatabaseWorkspace,
  restoreDatabaseWorkspace,
} from "./databaseConsoleStorage";

const connectionId = DatabaseConnectionId.make("connection");

describe("database console storage", () => {
  it("restores SQL and table filters without sessions or results", () => {
    persistDatabaseWorkspace("thread-a", {
      activeId: "table",
      tabs: [
        {
          id: "console",
          connectionId,
          database: "analytics",
          title: "Console 1",
          sql: "SELECT 1",
          filePath: "query.sql",
          sessionId: DatabaseSessionId.make("session"),
          queryId: DatabaseQueryId.make("query"),
          loading: true,
          error: "failed",
        },
        {
          id: "table",
          connectionId,
          database: "app",
          title: "public.users",
          sql: "",
          loading: false,
          table: {
            schema: "public",
            object: "users",
            where: "id > 1",
            orderBy: "",
            offset: 200,
            after: [5],
          },
        },
      ],
    });
    flushDatabaseWorkspaces();
    expect(restoreDatabaseWorkspace("thread-a")).toEqual({
      activeId: "table",
      tabs: [
        {
          id: "console",
          connectionId,
          database: "analytics",
          title: "Console 1",
          sql: "SELECT 1",
          filePath: "query.sql",
          loading: false,
        },
        {
          id: "table",
          connectionId,
          database: "app",
          title: "public.users",
          sql: "",
          loading: false,
          table: {
            schema: "public",
            object: "users",
            where: "id > 1",
            orderBy: "",
            offset: 0,
            after: null,
          },
        },
      ],
    });
  });

  it("restores the terminal view when no tab was shown", () => {
    persistDatabaseWorkspace("thread-c", {
      activeId: null,
      tabs: [{ id: "console", connectionId, title: "Console 1", sql: "", loading: false }],
    });
    flushDatabaseWorkspaces();
    expect(restoreDatabaseWorkspace("thread-c")?.activeId).toBeNull();
  });

  it("forgets a thread once its last tab closes", () => {
    persistDatabaseWorkspace("thread-b", {
      activeId: "console",
      tabs: [{ id: "console", connectionId, title: "Console 1", sql: "SELECT 2", loading: false }],
    });
    flushDatabaseWorkspaces();
    persistDatabaseWorkspace("thread-b", { activeId: null, tabs: [] });
    flushDatabaseWorkspaces();
    expect(restoreDatabaseWorkspace("thread-b")).toBeNull();
  });
});
