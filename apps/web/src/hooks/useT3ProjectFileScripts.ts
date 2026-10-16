import {
  T3_PROJECT_FILE_NAME,
  type EnvironmentId,
  type T3ProjectFile,
  type T3ProjectFileScript,
} from "@t3tools/contracts";
import { FORK_PROJECT_FILE_NAME } from "@t3tools/shared/forkBrand";
import { parseT3ProjectFile } from "@t3tools/shared/t3ProjectFile";
import { useMemo } from "react";

import { useProjectFileQuery } from "~/components/files/projectFilesQueryState";

const NO_SCRIPTS: ReadonlyArray<T3ProjectFileScript> = [];

export interface T3ProjectFileState {
  status: "loading" | "missing" | "invalid" | "valid";
  /** `kinako.json` unless only upstream's `t3.json` exists. */
  fileName: string;
  file: T3ProjectFile | null;
  scripts: ReadonlyArray<T3ProjectFileScript>;
}

export function useT3ProjectFileState(
  environmentId: EnvironmentId,
  cwd: string | null,
): T3ProjectFileState {
  const forkQuery = useProjectFileQuery(
    environmentId,
    cwd ?? "",
    FORK_PROJECT_FILE_NAME,
    cwd !== null,
  );
  const readUpstream = cwd !== null && !forkQuery.isPending && forkQuery.data === null;
  const upstreamQuery = useProjectFileQuery(
    environmentId,
    cwd ?? "",
    T3_PROJECT_FILE_NAME,
    readUpstream,
  );
  const active =
    readUpstream && upstreamQuery.data !== null
      ? { fileName: T3_PROJECT_FILE_NAME, data: upstreamQuery.data }
      : { fileName: FORK_PROJECT_FILE_NAME, data: forkQuery.data };
  const fileName = active.fileName;
  const contents = active.data && !active.data.truncated ? active.data.contents : null;
  const isPending = forkQuery.isPending || upstreamQuery.isPending;
  return useMemo(() => {
    if (contents === null) {
      return {
        status: isPending ? "loading" : "missing",
        fileName,
        file: null,
        scripts: NO_SCRIPTS,
      } as const;
    }
    const file = parseT3ProjectFile(contents);
    if (file === null) {
      return { status: "invalid", fileName, file: null, scripts: NO_SCRIPTS } as const;
    }
    return { status: "valid", fileName, file, scripts: file.scripts ?? NO_SCRIPTS } as const;
  }, [contents, fileName, isPending]);
}

export function useT3ProjectFileScripts(
  environmentId: EnvironmentId,
  cwd: string | null,
): ReadonlyArray<T3ProjectFileScript> {
  return useT3ProjectFileState(environmentId, cwd).scripts;
}
