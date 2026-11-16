import { useAtomValue } from "@effect/atom-react";
import {
  type EnvironmentId,
  isManagedSettingPath,
  type ProjectId,
  type ProjectSandboxOverride,
  type SandboxPathCheckResult,
  type SandboxPathList,
  type SandboxRejectedPath,
  type SandboxSettingsPatch,
} from "@t3tools/contracts";
import type { EnvironmentServerConfig } from "@t3tools/client-runtime/connection";
import { sandboxUnavailableReason } from "@t3tools/client-runtime/runtime-modes";
import { FORK_REPOSITORY } from "@t3tools/shared/forkBrand";
import { type ReactNode, useEffect, useEffectEvent, useState } from "react";

import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import {
  addSandboxPath,
  effectiveSandboxPathList,
  type SandboxListKey,
  withProjectSandbox,
} from "./SandboxSettings.logic";
import { useSettingsScope } from "./SettingsScopeContext";
import { SettingResetButton, SettingsRow, SettingsSection } from "./settingsLayout";
import { SettingsScopeNotice } from "./SettingsScopeNotice";
import { searchableSetting } from "./settingsSearch";
import { useScopedSettingsWriteAllowed } from "./useScopedSettings";

const COMMIT_SIGNING_DOCS_URL = `https://github.com/${FORK_REPOSITORY}/blob/main/docs/user/permission-modes.md#commit-signing`;

const LIST_COPY: Record<SandboxListKey, { title: string; description: string }> = {
  readWritePaths: {
    title: "Read and write",
    description: "Paths outside the project that sandboxed threads can read and change.",
  },
  readOnlyPaths: {
    title: "Read only",
    description: "Paths in your home folder that sandboxed threads can read but not change.",
  },
};

export function SandboxSettings() {
  const { scope, environment, targets, connectedEnvironments } = useSettingsScope();
  if (!connectedEnvironments.some((candidate) => candidate.serverConfig?.sandbox !== undefined)) {
    return null;
  }
  const isProjectScope = scope.kind === "project" || scope.kind === "checkout";
  if (isProjectScope) {
    const target = targets.length === 1 ? targets[0] : undefined;
    const config = connectedEnvironments.find(
      (candidate) => candidate.environmentId === target?.environmentId,
    )?.serverConfig;
    if (target?.projectId == null || !config) {
      return (
        <SettingsSection id="sandbox" title="Sandboxed full access">
          <SettingsScopeNotice inline target="checkout">
            Choose one checkout to add paths to its sandbox.
          </SettingsScopeNotice>
        </SettingsSection>
      );
    }
    return (
      <ProjectSandboxForm
        key={`${target.environmentId}:${target.projectId}`}
        environmentId={target.environmentId}
        projectId={target.projectId}
        config={config}
      />
    );
  }
  if (scope.kind !== "environment" || !environment?.serverConfig) {
    return (
      <SettingsSection id="sandbox" title="Sandboxed full access">
        <SettingsScopeNotice inline target="environment">
          Choose one environment to edit its sandbox.
        </SettingsScopeNotice>
      </SettingsSection>
    );
  }
  return (
    <EnvironmentSandboxForm
      key={environment.environmentId}
      environmentId={environment.environmentId}
      config={environment.serverConfig}
    />
  );
}

const sandboxPlatform = (config: EnvironmentServerConfig) =>
  config.environment.platform.os === "darwin" ? "darwin" : "linux";

/** The organization whose policy locks `key`'s list, which also drops every project's additions to it. */
const listManagedBy = (config: EnvironmentServerConfig, key: SandboxListKey) =>
  isManagedSettingPath(config.managedPolicy, `sandbox.${key}`)
    ? config.managedPolicy?.organization
    : undefined;

