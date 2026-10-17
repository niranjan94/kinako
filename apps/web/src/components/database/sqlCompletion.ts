import { syntaxTree } from "@codemirror/language";
import { schemaCompletionSource, type SQLNamespace } from "@codemirror/lang-sql";
import { sqlDialect } from "./sqlDialect";
import { snippetCompletion, type CompletionSource } from "@codemirror/autocomplete";
import type { EditorState } from "@codemirror/state";
import type {
  DatabaseColumnInfo,
  DatabaseEngine,
  DatabaseIntrospectResult,
  DatabaseIntrospectScope,
} from "@t3tools/contracts";

const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
const identifier = (name: string) =>
  name.startsWith('"') ? name.slice(1, -1).replaceAll('""', '"') : name.toLowerCase();

function statementAt(state: EditorState, pos: number) {
  let node = syntaxTree(state).resolveInner(pos, -1);
  while (node.parent && node.name !== "Statement") node = node.parent;
  return node;
}

// Use SQL tokens so strings and comments cannot trigger metadata requests.
function relations(state: EditorState, pos: number) {
  const paths: string[][] = [];
  const statement = statementAt(state, pos);
  let expectTable = false;
  let inFrom = false;
  statement.toTree().iterate({
    enter(node) {
      const from = statement.from + node.from;
      const to = statement.from + node.to;
      if (node.name === "Keyword") {
        const keyword = state.sliceDoc(from, to).toUpperCase();
        if (["FROM", "JOIN", "UPDATE", "INTO"].includes(keyword)) {
          expectTable = true;
          inFrom = true;
        } else if (
          ["WHERE", "GROUP", "ORDER", "HAVING", "LIMIT", "SET", "VALUES", "ON"].includes(keyword)
        ) {
          expectTable = false;
          inFrom = false;
        }
      } else if (node.name === "," && inFrom) {
        expectTable = true;
      } else if (/^(CompositeIdentifier|QuotedIdentifier|Identifier)$/.test(node.name)) {
        if (expectTable) {
          const text = state.sliceDoc(from, to);
          paths.push((text.match(/"(?:""|[^"])*"|[^.\s]+/g) ?? []).map(identifier));
          expectTable = false;
        }
        return false;
      }
    },
  });
  return paths;
}

export function createSqlSchemaCompletion(
  engine: DatabaseEngine,
  introspect: (scope: DatabaseIntrospectScope) => Promise<DatabaseIntrospectResult>,
): CompletionSource {
  const requests = new Map<string, Promise<DatabaseIntrospectResult>>();
  const key = (name: string) => name.replaceAll(".", "\\.");
  const normalize = (name: string) => (engine === "sqlite" ? name.toLowerCase() : name);
  const load = (scope: DatabaseIntrospectScope) => {
    const cacheKey = JSON.stringify(scope);
    let request = requests.get(cacheKey);
    if (!request) {
      request = introspect(scope).catch((error: unknown) => {
        requests.delete(cacheKey);
        throw error;
      });
      requests.set(cacheKey, request);
    }
    return request;
  };
  return async (context) => {
    const token = syntaxTree(context.state).resolveInner(context.pos, -1);
    if (/Comment|String/.test(token.name)) return null;
    if (!context.explicit && !context.matchBefore(/[\w".]+$/)) return null;
    try {
      const result = await load({ kind: "schemas" });
      if (context.aborted || result.kind !== "schemas") return null;
      const names = result.schemas.map((schema) => schema.name);
      const searchPath = result.searchPath ?? (engine === "sqlite" ? ["main"] : []);
      const referenced = relations(context.state, context.pos);
      const prefix = context.matchBefore(/(?:"(?:""|[^"])+"|[\w]+)\.(?:"(?:""|[^"])*|\w*)$/);
      const qualifier = prefix
        ? identifier(prefix.text.slice(0, prefix.text.lastIndexOf(".")))
        : undefined;
      const schemaName = (name: string) =>
        names.find((candidate) => normalize(candidate) === normalize(name));
      const needed = new Set(
        [
          ...searchPath,
          ...referenced.filter((path) => path.length > 1).map((path) => path.at(-2)!),
          ...(qualifier ? [qualifier] : []),
        ].flatMap((name) => schemaName(name) ?? []),
      );
      const objectsBySchema = new Map<
        string,
        Extract<DatabaseIntrospectResult, { kind: "objects" }>["objects"]
      >();
      for (const name of needed) {
        if (context.aborted) return null;
        const objects = await load({ kind: "objects", schema: name });
        if (objects.kind === "objects") objectsBySchema.set(name, objects.objects);
      }
      const resolved = new Map<string, string>();
      for (const name of searchPath) {
        const actual = schemaName(name);
        for (const object of objectsBySchema.get(actual ?? "") ?? []) {
          if (!resolved.has(normalize(object.name))) resolved.set(normalize(object.name), actual!);
        }
      }
      const schema: Record<string, SQLNamespace> = Object.fromEntries(
        names.map((name) => [key(name), {}]),
      );
      const columnsInScope: DatabaseColumnInfo[] = [];
      for (const [name, objects] of objectsBySchema) {
        const tables: Record<string, SQLNamespace> = {};
        for (const object of objects) {
          const used =
            referenced.some(
              (path) =>
                normalize(path.at(-1) ?? "") === normalize(object.name) &&
                (path.length === 1
                  ? resolved.get(normalize(object.name)) === name
                  : schemaName(path.at(-2)!) === name),
            ) ||
            (qualifier !== undefined && normalize(qualifier) === normalize(object.name));
          let columns: readonly DatabaseColumnInfo[] = [];
          if (used && !context.aborted) {
            const details = await load({ kind: "columns", schema: name, object: object.name });
            if (details.kind === "columns") columns = details.columns;
            columnsInScope.push(...columns);
          }
          const table = {
            self: {
              label: object.name,
              type: "class",
              detail: name + " · " + object.type,
              apply: quote(object.name),
            },
            children: columns.map((column) => ({
              label: column.name,
              type: "property",
              apply: quote(column.name),
              detail:
                column.dataType +
                (column.primaryKey ? " · PK" : "") +
                (column.nullable ? " · nullable" : ""),
              info:
                name +
                "." +
                object.name +
                "." +
                column.name +
                (column.references
                  ? " → " +
                    column.references.schema +
                    "." +
                    column.references.object +
                    "." +
                    column.references.column
                  : ""),
            })),
          };
          tables[key(object.name)] = table;
          if (resolved.get(normalize(object.name)) === name && !names.includes(object.name)) {
            schema[key(object.name)] = {
              ...table,
              self: { ...table.self, apply: quote(name) + "." + quote(object.name) },
            };
          }
        }
        schema[key(name)] = tables;
      }
      if (context.aborted) return null;
      const source = schemaCompletionSource({
        dialect: sqlDialect(engine),
        schema,
      });
      const completion = await source(context);
      if (!completion || prefix) return completion;
      const columnCounts = new Map<string, number>();
      for (const column of columnsInScope)
        columnCounts.set(column.name, (columnCounts.get(column.name) ?? 0) + 1);
      return {
        ...completion,
        options: [
          ...completion.options,
          ...columnsInScope
            .filter((column) => columnCounts.get(column.name) === 1)
            .map((column) => ({
              label: column.name,
              type: "property",
              detail: column.dataType,
              apply: quote(column.name),
              boost: 2,
            })),
        ],
      };
    } catch {
      // Keyword and function completion remain available when metadata is offline.
      return null;
    }
  };
}

export const sqlFunctionCompletion: CompletionSource = (context) => {
  const token = syntaxTree(context.state).resolveInner(context.pos, -1);
  if (
    /Comment|String/.test(token.name) ||
    context.state.sliceDoc(context.pos - 1, context.pos) === "."
  )
    return null;
  const word = context.matchBefore(/\w+$/);
  if (word && context.state.sliceDoc(word.from - 1, word.from) === ".") return null;
  if (!word && !context.explicit) return null;
  return {
    from: word?.from ?? context.pos,
    options: [
      snippetCompletion("COUNT(${column})", {
        label: "COUNT",
        type: "function",
        detail: "Count rows or non-null values",
      }),
      snippetCompletion("SUM(${column})", {
        label: "SUM",
        type: "function",
        detail: "Sum non-null values",
      }),
      snippetCompletion("AVG(${column})", {
        label: "AVG",
        type: "function",
        detail: "Average non-null values",
      }),
      snippetCompletion("MIN(${column})", {
        label: "MIN",
        type: "function",
        detail: "Minimum value",
      }),
      snippetCompletion("MAX(${column})", {
        label: "MAX",
        type: "function",
        detail: "Maximum value",
      }),
      snippetCompletion("COALESCE(${value}, ${fallback})", {
        label: "COALESCE",
        type: "function",
        detail: "First non-null value",
      }),
      snippetCompletion("LOWER(${text})", {
        label: "LOWER",
        type: "function",
        detail: "Lowercase text",
      }),
      snippetCompletion("UPPER(${text})", {
        label: "UPPER",
        type: "function",
        detail: "Uppercase text",
      }),
      snippetCompletion("ROUND(${value}, ${digits})", {
        label: "ROUND",
        type: "function",
        detail: "Round a numeric value",
      }),
    ],
    validFor: /^\w*$/,
  };
};
