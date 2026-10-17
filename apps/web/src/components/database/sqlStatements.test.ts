import { describe, expect, it } from "@effect/vitest";
import { sqlNeedsWriteConfirmation, sqlStatements } from "./sqlStatements";

describe("SQL editor statements", () => {
  it("keeps quoted semicolons and Postgres dollar quoted blocks intact", () => {
    const sql = "SELECT ';'; DO $$ BEGIN RAISE NOTICE 'x;y'; END $$; SELECT 2;";
    expect(sqlStatements(sql, "postgres")).toHaveLength(3);
    expect(sqlStatements(sql, "postgres", sql.indexOf("NOTICE"))[0]).toContain("DO $$");
  });
  it("runs the SQLite statement under the cursor and splits selected scripts", () => {
    const sql = "SELECT 'a;b';\nSELECT 2;";
    expect(sqlStatements(sql, "sqlite", sql.indexOf("2"))).toEqual(["SELECT 2"]);
    expect(sqlStatements(sql, "sqlite")).toEqual(["SELECT 'a;b'", "SELECT 2"]);
  });
  it("warns for unfiltered writes even when a string or comment says WHERE", () => {
    expect(sqlNeedsWriteConfirmation("UPDATE users SET note = 'WHERE' -- WHERE id = 1")).toBe(true);
    expect(sqlNeedsWriteConfirmation("DELETE FROM users")).toBe(true);
    expect(sqlNeedsWriteConfirmation("DELETE FROM users WHERE id = 1")).toBe(false);
    expect(sqlNeedsWriteConfirmation("SELECT 'DELETE FROM users'")).toBe(false);
    expect(
      sqlNeedsWriteConfirmation("UPDATE users SET note = (SELECT note FROM defaults WHERE id = 1)"),
    ).toBe(true);
    expect(
      sqlNeedsWriteConfirmation(
        "WITH gone AS (DELETE FROM users RETURNING *) SELECT * FROM gone WHERE id = 1",
      ),
    ).toBe(true);
    expect(sqlNeedsWriteConfirmation("UPDATE users SET note = $$WHERE$$")).toBe(true);
    expect(sqlNeedsWriteConfirmation("SELECT * FROM users FOR UPDATE")).toBe(false);
  });
  it("does not mistake dialect-specific quoted text for a WHERE clause", () => {
    expect(
      sqlNeedsWriteConfirmation(
        String.raw`UPDATE customers SET note = E'it\'s WHERE something'`,
        "postgres",
      ),
    ).toBe(true);
    expect(sqlNeedsWriteConfirmation("UPDATE customers SET [where] = 1", "sqlite")).toBe(true);
    expect(sqlNeedsWriteConfirmation("DELETE FROM `where`", "sqlite")).toBe(true);
    expect(
      sqlNeedsWriteConfirmation(
        String.raw`UPDATE customers SET note = E'it\'s WHERE something' WHERE id = 1`,
        "postgres",
      ),
    ).toBe(false);
    expect(
      sqlNeedsWriteConfirmation("UPDATE customers SET [where] = 1 WHERE id = 1", "sqlite"),
    ).toBe(false);
  });
});
