import { type EnvironmentId, type T3ProjectFile } from "@t3tools/contracts";
import { PROJECT_FILE_NAMES, parseT3ProjectFile } from "@t3tools/shared/t3ProjectFile";
import { executeAtomQuery } from "@t3tools/client-runtime/state/runtime";

import {
  getProjectFileQueryAtom,
  resolveProjectFileQueryData,
} from "~/components/files/projectFilesQueryState";
import { appAtomRegistry } from "~/rpc/atomRegistry";

/**
 * Read and decode the project's checked-in project file (`kinako.json`, else
 * upstream's `t3.json`).
 *
 * Imperative counterpart to `useT3ProjectFileState` for the new-thread path,
 * which resolves defaults at call time rather than render time. The file
 * query atom caches per (environment, cwd), so repeat calls don't re-fetch.
 * Optimistic in-app writes overlay the query result, matching what
 * `useProjectFileQuery` renders. Missing, truncated, or invalid files
 * resolve to null.
 */
export async function readT3ProjectFile(
  environmentId: EnvironmentId,
  workspaceRoot: string,
): Promise<T3ProjectFile | null> {
  for (const fileName of PROJECT_FILE_NAMES) {
    const result = await executeAtomQuery(
      appAtomRegistry,
      getProjectFileQueryAtom(environmentId, workspaceRoot, fileName),
      { reportDefect: false, reportFailure: false },
    );
    const data = resolveProjectFileQueryData(
      environmentId,
      workspaceRoot,
      fileName,
      result._tag === "Success" ? result.value : null,
    );
    if (data === null) continue;
    if (data.truncated) return null;
    return parseT3ProjectFile(data.contents);
  }
  return null;
}
