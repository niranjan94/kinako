import {
  DatabaseConnectionId,
  DatabaseExecuteInput,
  DatabaseExecuteResult,
  DatabaseIntrospectScope,
  DatabaseIntrospectResult,
  DatabaseListConnectionsResult,
  DatabaseRequestError,
  OrchestratorMcpFailure,
  PositiveInt,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Tool from "effect/ai/Tool";
import * as Toolkit from "effect/ai/Toolkit";
import * as DatabaseService from "../../../database/DatabaseService.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const shared = {
  failure: Schema.Union([DatabaseRequestError, OrchestratorMcpFailure]),
  failureMode: "return" as const,
  dependencies: [
    DatabaseService.DatabaseService,
    ThreadManagementService.ThreadManagementService,
    McpInvocationContext.McpInvocationContext,
  ],
};
const list = Tool.make("db_list_connections", {
  ...shared,
  description:
    "List database connections usable from this thread's project. Passwords are never returned.",
  success: DatabaseListConnectionsResult,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);
const describe = Tool.make("db_describe", {
  ...shared,
  description:
    "Browse a database one level at a time: schemas, objects in a schema, or columns of an object. Only this thread's project connections are accessible.",
  parameters: Schema.Struct({ connectionId: DatabaseConnectionId, scope: DatabaseIntrospectScope }),
  success: DatabaseIntrospectResult,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);
const query = Tool.make("db_query", {
  ...shared,
  description:
    "Run one SQL statement in a fresh read-only session on this environment. Returns at most rowCap rows (default 200, maximum 500), with bounded text cells. hasMore means rows were omitted; the result is already closed. Read-only is an accident guard; use a SELECT-only database role for a real boundary.",
  parameters: Schema.Struct({
    connectionId: DatabaseConnectionId,
    sql: DatabaseExecuteInput.fields.sql,
    rowCap: Schema.optionalKey(PositiveInt.check(Schema.isLessThanOrEqualTo(500))),
  }),
  success: DatabaseExecuteResult,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);
export const DatabaseToolkit = Toolkit.make(list, describe, query);
