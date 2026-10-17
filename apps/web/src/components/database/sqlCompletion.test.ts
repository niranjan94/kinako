import { describe, expect, it } from "@effect/vitest";
import { CompletionContext } from "@codemirror/autocomplete";
import { EditorState } from "@codemirror/state";
import { sql, PostgreSQL, SQLite } from "@codemirror/lang-sql";
import type { DatabaseEngine, DatabaseIntrospectScope } from "@t3tools/contracts";
import { createSqlSchemaCompletion, sqlFunctionCompletion } from "./sqlCompletion";

function context(text: string, engine: DatabaseEngine = "postgres") {
  const pos = text.indexOf("|");
  return new CompletionContext(
    EditorState.create({
      doc: text.replace("|", ""),
      extensions: [sql({ dialect: engine === "postgres" ? PostgreSQL : SQLite })],
    }),
    pos,
    true,
  );
}

function fixture(engine: DatabaseEngine = "postgres") {
  const calls: DatabaseIntrospectScope[] = [];
  const schema = engine === "postgres" ? "public" : "main";
  const source = createSqlSchemaCompletion(engine, async (scope) => {
    calls.push(scope);
    if (scope.kind === "schemas")
      return {
        kind: "schemas",
        schemas: [{ name: schema }, { name: "audit" }],
        searchPath: [schema],
      };
    if (scope.kind === "objects")
      return {
        kind: "objects",
        objects: [
          { name: "customers", type: "table" },
          { name: "Order Items", type: "table" },
        ],
      };
    return {
      kind: "columns",
      columns: [
        {
          name: "id",
          dataType: "integer",
          nullable: false,
          primaryKey: true,
          references: null,
          defaultValue: null,
        },
        {
          name: "full name",
          dataType: "text",
          nullable: true,
          primaryKey: false,
          references: null,
          defaultValue: null,
        },
      ],
    };
  });
  return { calls, source };
}

