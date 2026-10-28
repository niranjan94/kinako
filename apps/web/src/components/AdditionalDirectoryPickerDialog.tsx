import { useAtomValue } from "@effect/atom-react";
import { filterFilesystemBrowseEntries } from "@t3tools/client-runtime/state/filesystem";
import type { EnvironmentId } from "@t3tools/contracts";
import { FolderIcon, FolderSearchIcon } from "lucide-react";
import { useState } from "react";

import { useClientSettings } from "../hooks/useSettings";
import {
  appendBrowsePathSegment,
  getBrowseDirectoryPath,
  getBrowseLeafPathSegment,
  getBrowseParentPath,
} from "@t3tools/client-runtime/state/projects";
import { getLocalFileManagerName, isWindowsPlatform, normalizeSearchText } from "../lib/utils";
import { readLocalApi } from "../localApi";
import { useEnvironments, usePrimaryEnvironmentId } from "../state/environments";
import { useProjects, useThreadShells } from "../state/entities";
import { filesystemEnvironment, useFilesystemReadAccess } from "../state/filesystem";
import { useEnvironmentQuery } from "../state/query";
import { primaryServerKeybindingsAtom } from "../state/server";
import type { CommandPaletteActionItem, CommandPaletteGroup } from "./CommandPalette.logic";
import { CommandPaletteContent } from "./CommandPaletteContent";
import { CommandPaletteResults } from "./CommandPaletteResults";
import { ProjectFavicon } from "./ProjectFavicon";
import { sortProjectsForSidebar } from "./Sidebar.logic";
import { CommandDialog, CommandDialogPopup, CommandFooterAction } from "./ui/command";

const CHOOSE_FOLDER_VALUE = "additional-directory:choose-folder";
const BROWSE_VALUE_PREFIX = "additional-directory:browse:";

/**
 * Picks a folder on one environment for a project's additional directories:
 * that environment's other projects first, then any folder on its filesystem.
 * Both store a plain path; picking a project does not link to it.
 */
export function AdditionalDirectoryPickerDialog(props: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly environmentId: EnvironmentId;
  /** Where folder browsing starts, typically the primary project's root. */
  readonly startPath: string;
  /** Paths already in use (the primary root and existing directories). */
  readonly excludedPaths: ReadonlyArray<string>;
  readonly onSelect: (path: string) => void;
}) {
  return (
    <CommandDialog open={props.open} onOpenChange={props.onOpenChange}>
      {props.open ? <PickerContent {...props} /> : null}
    </CommandDialog>
  );
}

