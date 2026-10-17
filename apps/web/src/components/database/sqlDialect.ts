import { PostgreSQL, SQLite, SQLDialect } from "@codemirror/lang-sql";
import type { DatabaseEngine } from "@t3tools/contracts";

// SQLite accepts bracket-quoted identifiers; the stock dialect omits them.
const sqlite = SQLDialect.define({ ...SQLite.spec, identifierQuotes: '"`[' });

export const sqlDialect = (engine: DatabaseEngine) => (engine === "postgres" ? PostgreSQL : sqlite);
