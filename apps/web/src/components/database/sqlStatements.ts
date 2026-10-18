import { splitQuery, postgreSplitterOptions, sqliteSplitterOptions } from "dbgate-query-splitter";
import type { DatabaseEngine } from "@t3tools/contracts";
import { sqlDialect } from "./sqlDialect";

export interface SqlStatement {
  text: string;
  /** Offset of `text` within the SQL it was split from. */
  from: number;
}

export function sqlStatementRanges(
  sql: string,
  engine: DatabaseEngine,
  cursor?: number,
): SqlStatement[] {
  const statements = splitQuery(sql, {
    ...(engine === "postgres" ? postgreSplitterOptions : sqliteSplitterOptions),
    returnRichInfo: true,
  }).flatMap((item) =>
    typeof item === "string" ? [] : item.text.trim() && !item.specialMarker ? [item] : [],
  );
  const range = (item: (typeof statements)[number]): SqlStatement => ({
    text: item.text,
    // The splitter's start includes the whitespace it trimmed off the text.
    from: Math.max(item.start.position, sql.indexOf(item.text, item.start.position)),
  });
  if (cursor === undefined) return statements.map(range);
  const statement =
    statements.find((item) => cursor >= item.start.position && cursor <= item.end.position) ??
    statements.find((item) => item.start.position >= cursor) ??
    statements.at(-1);
  return statement ? [range(statement)] : [];
}

export function sqlStatements(sql: string, engine: DatabaseEngine, cursor?: number) {
  return sqlStatementRanges(sql, engine, cursor).map((statement) => statement.text);
}

export type SqlWriteRisk = "unfiltered-write" | "drop";

export function sqlWriteRisk(
  sql: string,
  engine: DatabaseEngine = "postgres",
): SqlWriteRisk | null {
  const tokens: string[] = [];
  const dialect = sqlDialect(engine);
  dialect.language.parser.parse(sql).iterate({
    enter(node) {
      if (node.name === "Keyword" || ["(", ")", ";"].includes(node.name))
        tokens.push(sql.slice(node.from, node.to).toUpperCase());
    },
  });
  const unfiltered = new Set<number>();
  let depth = 0;
  for (const [index, token] of tokens.entries()) {
    if (token === "DROP" || token === "TRUNCATE") return "drop";
    if (token === ";" && unfiltered.size) return "unfiltered-write";
    if (token === "(") depth++;
    else if (token === ")") {
      if (unfiltered.has(depth)) return "unfiltered-write";
      depth--;
    } else if (
      (token === "UPDATE" || token === "DELETE") &&
      // Row locks, upserts, foreign key actions, and trigger events name the verb without running it.
      !["FOR", "KEY", "DO", "ON", "OF", "OR", "BEFORE", "AFTER"].includes(tokens[index - 1] ?? "")
    ) {
      unfiltered.add(depth);
    } else if (token === "WHERE") unfiltered.delete(depth);
  }
  return unfiltered.size > 0 ? "unfiltered-write" : null;
}

export const sqlNeedsWriteConfirmation = (sql: string, engine: DatabaseEngine = "postgres") =>
  sqlWriteRisk(sql, engine) !== null;
