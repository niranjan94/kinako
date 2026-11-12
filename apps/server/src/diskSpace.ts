// @effect-diagnostics-next-line nodeBuiltinImport:off -- Effect has no free-space query.
import * as NodeFSP from "node:fs/promises";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export class DiskSpaceCheckError extends Schema.TaggedError<DiskSpaceCheckError>()(
  "DiskSpaceCheckError",
  { path: Schema.String, cause: Schema.Defect() },
) {
  override get message() {
    return "Could not check free disk space.";
  }
}

/** Space on the file system holding `path`, as an unprivileged user can use it. */
export const readDiskSpace = (path: string) =>
  Effect.tryPromise({
    try: () => NodeFSP.statfs(path),
    catch: (cause) => new DiskSpaceCheckError({ path, cause }),
  }).pipe(
    Effect.map((stats) => ({
      availableBytes: stats.bavail * stats.bsize,
      totalBytes: stats.blocks * stats.bsize,
    })),
  );
