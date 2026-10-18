import { createDatabaseState } from "@t3tools/client-runtime/state/database";
import { connectionAtomRuntime } from "../connection/runtime";
import { restoreDatabaseWorkspace } from "../components/database/databaseConsoleStorage";

export const databaseState = createDatabaseState(connectionAtomRuntime, {
  restoreWorkspace: restoreDatabaseWorkspace,
});