function EnvironmentSandboxForm(props: {
  environmentId: EnvironmentId;
  config: EnvironmentServerConfig;
}) {
  const { environmentId, config } = props;
  const saved = config.settings.sandbox;
  const canWrite = useScopedSettingsWriteAllowed();
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: true });
  const save = (sandbox: SandboxSettingsPatch) =>
    void updateSettings({ environmentId, input: { patch: { sandbox } } });
  const platform = sandboxPlatform(config);
  const readWrite = effectiveSandboxPathList(saved.readWritePaths, "readWritePaths", platform);
  const readOnly = effectiveSandboxPathList(saved.readOnlyPaths, "readOnlyPaths", platform);
  const check = useSandboxPathCheck(environmentId, readWrite.paths, readOnly.paths);
  const unavailable = sandboxUnavailableReason(config.sandbox);

  return (
    <SettingsSection id="sandbox" title="Sandboxed full access">
      {unavailable !== undefined ? (
        <SettingsRow title="Unavailable" description={unavailable} />
      ) : null}
      {(["readWritePaths", "readOnlyPaths"] as const).map((key) => {
        const list = key === "readWritePaths" ? readWrite : readOnly;
        const managedBy = listManagedBy(config, key);
        return (
          <SandboxPathListRow
            key={key}
            {...(key === "readWritePaths" ? searchableSetting("sandbox-paths") : {})}
            title={LIST_COPY[key].title}
            description={
              list.usesDefaults
                ? `${LIST_COPY[key].description} These are the defaults for this environment.`
                : LIST_COPY[key].description
            }
            paths={list.paths}
            rejected={forList(check.rejected, key)}
            warnings={forList(check.warnings, key)}
            disabled={!canWrite}
            managedBy={managedBy}
            onChange={(paths) => save({ [key]: paths })}
            resetAction={
              list.usesDefaults || !canWrite || managedBy !== undefined ? null : (
                <SettingResetButton
                  label={`${LIST_COPY[key].title.toLowerCase()} paths`}
                  onClick={() => save({ [key]: null })}
                />
              )
            }
          />
        );
      })}
      <SettingsRow
        {...searchableSetting("sandbox-docker")}
        serverScoped
        settingKeys={["sandbox"]}
        description="Let sandboxed threads use the Docker socket. Docker access is equivalent to full access to this machine."
        control={
          <Switch
            aria-label="Allow Docker in the sandbox"
            checked={saved.allowDocker}
            onCheckedChange={(checked) => save({ allowDocker: Boolean(checked) })}
          />
        }
      />
      <SettingsRow
        {...searchableSetting("sandbox-ssh-agent")}
        serverScoped
        settingKeys={["sandbox"]}
        description="Let sandboxed threads reach your ssh-agent, which lets them use your SSH keys but not read them."
        control={
          <Switch
            aria-label="Allow the SSH agent in the sandbox"
            checked={saved.allowSshAgent}
            onCheckedChange={(checked) => save({ allowSshAgent: Boolean(checked) })}
          />
        }
      />
      <SettingsRow
        title="Commit signing"
        description={
          <>
            Commits fail in the sandbox when git signs with an SSH key file and no ssh-agent holding
            that key is visible to the server.{" "}
            <a
              href={COMMIT_SIGNING_DOCS_URL}
              target="_blank"
              rel="noreferrer"
              className="underline underline-offset-2 hover:text-foreground"
            >
              How to fix it
            </a>
          </>
        }
      />
    </SettingsSection>
  );
}

function ProjectSandboxForm(props: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  config: EnvironmentServerConfig;
}) {
  const { environmentId, projectId, config } = props;
  const entry = config.settings.projectSettingsOverrides[projectId];
  const additions: ProjectSandboxOverride = entry?.sandbox ?? {};
  const canWrite = useScopedSettingsWriteAllowed();
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: true });
  const save = (next: ProjectSandboxOverride) =>
    void updateSettings({
      environmentId,
      input: {
        patch: { projectSettingsOverrides: { [projectId]: withProjectSandbox(entry, next) } },
      },
    });
  const readWritePaths = additions.readWritePaths ?? [];
  const readOnlyPaths = additions.readOnlyPaths ?? [];
  const check = useSandboxPathCheck(environmentId, readWritePaths, readOnlyPaths);

  return (
    <SettingsSection id="sandbox" title="Sandboxed full access">
      {(["readWritePaths", "readOnlyPaths"] as const).map((key) => (
        <SandboxPathListRow
          key={key}
          {...(key === "readWritePaths" ? searchableSetting("sandbox-paths") : {})}
          title={LIST_COPY[key].title}
          description="Added to the environment's list for threads in this project."
          paths={key === "readWritePaths" ? readWritePaths : readOnlyPaths}
          rejected={forList(check.rejected, key)}
          warnings={forList(check.warnings, key)}
          disabled={!canWrite}
          managedBy={listManagedBy(config, key)}
          onChange={(paths) => save({ readWritePaths, readOnlyPaths, [key]: paths })}
          resetAction={null}
        />
      ))}
    </SettingsSection>
  );
}

