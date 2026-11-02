import { PostgreSQL, SQLite, SQLDialect, StandardSQL } from "@codemirror/lang-sql";
import type { DatabaseEngine } from "@t3tools/contracts";

// SQLite accepts bracket-quoted identifiers; the stock dialect omits them.
const sqlite = SQLDialect.define({ ...SQLite.spec, identifierQuotes: '"`[' });
const clickhouse = SQLDialect.define({ ...StandardSQL.spec, identifierQuotes: '"`' });

export const sqlDialect = (engine: DatabaseEngine) =>
  engine === "postgres" ? PostgreSQL : engine === "clickhouse" ? clickhouse : sqlite;

export const ENGINE_LABELS: Record<DatabaseEngine, string> = {
  postgres: "PostgreSQL",
  sqlite: "SQLite",
  clickhouse: "ClickHouse",
};
