import type { EnvironmentId, ProjectAdditionalDirectory, ThreadEnvMode } from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { lazy, Suspense, useState } from "react";

import { ADDITIONAL_DIRECTORIES_CAVEAT, directoryName } from "../../lib/additionalDirectories";
import type { SidebarProjectGroupMember } from "../../sidebarProjectGrouping";
import { projectEnvironment } from "../../state/projects";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { resolveEnvModeLabel } from "../BranchToolbar.logic";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { toastManager } from "../ui/toast";
import { SettingsRow, SettingsSection } from "./settingsLayout";

/** Each checkout keeps its own list: the folders are paths on that checkout's environment. */
const AdditionalDirectoryPickerDialog = lazy(() =>
  import("../AdditionalDirectoryPickerDialog").then((module) => ({
    default: module.AdditionalDirectoryPickerDialog,
  })),
);

export function ProjectAdditionalDirectoriesSettings(props: {
  readonly members: ReadonlyArray<SidebarProjectGroupMember>;
  readonly editableEnvironmentIds: ReadonlySet<EnvironmentId>;
}) {
  const [pickerMember, setPickerMember] = useState<SidebarProjectGroupMember | null>(null);
  const updateProject = useOrchestrationCommand(projectEnvironment.update, {
    reportFailure: false,
  });
  const showEnvironment = props.members.length > 1;

  const save = async (
    member: SidebarProjectGroupMember,
    additionalDirectories: ReadonlyArray<ProjectAdditionalDirectory>,
  ) => {
    const result = await updateProject({
      environmentId: member.environmentId,
      input: { projectId: member.id, additionalDirectories },
    });
    if (result._tag !== "Failure" || isAtomCommandInterrupted(result)) return;
    const error = squashAtomCommandFailure(result);
    toastManager.add({
      type: "error",
      title: "Could not update additional directories",
      description: error instanceof Error ? error.message : "An error occurred.",
    });
  };

  return (
    <SettingsSection title="Additional directories">
      {props.members.flatMap((member) => {
        const directories = member.additionalDirectories ?? [];
        const editable = props.editableEnvironmentIds.has(member.environmentId);
        const prefix = showEnvironment ? `${member.environmentLabel ?? "Environment"} · ` : "";
        return [
          ...directories.map((directory, index) => (
            <SettingsRow
              key={`${member.physicalProjectKey}:${directory.path}`}
              title={directoryName(directory.path)}
              description={`${prefix}${directory.path}`}
              control={
                <div className="flex items-center gap-2">
                  <Select
                    value={directory.mode}
                    disabled={!editable}
                    onValueChange={(mode: ThreadEnvMode | null) => {
                      if (mode !== "local" && mode !== "worktree") return;
                      void save(
                        member,
                        directories.map((entry, entryIndex) =>
                          entryIndex === index ? { ...entry, mode } : entry,
                        ),
                      );
                    }}
                  >
                    <SelectTrigger
                      size="sm"
                      aria-label={`How threads use ${directoryName(directory.path)}`}
                    >
                      <SelectValue>
                        {(value: ThreadEnvMode | null) => resolveEnvModeLabel(value ?? "local")}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectPopup align="end" alignItemWithTrigger={false}>
                      <SelectItem value="local">{resolveEnvModeLabel("local")}</SelectItem>
                      <SelectItem value="worktree">{resolveEnvModeLabel("worktree")}</SelectItem>
                    </SelectPopup>
                  </Select>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={!editable}
                    aria-label={`Remove ${directory.path}`}
                    onClick={() =>
                      void save(
                        member,
                        directories.filter((_, entryIndex) => entryIndex !== index),
                      )
                    }
                  >
                    Remove
                  </Button>
                </div>
              }
            />
          )),
          <SettingsRow
            key={`${member.physicalProjectKey}:add`}
            title={
              showEnvironment
                ? `Add to ${member.environmentLabel ?? "this checkout"}`
                : "Add a directory"
            }
            description={`Folders threads in this project can also read and edit, such as a sibling repository. ${ADDITIONAL_DIRECTORIES_CAVEAT}`}
            control={
              <Button
                size="sm"
                variant="outline"
                disabled={!editable}
                onClick={() => setPickerMember(member)}
              >
                Add…
              </Button>
            }
          />,
        ];
      })}
      {pickerMember !== null ? (
        <Suspense fallback={null}>
          <AdditionalDirectoryPickerDialog
            open
            onOpenChange={(open) => {
              if (!open) setPickerMember(null);
            }}
            environmentId={pickerMember.environmentId}
            startPath={pickerMember.workspaceRoot}
            excludedPaths={[
              pickerMember.workspaceRoot,
              ...(pickerMember.additionalDirectories ?? []).map((directory) => directory.path),
            ]}
            onSelect={(path) =>
              void save(pickerMember, [
                ...(pickerMember.additionalDirectories ?? []),
                { path, mode: "local" },
              ])
            }
          />
        </Suspense>
      ) : null}
    </SettingsSection>
  );
}
