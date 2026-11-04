import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // Unguarded, the index throws on any write of a payload that is not valid JSON.
  yield* sql`DROP INDEX IF EXISTS orchestration_v2_snooze_wake_due_idx`;
  yield* sql`
    CREATE INDEX orchestration_v2_snooze_wake_due_idx
    ON orchestration_v2_projection_threads(julianday(json_extract(payload_json, '$.snoozedUntil')))
    WHERE deleted_at IS NULL
      AND CASE WHEN json_valid(payload_json) THEN
        json_extract(payload_json, '$.archivedAt') IS NULL
        AND json_extract(payload_json, '$.snoozeWakeNotifiedAt') IS NOT json_extract(payload_json, '$.snoozedUntil')
        ELSE 0 END
  `;
});