describe("SQL metadata completion", () => {
  it("resolves quoted mixed-case SQLite tables", async () => {
    const { source, calls } = fixture("sqlite");
    const result = await source(context('SELECT o.| FROM "Order Items" o', "sqlite"));
    expect(result?.options.find((option) => option.label === "id")).toBeDefined();
    expect(calls).toContainEqual({ kind: "columns", schema: "main", object: "Order Items" });
  });

  it("uses the session search path in order, including fallback schemas", async () => {
    const source = createSqlSchemaCompletion("postgres", async (scope) => {
      if (scope.kind === "schemas")
        return {
          kind: "schemas",
          schemas: [{ name: "public" }, { name: "tenant" }],
          searchPath: ["tenant", "public"],
        };
      if (scope.kind === "objects")
        return {
          kind: "objects",
          objects:
            scope.schema === "tenant"
              ? [{ name: "customers", type: "table" }]
              : [
                  { name: "customers", type: "table" },
                  { name: "legacy", type: "table" },
                ],
        };
      return {
        kind: "columns",
        columns: [
          {
            name: "id",
            dataType: scope.schema,
            nullable: false,
            primaryKey: true,
            references: null,
            defaultValue: null,
          },
        ],
      };
    });
    const tables = await source(context("SELECT * FROM |"));
    expect(tables?.options.find((option) => option.label === "customers")?.apply).toBe(
      '"tenant"."customers"',
    );
    expect(tables?.options.find((option) => option.label === "legacy")?.apply).toBe(
      '"public"."legacy"',
    );
    const columns = await source(context("SELECT c.| FROM customers c"));
    expect(columns?.options.find((option) => option.label === "id")?.detail).toContain("tenant");
  });

  it("preserves literal dots in schema and table names", async () => {
    const source = createSqlSchemaCompletion("postgres", async (scope) => {
      if (scope.kind === "schemas")
        return { kind: "schemas", schemas: [{ name: "tenant.one" }], searchPath: ["tenant.one"] };
      if (scope.kind === "objects")
        return { kind: "objects", objects: [{ name: "order.items", type: "table" }] };
      return {
        kind: "columns",
        columns: [
          {
            name: "id",
            dataType: "integer",
            nullable: false,
            primaryKey: true,
            references: null,
            defaultValue: null,
          },
        ],
      };
    });
    const tables = await source(context("SELECT * FROM |"));
    expect(tables?.options.find((option) => option.label === "order.items")?.apply).toBe(
      '"tenant.one"."order.items"',
    );
    const columns = await source(context('SELECT t.| FROM "tenant.one"."order.items" t'));
    expect(columns?.options.find((option) => option.label === "id")).toBeDefined();
  });
  it("suggests qualified table names without opening the explorer or loading all columns", async () => {
    const { source, calls } = fixture();
    const result = await source(context("SELECT * FROM cus|"));
    expect(result?.options.find((option) => option.label === "customers")).toMatchObject({
      apply: '"public"."customers"',
      detail: "public · table",
    });
    expect(calls.map((scope) => scope.kind)).toEqual(["schemas", "objects"]);
  });

  it("resolves aliases and only loads columns for the referenced table", async () => {
    const { source, calls } = fixture();
    const result = await source(context("SELECT c.| FROM customers AS c"));
    expect(result?.options.map((option) => option.label)).toContain("id");
    expect(result?.options.find((option) => option.label === "full name")).toMatchObject({
      detail: "text · nullable",
    });
    expect(calls.filter((scope) => scope.kind === "columns")).toEqual([
      { kind: "columns", schema: "public", object: "customers" },
    ]);
  });

  it("offers in-scope columns before FROM and preserves spaces in identifiers", async () => {
    const { source } = fixture();
    const result = await source(context('SELECT fu| FROM "public"."Order Items"'));
    expect(result?.options.find((option) => option.label === "full name")).toMatchObject({
      apply: '"full name"',
      detail: "text",
    });
  });

  it("recognizes unquoted PostgreSQL table names regardless of input case", async () => {
    const { source } = fixture();
    const result = await source(context("SELECT | FROM CUSTOMERS"));
    expect(result?.options.find((option) => option.label === "id")).toBeDefined();
  });

  it("avoids ambiguous unqualified columns in joins while retaining alias completion", async () => {
    const { source } = fixture();
    const result = await source(
      context('SELECT | FROM customers c JOIN "Order Items" o ON c.id = o.id'),
    );
    expect(result?.options.find((option) => option.label === "id")).toBeUndefined();
    const qualified = await source(
      context('SELECT o.| FROM customers c JOIN "Order Items" o ON c.id = o.id'),
    );
    expect(qualified?.options.find((option) => option.label === "id")).toBeDefined();
  });

  it("does not duplicate the schema prefix when completing qualified table names", async () => {
    const { source } = fixture();
    const result = await source(context("SELECT * FROM audit.cus|"));
    expect(result?.options.find((option) => option.label === "customers")).toMatchObject({
      apply: '"customers"',
    });
  });

  it("caches metadata and ignores other statements, strings, and comments", async () => {
    const { source, calls } = fixture();
    const query =
      "SELECT * FROM audit.\"Order Items\"; SELECT c.|, 'FROM audit.fake' FROM customers c -- JOIN ghost";
    await source(context(query));
    const count = calls.length;
    await source(context(query));
    expect(calls).toHaveLength(count);
    expect(calls.filter((scope) => scope.kind === "columns")).toEqual([
      { kind: "columns", schema: "public", object: "customers" },
    ]);
    expect(await source(context("SELECT 'hello|world'"))).toBeNull();
    expect(await source(context("-- FROM customers |"))).toBeNull();
    expect(calls).toHaveLength(count);
  });

  it("uses SQLite's schema and recovers after a failed metadata request", async () => {
    const { source } = fixture("sqlite");
    expect(
      (await source(context("SELECT * FROM cus|", "sqlite")))?.options.find(
        (option) => option.label === "customers",
      )?.apply,
    ).toBe('"main"."customers"');
    let attempts = 0;
    const offline = createSqlSchemaCompletion("postgres", async () => {
      attempts++;
      throw new Error("Disconnected");
    });
    expect(await offline(context("SELECT |"))).toBeNull();
    expect(await offline(context("SELECT |"))).toBeNull();
    expect(attempts).toBe(2);
  });

  it("offers function argument snippets outside strings and comments", async () => {
    expect(
      (await sqlFunctionCompletion(context("SELECT COA|")))?.options.find(
        (option) => option.label === "COALESCE",
      )?.type,
    ).toBe("function");
    expect(await sqlFunctionCompletion(context("SELECT 'COA|'"))).toBeNull();
    expect(await sqlFunctionCompletion(context("-- COA|"))).toBeNull();
    expect(await sqlFunctionCompletion(context("SELECT c.| FROM customers c"))).toBeNull();
  });
});