function SandboxPathListRow(props: {
  id?: string;
  title: string;
  description: string;
  paths: SandboxPathList;
  rejected: ReadonlyArray<SandboxRejectedPath>;
  warnings: ReadonlyArray<SandboxRejectedPath>;
  disabled: boolean;
  managedBy: string | undefined;
  resetAction: ReactNode;
  onChange: (paths: SandboxPathList) => void;
}) {
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const disabled = props.disabled || props.managedBy !== undefined;
  const add = () => {
    const result = addSandboxPath(props.paths, draft);
    if ("error" in result) {
      setError(result.error);
      return;
    }
    setError(null);
    setDraft("");
    props.onChange(result.paths);
  };
  return (
    <SettingsRow
      {...(props.id === undefined ? {} : { id: props.id })}
      title={props.title}
      description={
        props.managedBy === undefined
          ? props.description
          : `${props.description} Managed by ${props.managedBy}.`
      }
      resetAction={props.resetAction}
    >
      <div className="mt-3 grid max-w-2xl gap-1.5 pb-3.5">
        {props.paths.length === 0 ? (
          <p className="text-muted-foreground text-xs">No paths.</p>
        ) : (
          <ul className="grid gap-1">
            {props.paths.map((path) => (
              <li key={path} className="flex min-w-0 items-center gap-2">
                <code className="min-w-0 flex-1 truncate font-mono text-xs">{path}</code>
                <Button
                  size="xs"
                  variant="ghost-muted"
                  disabled={disabled}
                  aria-label={`Remove ${path}`}
                  onClick={() => props.onChange(props.paths.filter((entry) => entry !== path))}
                >
                  Remove
                </Button>
              </li>
            ))}
          </ul>
        )}
        <form
          className="flex items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            add();
          }}
        >
          <div className="min-w-0 flex-1">
            <Input
              size="sm"
              font="mono"
              spellCheck={false}
              disabled={disabled}
              aria-label={`Add a ${props.title.toLowerCase()} path`}
              placeholder="~/path or /absolute/path"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
            />
          </div>
          <Button type="submit" size="sm" variant="outline" disabled={disabled}>
            Add
          </Button>
        </form>
        {error === null ? null : <p className="text-destructive-foreground text-xs">{error}</p>}
        {props.rejected.map((entry) => (
          <p key={`${entry.path}:${entry.reason}`} className="text-warning-foreground text-xs">
            Left out: <code className="font-mono">{entry.path}</code>. {entry.reason}
          </p>
        ))}
        {props.warnings.map((entry) => (
          <p key={`${entry.path}:${entry.reason}`} className="text-warning-foreground text-xs">
            <code className="font-mono">{entry.path}</code>: {entry.reason}
          </p>
        ))}
      </div>
    </SettingsRow>
  );
}

const forList = (entries: ReadonlyArray<SandboxRejectedPath>, key: SandboxListKey) =>
  entries.filter((entry) => entry.list === (key === "readWritePaths" ? "read-write" : "read-only"));

const NO_CHECK: SandboxPathCheckResult = { rejected: [], warnings: [] };

/** The listed paths the environment's sandbox would leave out or warn about, checked by its server. */
function useSandboxPathCheck(
  environmentId: EnvironmentId,
  readWritePaths: SandboxPathList,
  readOnlyPaths: SandboxPathList,
): SandboxPathCheckResult {
  const canCheck = useAtomValue(serverEnvironment.checkSandboxPaths.permissionAtom(environmentId));
  const checkSandboxPaths = useAtomCommand(serverEnvironment.checkSandboxPaths);
  const key = JSON.stringify([environmentId, readWritePaths, readOnlyPaths]);
  const [result, setResult] = useState<{
    readonly key: string;
    readonly check: SandboxPathCheckResult;
  } | null>(null);
  const requestCheck = useEffectEvent(async (requested: string) => {
    const response = await checkSandboxPaths({
      environmentId,
      input: { readWritePaths, readOnlyPaths },
    });
    if (response._tag === "Success") setResult({ key: requested, check: response.value });
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- asks the environment's server which listed paths its sandbox leaves out
  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect -- State changes only after the response arrives.
    if (canCheck) void requestCheck(key);
  }, [key, canCheck]);
  return result?.key === key ? result.check : NO_CHECK;
}
