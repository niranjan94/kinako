import * as Effect from "effect/Effect";
import * as DatabaseService from "../../../database/DatabaseService.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { DatabaseToolkit } from "./tools.ts";

export const layer = McpToolAccess.toLayer(DatabaseToolkit, {
  db_list_connections: McpToolAccess.readsDatabase((_input, projectId) =>
    Effect.gen(function* () {
      const database = yield* DatabaseService.DatabaseService;
      return yield* database.listConnections({ projectId });
    }),
  ),
  db_describe: McpToolAccess.readsDatabase((input, projectId) =>
    Effect.gen(function* () {
      const database = yield* DatabaseService.DatabaseService;
      return yield* database.introspect({ ...input, projectId });
    }),
  ),
  db_query: McpToolAccess.readsDatabase((input, projectId) =>
    Effect.gen(function* () {
      const database = yield* DatabaseService.DatabaseService;
      return yield* database.queryReadOnly({ ...input, projectId });
    }),
  ),
});
