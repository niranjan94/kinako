import { splitQuery, postgreSplitterOptions, sqliteSplitterOptions } from "dbgate-query-splitter";
import type { DatabaseEngine } from "@t3tools/contracts";
import { sqlDialect } from "./sqlDialect";

export function sqlStatements(sql: string, engine: DatabaseEngine, cursor?: number) {
  const statements = splitQuery(sql, {
    ...(engine === "postgres" ? postgreSplitterOptions : sqliteSplitterOptions),
    returnRichInfo: true,
  }).flatMap((item) =>
    typeof item === "string" ? [] : item.text.trim() && !item.specialMarker ? [item] : [],
  );
  if (cursor === undefined) return statements.map((item) => item.text);
  const statement =
    statements.find((item) => cursor >= item.start.position && cursor <= item.end.position) ??
    statements.find((item) => item.start.position >= cursor) ??
    statements.at(-1);
  return statement ? [statement.text] : [];
}

export function sqlNeedsWriteConfirmation(sql: string, engine: DatabaseEngine = "postgres") {
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
    if (token === ";" && unfiltered.size) return true;
    if (token === "(") depth++;
    else if (token === ")") {
      if (unfiltered.has(depth)) return true;
      depth--;
    } else if (
      (token === "UPDATE" || token === "DELETE") &&
      !["FOR", "KEY", "DO"].includes(tokens[index - 1] ?? "")
    ) {
      unfiltered.add(depth);
    } else if (token === "WHERE") unfiltered.delete(depth);
  }
  return unfiltered.size > 0;
}
