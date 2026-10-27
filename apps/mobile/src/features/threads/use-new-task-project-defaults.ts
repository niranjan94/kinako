import { resolveFilesystemReadAccess } from "@t3tools/client-runtime/state/filesystem";
import { isScratchProject } from "@t3tools/client-runtime/state/projects";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import type { ProjectReadFileResult } from "@t3tools/contracts";
import { DEFAULT_SERVER_SETTINGS, T3_PROJECT_FILE_NAME } from "@t3tools/contracts";
import { FORK_PROJECT_FILE_NAME } from "@t3tools/shared/forkBrand";
import { resolveNewThreadEnvMode, resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { parseT3ProjectFile } from "@t3tools/shared/t3ProjectFile";

import { useEnvironmentServerConfig } from "../../state/entities";
import { useEnvironmentPresentation } from "../../state/presentation";
import { useProjectHasThreads } from "../../state/project-has-threads";
import { projectEnvironment } from "../../state/projects";
import { useEnvironmentQuery } from "../../state/query";
import { environmentSession } from "../../state/session";

/**
 * A project's new-task defaults: server settings merged with its t3.json. The
 * new-task flow and the home pending-drafts list both read the default
 * workspace mode here, so a draft that never picked one shows what it sends.
 * Every read is a shared per-environment or per-project atom.
 */
export function useNewTaskProjectDefaults(project: EnvironmentProject | null) {
  const serverConfig = useEnvironmentServerConfig(project?.environmentId ?? null);
  const isScratch =
    project !== null && isScratchProject(project, serverConfig?.scratchWorkspaceRoot);
  const hasWorkspace = project !== null && project.workspaceRoot !== "";
  const fileAccessSession = useEnvironmentQuery(
    hasWorkspace ? environmentSession.sessionStateAtom(project.environmentId) : null,
  );
  const fileEnvironment = useEnvironmentPresentation(project?.environmentId ?? null);
  const fileAccess = resolveFilesystemReadAccess({
    isCatalogReady: fileEnvironment.isReady,
    connection: fileEnvironment.presentation?.connection ?? null,
    session: fileAccessSession.data,
    sessionError: fileAccessSession.error,
  });
  const fileAccessPending = hasWorkspace && fileAccess.isPending;
  const forkProjectFileQuery = useEnvironmentQuery(
    fileAccess.canReadFiles && hasWorkspace
      ? projectEnvironment.readFile({
          environmentId: project.environmentId,
          input: { cwd: project.workspaceRoot, relativePath: FORK_PROJECT_FILE_NAME },
        })
      : null,
  );
  const forkProjectFileData = forkProjectFileQuery.data as ProjectReadFileResult | null;
  const upstreamProjectFileQuery = useEnvironmentQuery(
    fileAccess.canReadFiles &&
      hasWorkspace &&
      !forkProjectFileQuery.isPending &&
      forkProjectFileData === null
      ? projectEnvironment.readFile({
          environmentId: project.environmentId,
          input: {
            cwd: project.workspaceRoot,
            relativePath: T3_PROJECT_FILE_NAME,
            allowMissing: true,
          },
        })
      : null,
  );
  const projectFilePending = forkProjectFileQuery.isPending || upstreamProjectFileQuery.isPending;
  const t3ProjectFileData =
    forkProjectFileData ?? (upstreamProjectFileQuery.data as ProjectReadFileResult | null);
  const t3ProjectFile =
    t3ProjectFileData === null || t3ProjectFileData.exists === false || t3ProjectFileData.truncated
      ? null
      : parseT3ProjectFile(t3ProjectFileData.contents);
  const projectSettings = resolveProjectSettings(
    serverConfig?.settings ?? DEFAULT_SERVER_SETTINGS,
    project?.id ?? null,
    project,
    t3ProjectFile,
  );
  const projectHasThreads = useProjectHasThreads(project);
  const defaultWorkspaceMode = isScratch
    ? "local"
    : resolveNewThreadEnvMode({
        projectSettings,
        workspaceRoot: project?.workspaceRoot ?? null,
        newProjectsRoot: serverConfig?.newProjectsRoot,
        projectHasThreads,
      });
  // While t3.json loads, the environment default is provisional; t3.json may replace it.
  const defaultWorkspaceModeSettled =
    projectSettings.sources.defaultThreadEnvMode !== "environment" ||
    (!projectFilePending && !fileAccessPending);
  return {
    serverConfig,
    isScratch,
    projectSettings,
    defaultWorkspaceMode,
    defaultWorkspaceModeSettled,
  };
}
