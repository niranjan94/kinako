import {
  defaultSandboxPaths,
  type ProjectSandboxOverride,
  type ProjectSettingsOverrides,
  type SandboxPathList,
  type SandboxPlatform,
} from "@t3tools/contracts";

export type SandboxListKey = "readWritePaths" | "readOnlyPaths";

/** What a saved list stands for: itself, or the platform defaults when it is null. */
export function effectiveSandboxPathList(
  saved: SandboxPathList | null,
  key: SandboxListKey,
  platform: SandboxPlatform,
): { readonly paths: SandboxPathList; readonly usesDefaults: boolean } {
  return saved === null
    ? { paths: defaultSandboxPaths(platform)[key], usesDefaults: true }
    : { paths: saved, usesDefaults: false };
}

/** `paths` with `raw` appended, or why it was not. */
export function addSandboxPath(
  paths: SandboxPathList,
  raw: string,
): { readonly paths: SandboxPathList } | { readonly error: string } {
  const path = raw.trim();
  if (path.length === 0) return { error: "Enter a path." };
  if (paths.includes(path)) return { error: "Already listed." };
  return { paths: [...paths, path] };
}

/** The project's override entry with its sandbox additions replaced; null once it holds nothing. */
export function withProjectSandbox(
  entry: ProjectSettingsOverrides | undefined,
  sandbox: ProjectSandboxOverride,
): ProjectSettingsOverrides | null {
  const { sandbox: _previous, ...rest } = entry ?? {};
  const additions: ProjectSandboxOverride = {
    ...((sandbox.readWritePaths?.length ?? 0) > 0
      ? { readWritePaths: sandbox.readWritePaths }
      : {}),
    ...((sandbox.readOnlyPaths?.length ?? 0) > 0 ? { readOnlyPaths: sandbox.readOnlyPaths } : {}),
  };
  const next = Object.keys(additions).length === 0 ? rest : { ...rest, sandbox: additions };
  return Object.keys(next).length === 0 ? null : next;
}
