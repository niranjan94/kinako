import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { AuthOrchestrationOperateScope, type ScopedProjectRef } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { useId, useState } from "react";

import { appAtomRegistry } from "~/rpc/atomRegistry";
import { getLocalFileManagerName, isWindowsPlatform } from "../lib/utils";
import { readLocalApi } from "../localApi";
import { useEnvironments, usePrimaryEnvironmentId } from "../state/environments";
import { useProject } from "../state/entities";
import { projectEnvironment } from "../state/projects";
import { useEnvironmentScope } from "../state/session";
import { useOrchestrationCommand } from "../state/use-orchestration-command";
import { hasUnsavedProjectFilesUnder } from "./files/projectFilesQueryState";
import { Alert, AlertDescription } from "./ui/alert";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { toastManager } from "./ui/toast";

/**
 * The project whose path is being changed. Entry points set it and the app shell renders the
 * dialog once, so it outlives the menu or palette that opened it.
 */
const projectPathDialogAtom = Atom.make<ScopedProjectRef | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("projects:path-dialog-project"),
);

export function openProjectPathDialog(projectRef: ScopedProjectRef): void {
  appAtomRegistry.set(projectPathDialogAtom, projectRef);
}

function closeProjectPathDialog(): void {
  appAtomRegistry.set(projectPathDialogAtom, null);
}

export function ProjectPathDialogHost() {
  const projectRef = useAtomValue(projectPathDialogAtom);
  if (projectRef === null) return null;
  return (
    <ProjectPathDialog
      key={`${projectRef.environmentId}:${projectRef.projectId}`}
      projectRef={projectRef}
    />
  );
}

function ProjectPathDialog(props: { readonly projectRef: ScopedProjectRef }) {
  const { environmentId } = props.projectRef;
  const id = useId();
  const project = useProject(props.projectRef);
  const { environments } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const canChange = useEnvironmentScope(environmentId, AuthOrchestrationOperateScope);
  const updateProject = useOrchestrationCommand(projectEnvironment.update, {
    reportFailure: false,
  });
  const [path, setPath] = useState(project?.workspaceRoot ?? "");
  const [error, setError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [isPicking, setIsPicking] = useState(false);

  if (project === null) return null;
  const trimmed = path.trim();
  const hasUnsavedEdits = hasUnsavedProjectFilesUnder(environmentId, project.workspaceRoot);
  const environment = environments.find((candidate) => candidate.environmentId === environmentId);
  const clientPlatform = typeof navigator === "undefined" ? "" : navigator.platform;
  // The native dialog browses this machine, so only offer it when this machine
  // is the environment and its filesystem is the one the dialog would show.
  const canPickNative =
    environmentId === primaryEnvironmentId &&
    typeof window !== "undefined" &&
    window.desktopBridge !== undefined &&
    isWindowsPlatform(clientPlatform) ===
      (environment?.serverConfig?.environment.platform.os === "windows");

  const submit = async () => {
    if (trimmed === "" || trimmed === project.workspaceRoot) {
      closeProjectPathDialog();
      return;
    }
    setIsSaving(true);
    setError(null);
    const result = await updateProject({
      environmentId,
      input: { projectId: project.id, workspaceRoot: trimmed },
    });
    setIsSaving(false);
    if (result._tag === "Success") {
      closeProjectPathDialog();
      toastManager.add({
        type: "success",
        title: "Project path changed",
        description: result.value.workspaceRoot,
      });
      return;
    }
    if (isAtomCommandInterrupted(result)) return;
    const failure = squashAtomCommandFailure(result);
    setError(failure instanceof Error ? failure.message : "The project path could not be changed.");
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) closeProjectPathDialog();
      }}
    >
      <DialogPopup className="max-w-lg">
        <form
          className="flex min-h-0 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <DialogHeader>
            <DialogTitle>Change project path</DialogTitle>
            <DialogDescription>
              Point {project.title} at the folder it now lives in. Threads and their history stay
              with the project. Nothing is moved on disk.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`${id}-path`}>Folder on the machine running the server</Label>
              <div className="flex items-center gap-2">
                <Input
                  id={`${id}-path`}
                  autoFocus
                  disabled={!canChange || isSaving}
                  value={path}
                  onChange={(event) => {
                    setPath(event.target.value);
                    setError(null);
                  }}
                />
                {canPickNative ? (
                  <Button
                    type="button"
                    variant="outline"
                    disabled={!canChange || isSaving || isPicking}
                    onClick={() => {
                      setIsPicking(true);
                      void readLocalApi()
                        ?.dialogs.pickFolder({ initialPath: trimmed || project.workspaceRoot })
                        .then((picked) => {
                          if (picked) setPath(picked);
                        })
                        .finally(() => setIsPicking(false));
                    }}
                  >
                    {`Open in ${getLocalFileManagerName(clientPlatform)}`}
                  </Button>
                ) : null}
              </div>
            </div>
            <p className="text-xs text-muted-foreground">
              Stop running turns first. Worktrees linked to the project are repaired automatically
              when git allows it.
            </p>
            {hasUnsavedEdits ? (
              <Alert variant="warning">
                <AlertDescription>
                  Save or discard open file edits in this project before changing its path.
                </AlertDescription>
              </Alert>
            ) : null}
            {error !== null ? (
              <Alert variant="error">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            ) : null}
            {!canChange ? (
              <p className="text-xs text-muted-foreground">
                This connection cannot change projects.
              </p>
            ) : null}
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={closeProjectPathDialog}>
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={
                !canChange ||
                isSaving ||
                hasUnsavedEdits ||
                trimmed === "" ||
                trimmed === project.workspaceRoot
              }
            >
              Change path
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
