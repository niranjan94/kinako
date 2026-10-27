import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE INDEX orchestration_v2_snooze_wake_due_idx
    ON orchestration_v2_projection_threads(julianday(json_extract(payload_json, '$.snoozedUntil')))
    WHERE deleted_at IS NULL
      AND json_extract(payload_json, '$.archivedAt') IS NULL
      AND json_extract(payload_json, '$.snoozeWakeNotifiedAt') IS NOT json_extract(payload_json, '$.snoozedUntil')
  `;
});
