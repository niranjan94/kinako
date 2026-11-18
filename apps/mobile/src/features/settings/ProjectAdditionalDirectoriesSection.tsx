import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import type { ProjectAdditionalDirectory } from "@t3tools/contracts";
import { msg, T, useGT, useMessages } from "gt-react-native";
import { useMemo, useState } from "react";
import { Pressable, View } from "react-native";

import { AppText as Text, AppTextInput } from "../../components/ui/AppText";
import { useProjects, useThreadShells } from "../../state/entities";
import { projectEnvironment } from "../../state/projects";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsSection } from "./components/SettingsSection";
import type { SettingsTarget } from "./settings-environment-filter";

const MODE_LABELS = { local: msg("Current checkout"), worktree: msg("New worktree") } as const;
const SUGGESTION_LIMIT = 5;

function directoryName(path: string): string {
  return path.split(/[/\\]/).findLast(Boolean) ?? path;
}

/** Each checkout keeps its own list: the folders are paths on that checkout's environment. */
export function ProjectAdditionalDirectoriesSection(props: {
  readonly members: readonly EnvironmentProject[];
  readonly environments: readonly SettingsTarget[];
}) {
  const gt = useGT();
  return (
    <SettingsSection title={gt("Additional directories")}>
      <Text className="px-4 pt-4 text-sm leading-normal text-foreground-muted">
        <T>
          Folders threads in this project can also read and edit. Edits there are not checkpointed,
          shown in diffs, or undone by rollback, and git actions stay on this project.
        </T>
      </Text>
      {props.members.map((member) => (
        <MemberDirectories
          key={`${member.environmentId}:${member.id}`}
          member={member}
          label={
            props.members.length > 1
              ? (props.environments.find((entry) => entry.environmentId === member.environmentId)
                  ?.label ?? gt("Environment"))
              : null
          }
        />
      ))}
    </SettingsSection>
  );
}

function MemberDirectories(props: {
  readonly member: EnvironmentProject;
  readonly label: string | null;
}) {
  const { member } = props;
  const gt = useGT();
  const resolve = useMessages();
  const directories = member.additionalDirectories ?? [];
  const [draftPath, setDraftPath] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const projects = useProjects();
  const threads = useThreadShells();
  const updateProject = useAtomCommand(projectEnvironment.update, {
    label: "additional directories update",
    reportFailure: true,
  });

  const suggestions = useMemo(() => {
    const used = new Set([member.workspaceRoot, ...directories.map((entry) => entry.path)]);
    const lastActivity = new Map<string, string>();
    for (const thread of threads) {
      if (thread.environmentId !== member.environmentId) continue;
      const previous = lastActivity.get(thread.projectId);
      if (previous === undefined || thread.updatedAt > previous)
        lastActivity.set(thread.projectId, thread.updatedAt);
    }
    // .sort() on a copy, not .toSorted(): Hermes doesn't ship the ES2023 method.
    return projects
      .filter(
        (project) =>
          project.environmentId === member.environmentId &&
          project.isScratch !== true &&
          !used.has(project.workspaceRoot),
      )
      .sort(
        (left, right) =>
          (lastActivity.get(right.id) ?? right.updatedAt).localeCompare(
            lastActivity.get(left.id) ?? left.updatedAt,
          ) || left.title.localeCompare(right.title),
      )
      .slice(0, SUGGESTION_LIMIT);
  }, [directories, member.environmentId, member.workspaceRoot, projects, threads]);

  const save = (next: ReadonlyArray<ProjectAdditionalDirectory>, onSaved?: () => void) => {
    setIsSaving(true);
    void updateProject({
      environmentId: member.environmentId,
      input: { projectId: member.id, additionalDirectories: next },
    })
      .then((result) => {
        if (result._tag !== "Failure") onSaved?.();
      })
      .finally(() => setIsSaving(false));
  };
  const add = (path: string, onSaved?: () => void) =>
    save([...directories, { path, mode: "local" }], onSaved);
  const trimmedPath = draftPath.trim();

  return (
    <View className="gap-3 border-t border-border-subtle p-4">
      {props.label ? (
        <Text className="text-base font-t3-medium text-foreground">{props.label}</Text>
      ) : null}
      {directories.map((directory, index) => (
        <View key={directory.path} className="flex-row items-center gap-3">
          <View className="min-w-0 flex-1">
            <Text className="text-base text-foreground" numberOfLines={1}>
              {directoryName(directory.path)}
            </Text>
            <Text className="text-sm text-foreground-muted" numberOfLines={1} selectable>
              {directory.path}
            </Text>
          </View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={gt("Use {name} as {mode}", {
              name: directoryName(directory.path),
              mode: resolve(directory.mode === "local" ? MODE_LABELS.worktree : MODE_LABELS.local),
            })}
            disabled={isSaving}
            onPress={() =>
              save(
                directories.map((entry, entryIndex) =>
                  entryIndex === index
                    ? { ...entry, mode: entry.mode === "local" ? "worktree" : "local" }
                    : entry,
                ),
              )
            }
            className="rounded-full bg-subtle-strong px-3 py-1.5 active:opacity-70"
          >
            <Text className="text-sm text-foreground">{resolve(MODE_LABELS[directory.mode])}</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={gt("Remove {path}", { path: directory.path })}
            disabled={isSaving}
            onPress={() => save(directories.filter((_, entryIndex) => entryIndex !== index))}
            className="px-1 py-1.5 active:opacity-70"
          >
            <Text className="text-sm text-destructive">{gt("Remove")}</Text>
          </Pressable>
        </View>
      ))}
      <View className="flex-row items-center gap-3">
        <AppTextInput
          accessibilityLabel={gt("Folder path")}
          className="min-h-11 min-w-0 flex-1 rounded-xl border-continuous bg-card px-3 text-base text-foreground"
          placeholder="/path/to/folder"
          autoCapitalize="none"
          autoCorrect={false}
          value={draftPath}
          onChangeText={setDraftPath}
          onSubmitEditing={() => {
            if (trimmedPath) add(trimmedPath, () => setDraftPath(""));
          }}
          returnKeyType="done"
          editable={!isSaving}
        />
        {trimmedPath ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={gt("Add folder")}
            disabled={isSaving}
            onPress={() => add(trimmedPath, () => setDraftPath(""))}
            className="rounded-full bg-subtle-strong px-4 py-2 active:opacity-70"
          >
            <Text className="text-sm font-t3-medium text-foreground">{gt("Add")}</Text>
          </Pressable>
        ) : null}
      </View>
      {suggestions.length > 0 ? (
        <View className="gap-2">
          <Text className="text-sm font-t3-medium text-foreground-muted">{gt("Projects")}</Text>
          {suggestions.map((project) => (
            <Pressable
              key={project.id}
              accessibilityRole="button"
              accessibilityLabel={gt("Add {name}", { name: project.title })}
              disabled={isSaving}
              onPress={() => add(project.workspaceRoot)}
              className="active:opacity-70"
            >
              <Text className="text-base text-foreground" numberOfLines={1}>
                {project.title}
              </Text>
              <Text className="text-sm text-foreground-muted" numberOfLines={1}>
                {project.workspaceRoot}
              </Text>
            </Pressable>
          ))}
        </View>
      ) : null}
    </View>
  );
}
