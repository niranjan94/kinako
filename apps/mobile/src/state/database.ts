import { createDatabaseState } from "@t3tools/client-runtime/state/database";
import { connectionAtomRuntime } from "../connection/runtime";

export const databaseState = createDatabaseState(connectionAtomRuntime);
