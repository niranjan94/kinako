import {
  DatabaseConnection,
  DatabaseConnectionId,
  DatabaseRequestError,
  DatabaseTarget,
  type DatabaseConnectionDraft,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";

/** A saved connection with its password, for opening a session. Never sent to clients. */
export interface DatabaseConnectionCredentials {
  readonly connection: DatabaseConnection;
  readonly password: string | null;
}

/**
 * Saved database connections for this environment. Rows hold everything but the password, which
 * goes to the secret store under the connection's id so it shares the store's file permissions.
 */
export class DatabaseConnections extends Context.Service<
  DatabaseConnections,
  {
    readonly list: () => Effect.Effect<ReadonlyArray<DatabaseConnection>, DatabaseRequestError>;
    readonly get: (
      id: DatabaseConnectionId,
    ) => Effect.Effect<DatabaseConnectionCredentials, DatabaseRequestError>;
    readonly save: (
      draft: DatabaseConnectionDraft,
    ) => Effect.Effect<DatabaseConnection, DatabaseRequestError>;
    readonly remove: (id: DatabaseConnectionId) => Effect.Effect<void, DatabaseRequestError>;
    /** The credentials a draft would connect with: its own password, else the stored one. */
    readonly resolveDraft: (
      draft: DatabaseConnectionDraft,
    ) => Effect.Effect<DatabaseConnectionCredentials, DatabaseRequestError>;
  }
>()("t3/database/DatabaseConnections") {}

const passwordSecretName = (id: DatabaseConnectionId) => `database-connection-${id}`;

const ConnectionRow = Schema.Struct({
  id: DatabaseConnectionId,
  name: Schema.String,
  target: Schema.fromJsonString(DatabaseTarget),
  readOnly: Schema.Number,
  createdAt: Schema.String,
  updatedAt: Schema.String,
});

const encodeTarget = Schema.encodeSync(Schema.fromJsonString(DatabaseTarget));

const storageFailed = (cause: unknown) =>
  new DatabaseRequestError({ failure: "storage-failed", cause });

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const crypto = yield* Crypto.Crypto;

  const selectAll = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ConnectionRow,
    execute: () => sql`
      SELECT
        id,
        name,
        target_json AS "target",
        read_only AS "readOnly",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM database_connections
      ORDER BY name COLLATE NOCASE, id
    `,
  });

  const hasPassword = (id: DatabaseConnectionId) =>
    secrets.get(passwordSecretName(id)).pipe(Effect.map(Option.isSome));

  const toConnection = (row: typeof ConnectionRow.Type) =>
    hasPassword(row.id).pipe(
      Effect.map((stored): DatabaseConnection => ({
        id: row.id,
        name: row.name,
        target: row.target,
        readOnly: row.readOnly !== 0,
        hasPassword: stored,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      })),
    );

  const list = () =>
    selectAll(undefined).pipe(
      Effect.flatMap((rows) => Effect.forEach(rows, toConnection)),
      Effect.mapError(storageFailed),
    );

  const find = (id: DatabaseConnectionId) =>
    list().pipe(
      Effect.flatMap((connections) => {
        const connection = connections.find((candidate) => candidate.id === id);
        return connection
          ? Effect.succeed(connection)
          : Effect.fail(new DatabaseRequestError({ failure: "connection-not-found" }));
      }),
    );

  const readPassword = (id: DatabaseConnectionId) =>
    secrets
      .get(passwordSecretName(id))
      .pipe(
        Effect.map(Option.map((bytes) => new TextDecoder().decode(bytes))),
        Effect.map(Option.getOrNull),
        Effect.mapError(storageFailed),
      );

  const get = (id: DatabaseConnectionId) =>
    Effect.all({ connection: find(id), password: readPassword(id) });

  const save = (draft: DatabaseConnectionDraft) =>
    Effect.gen(function* () {
      const now = DateTime.formatIso(yield* DateTime.now);
      const existing = draft.id === undefined ? undefined : yield* find(draft.id);
      const id =
        existing?.id ??
        DatabaseConnectionId.make(yield* crypto.randomUUIDv4.pipe(Effect.mapError(storageFailed)));
      yield* sql`
        INSERT INTO database_connections (id, name, target_json, read_only, created_at, updated_at)
        VALUES (
          ${id},
          ${draft.name},
          ${encodeTarget(draft.target)},
          ${draft.readOnly ? 1 : 0},
          ${existing?.createdAt ?? now},
          ${now}
        )
        ON CONFLICT (id) DO UPDATE SET
          name = excluded.name,
          target_json = excluded.target_json,
          read_only = excluded.read_only,
          updated_at = excluded.updated_at
      `.pipe(Effect.mapError(storageFailed));
      if (draft.password === null) {
        yield* secrets.remove(passwordSecretName(id)).pipe(Effect.mapError(storageFailed));
      } else if (draft.password !== undefined) {
        yield* secrets
          .set(passwordSecretName(id), new TextEncoder().encode(draft.password))
          .pipe(Effect.mapError(storageFailed));
      }
      return yield* find(id);
    });

  const remove = (id: DatabaseConnectionId) =>
    Effect.gen(function* () {
      yield* find(id);
      yield* sql`DELETE FROM database_connections WHERE id = ${id}`.pipe(
        Effect.mapError(storageFailed),
      );
      yield* secrets.remove(passwordSecretName(id)).pipe(Effect.mapError(storageFailed));
    });

  const resolveDraft = (draft: DatabaseConnectionDraft) =>
    Effect.gen(function* () {
      const now = DateTime.formatIso(yield* DateTime.now);
      const stored = draft.id === undefined ? undefined : yield* get(draft.id);
      const password = draft.password === undefined ? (stored?.password ?? null) : draft.password;
      return {
        connection: {
          id: stored?.connection.id ?? DatabaseConnectionId.make("draft"),
          name: draft.name,
          target: draft.target,
          readOnly: draft.readOnly,
          hasPassword: password !== null,
          createdAt: stored?.connection.createdAt ?? now,
          updatedAt: now,
        },
        password,
      };
    });

  return DatabaseConnections.of({ list, get, save, remove, resolveDraft });
});

export const layer = Layer.effect(DatabaseConnections, make);
