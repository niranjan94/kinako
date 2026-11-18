import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS usage_quota_history (
      source_id TEXT NOT NULL,
      endpoint TEXT NOT NULL,
      minute INTEGER NOT NULL,
      sample_json TEXT NOT NULL,
      PRIMARY KEY (source_id, endpoint, minute)
    ) WITHOUT ROWID
  `;
  yield* sql`CREATE INDEX IF NOT EXISTS idx_usage_quota_history_minute ON usage_quota_history(minute)`;
});
