import { expect, it } from "@effect/vitest";
import { DatabaseConnectionId, EnvironmentId, type DatabaseConnection } from "@t3tools/contracts";
import {
  databaseGlobalCoverage,
  databaseGlobalDraft,
  fanOutDatabaseOperation,
} from "./database.ts";

const first = EnvironmentId.make("first");
const second = EnvironmentId.make("second");
const offline = EnvironmentId.make("offline");
const connection = (updatedAt: string): DatabaseConnection => ({
  id: DatabaseConnectionId.make("shared"),
  name: "Hosted",
  level: "global",
  projectId: null,
  target: {
    engine: "postgres",
    host: "db.example.com",
    port: 5432,
    database: "app",
    user: "reader",
    sslMode: "require",
  },
  readOnly: true,
  hasPassword: true,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt,
});

it("shows missing and older global copies without hiding distinct environments", () => {
  const older = connection("2026-01-01T00:00:00.000Z");
  const newest = connection("2026-02-01T00:00:00.000Z");
  const result = databaseGlobalCoverage(
    [
      { environmentId: first, connection: older },
      { environmentId: second, connection: newest },
    ],
    [first, second, offline],
  );
  expect(result).toHaveLength(1);
  expect(result[0]?.connection).toEqual(newest);
  expect(result[0]?.missing).toEqual([offline]);
  expect(result[0]?.older.map((copy) => copy.environmentId)).toEqual([first]);
});

it("retains successful global saves while reporting individual failures with the same revision", async () => {
  const input = databaseGlobalDraft(
    {
      name: "Hosted",
      level: "global",
      target: connection("").target,
      readOnly: true,
      password: "new-password",
    },
    DatabaseConnectionId.make("linked"),
    "2026-03-01T00:00:00.000Z",
  );
  const saved = new Map<EnvironmentId, typeof input>();
  const results = await fanOutDatabaseOperation([first, second, offline], async (environmentId) => {
    if (environmentId === offline) throw new Error("Disconnected");
    saved.set(environmentId, input);
    return input.id;
  });
  expect([...saved.values()].map((draft) => [draft.id, draft.updatedAt])).toEqual([
    ["linked", input.updatedAt],
    ["linked", input.updatedAt],
  ]);
  expect(results.map((result) => [result.environmentId, result.ok])).toEqual([
    [first, true],
    [second, true],
    [offline, false],
  ]);
});