function PickerContent(props: Parameters<typeof AdditionalDirectoryPickerDialog>[0]) {
  const [browsing, setBrowsing] = useState(false);
  const [query, setQuery] = useState("");
  const [highlightedItemValue, setHighlightedItemValue] = useState<string | null>(null);
  const [isPickingNative, setIsPickingNative] = useState(false);
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const projectSortOrder = useClientSettings((settings) => settings.sidebarProjectSortOrder);
  const projects = useProjects();
  const threads = useThreadShells();
  const { environments } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const excluded = (() => new Set(props.excludedPaths))();

  const { onOpenChange, onSelect } = props;
  const select = (path: string) => {
    onOpenChange(false);
    onSelect(path);
  };

  const projectItems = ((): CommandPaletteActionItem[] => {
    const candidates = projects.filter(
      (project) =>
        project.environmentId === props.environmentId &&
        project.isScratch !== true &&
        !excluded.has(project.workspaceRoot),
    );
    const needle = normalizeSearchText(query);
    return sortProjectsForSidebar(
      candidates,
      threads.filter((thread) => thread.environmentId === props.environmentId),
      projectSortOrder,
    )
      .filter(
        (project) =>
          needle.length === 0 ||
          normalizeSearchText(`${project.title} ${project.workspaceRoot}`).includes(needle),
      )
      .map((project) => ({
        kind: "action",
        value: `additional-directory:project:${project.id}`,
        searchTerms: [project.title, project.workspaceRoot],
        title: project.title,
        description: project.workspaceRoot,
        icon: <ProjectFavicon project={project} className="size-4" />,
        run: async () => select(project.workspaceRoot),
      }));
  })();

  const browseAccess = useFilesystemReadAccess(props.environmentId);
  const directoryPath = browsing ? getBrowseDirectoryPath(query) : "";
  const browseQuery = useEnvironmentQuery(
    browsing && browseAccess.canReadFiles && directoryPath.length > 0
      ? filesystemEnvironment.browse({
          environmentId: props.environmentId,
          input: { partialPath: directoryPath },
        })
      : null,
  );
  const browseResult = browseQuery.data;
  const browseItems = ((): CommandPaletteActionItem[] => {
    if (!browsing || browseResult == null) return [];
    const { visibleEntries } = filterFilesystemBrowseEntries(
      browseResult.entries,
      getBrowseLeafPathSegment(query),
    );
    return visibleEntries.map((entry) => ({
      kind: "action",
      value: `${BROWSE_VALUE_PREFIX}${entry.fullPath}`,
      searchTerms: [entry.name],
      title: entry.name,
      description: entry.fullPath,
      icon: <FolderIcon />,
      keepOpen: true,
      run: async () => setQuery(appendBrowsePathSegment(query, entry.name)),
    }));
  })();

  const environment = environments.find(
    (candidate) => candidate.environmentId === props.environmentId,
  );
  const clientPlatform = typeof navigator === "undefined" ? "" : navigator.platform;
  // The native dialog browses this machine, so only offer it when this machine
  // is the environment and its filesystem is the one the dialog would show.
  const canPickNative =
    props.environmentId === primaryEnvironmentId &&
    typeof window !== "undefined" &&
    window.desktopBridge !== undefined &&
    isWindowsPlatform(clientPlatform) ===
      (environment?.serverConfig?.environment.platform.os === "windows");

  const startBrowsing = () => {
    setBrowsing(true);
    setHighlightedItemValue(null);
    setQuery(getBrowseParentPath(props.startPath) ?? props.startPath);
  };

  const groups: CommandPaletteGroup[] = browsing
    ? browseItems.length > 0
      ? [{ value: "additional-directory-folders", label: "Folders", items: browseItems }]
      : []
    : [
        ...(projectItems.length > 0
          ? [{ value: "additional-directory-projects", label: "Projects", items: projectItems }]
          : []),
        {
          value: "additional-directory-other",
          label: "Other",
          items: [
            {
              kind: "action",
              value: CHOOSE_FOLDER_VALUE,
              searchTerms: ["folder", "browse"],
              title: "Choose a folder…",
              icon: <FolderSearchIcon />,
              keepOpen: true,
              run: async () => startBrowsing(),
            },
          ],
        },
      ];

  const browsedFolder = browsing ? (browseResult?.parentPath ?? null) : null;
  const emptyStateMessage = browsing
    ? !browseAccess.canReadFiles && !browseAccess.isPending
      ? (browseAccess.error ?? "This connection cannot browse host folders.")
      : browseQuery.isPending
        ? "Loading folders…"
        : "No folders here."
    : "No matching projects.";

  return (
    <CommandDialogPopup
      aria-label="Add a directory"
      className="overflow-hidden"
      onBackdropPointerDown={() => props.onOpenChange(false)}
    >
      <CommandPaletteContent
        aria-label="Add a directory"
        autoHighlight="always"
        escapeLabel="Close"
        footerActionLabel={browsing ? "Open folder" : "Add"}
        footerTrailing={
          <>
            {browsedFolder !== null ? (
              <CommandFooterAction
                disabled={excluded.has(browsedFolder)}
                onClick={() => select(browsedFolder)}
              >
                Use this folder
              </CommandFooterAction>
            ) : null}
            {canPickNative ? (
              <CommandFooterAction
                disabled={isPickingNative}
                onClick={() => {
                  setIsPickingNative(true);
                  void readLocalApi()
                    ?.dialogs.pickFolder({ initialPath: props.startPath })
                    .then((path) => {
                      if (path) select(path);
                    })
                    .finally(() => setIsPickingNative(false));
                }}
              >
                {`Open in ${getLocalFileManagerName(clientPlatform)}`}
              </CommandFooterAction>
            ) : null}
          </>
        }
        inputProps={{ placeholder: browsing ? "Type a folder path…" : "Search projects…" }}
        mode="none"
        onItemHighlighted={(value) => {
          setHighlightedItemValue(typeof value === "string" ? value : null);
        }}
        onValueChange={(value) => {
          setHighlightedItemValue(null);
          setQuery(value);
        }}
        panelSize="tall-list"
        showBackHint={browsing}
        testId="additional-directory-picker"
        value={query}
      >
        <CommandPaletteResults
          groups={groups}
          highlightedItemValue={highlightedItemValue}
          isActionsOnly={false}
          keybindings={keybindings}
          onExecuteItem={(item) => {
            if (item.kind !== "action") return;
            void item.run();
          }}
          emptyStateMessage={emptyStateMessage}
        />
      </CommandPaletteContent>
    </CommandDialogPopup>
  );
}
