// @effect-diagnostics nodeBuiltinImport:off -- This engine adapter needs Node IPC, which Effect ChildProcess does not expose.
import * as NodeChildProcess from "node:child_process";
import { selfInvocationArgs, type SelfInvocation } from "@t3tools/shared/nodeRuntime";
import {
  DATABASE_CELL_TEXT_MAX,
  type DatabaseIntrospectResult,
  type DatabaseResultColumn,
  type DatabaseSqliteTarget,
} from "@t3tools/contracts";
import { DatabaseEngineError, type DatabasePage, type DatabaseSession } from "./databaseDriver.ts";

interface WorkerReply {
  id: number;
  ok: boolean;
  value?: unknown;
  message?: string;
  code?: string | null;
}

type ExecuteReply =
  | { kind: "command"; command: string; affectedRows: number | null }
  | { kind: "rows"; columns: ReadonlyArray<DatabaseResultColumn>; firstPage: DatabasePage };

export async function openSqliteSession(
  target: DatabaseSqliteTarget,
  readOnly: boolean,
  invocation: SelfInvocation,
): Promise<DatabaseSession> {
  const worker = NodeChildProcess.spawn(
    invocation.command,
    [...selfInvocationArgs(invocation, ["database-session-process"])],
    {
      stdio: ["ignore", "ignore", "ignore", "ipc"],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      windowsHide: true,
    },
  );
  const exited = new Promise<void>((resolve) => worker.once("close", () => resolve()));
  const terminate = async () => {
    if (worker.pid === undefined || worker.exitCode !== null || worker.signalCode !== null) return;
    worker.kill("SIGKILL");
    await exited;
  };
  let nextId = 0;
  let stopped = false;
  const pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: DatabaseEngineError) => void }
  >();
  const error = (message: string, cancelled = false, code: string | null = null) =>
    new DatabaseEngineError({
      engineMessage: message,
      code,
      position: null,
      cancelled,
    });
  const failPending = (cause: DatabaseEngineError) => {
    stopped = true;
    for (const request of pending.values()) request.reject(cause);
    pending.clear();
  };
  worker.on("message", (reply: WorkerReply) => {
    const request = pending.get(reply.id);
    if (!request) return;
    pending.delete(reply.id);
    if (reply.ok) request.resolve(reply.value);
    else request.reject(error(reply.message ?? "SQLite request failed.", false, reply.code));
  });
  worker.on("error", (cause) => failPending(error(cause.message)));
  worker.on("exit", () => failPending(error("The SQLite session has closed.")));
  const request = <A>(method: string, ...args: unknown[]): Promise<A> => {
    if (stopped)
      return Promise.reject(error("The SQLite session has closed. Open a new query tab."));
    return new Promise((resolve, reject) => {
      const id = ++nextId;
      pending.set(id, { resolve: (value) => resolve(value as A), reject });
      worker.send({ id, method, args }, (cause) => {
        if (cause) failPending(error(cause.message));
      });
    });
  };
  try {
    await request("open", { path: target.path, readOnly, textLimit: DATABASE_CELL_TEXT_MAX });
  } catch (cause) {
    await terminate();
    throw cause;
  }
  return {
    cancelClosesSession: true,
    serverVersion: () => request<string>("version"),
    introspect: (scope) => request<DatabaseIntrospectResult>("introspect", scope),
    execute: async (sql, pageSize) => {
      const result = await request<ExecuteReply>("execute", sql, pageSize);
      if (result.kind === "command") return result;
      return {
        kind: "rows",
        firstPage: result.firstPage,
        cursor: {
          columns: result.columns,
          read: (count) => request<DatabasePage>("read", count),
          close: () => (stopped ? Promise.resolve() : request<void>("closeCursor")),
        },
      };
    },
    cancel: async () => {
      failPending(
        error("Query cancelled. The SQLite session has closed; open a new query tab.", true),
      );
      await terminate();
    },
    close: async () => {
      // Termination also interrupts a busy statement, unlike a queued close message.
      failPending(error("The SQLite session has closed.", true));
      await terminate();
    },
  };
}
