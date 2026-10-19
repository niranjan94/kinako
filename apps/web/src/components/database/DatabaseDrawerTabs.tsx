import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ProjectId, ScopedThreadRef } from "@t3tools/contracts";
import { SquareTerminalIcon, Table2Icon, TerminalSquareIcon, XIcon } from "lucide-react";
import { useContext, useEffect, type ReactNode } from "react";
import { databaseState } from "../../state/database";
import { DatabaseConsoleView } from "./DatabaseConsoleView";
import { persistDatabaseWorkspace } from "./databaseConsoleStorage";
import { DatabaseTableView } from "./DatabaseTableView";
import { DatabaseHint, DatabaseToolbarButton } from "./DatabaseToolbarButton";
import { closeDatabaseTab, showDatabaseTab, shownDatabaseTabId } from "./databaseWorkspace";

// The nearest owner wins, so focus in database tabs does not enable terminal shortcuts.
const NOT_TERMINAL = "database";

function DrawerTab({
  active,
  icon,
  label,
  hint,
  onSelect,
  children,
}: {
  active: boolean;
  icon: ReactNode;
  label: string;
  hint?: string;
  onSelect: () => void;
  children?: ReactNode;
}) {
  const button = (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      className="flex h-full max-w-48 items-center gap-1.5 px-1.5 text-xs outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
      onClick={onSelect}
    >
      {icon}
      <span className="truncate">{label}</span>
    </button>
  );
  return (
    <div
      className={`relative flex shrink-0 items-center border-r pl-2 pr-1 ${active ? "bg-background after:absolute after:inset-x-0 after:bottom-0 after:h-px after:bg-primary" : "text-muted-foreground"}`}
    >
      {hint ? <DatabaseHint label={hint}>{button}</DatabaseHint> : button}
      {children}
    </div>
  );
}

export function DatabaseDrawerTabs({
  environmentId,
  projectId,
  threadRef,
}: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  threadRef: ScopedThreadRef;
}) {
  const registry = useContext(RegistryContext);
  const threadKey = scopedThreadKey(threadRef);
  const workspaceAtom = databaseState.workspaces(threadKey);
  const workspace = useAtomValue(workspaceAtom);
  const shownId = shownDatabaseTabId(workspace);
  useEffect(
    () => registry.subscribe(workspaceAtom, (next) => persistDatabaseWorkspace(threadKey, next)),
    [registry, threadKey, workspaceAtom],
  );
  const scope = { registry, environmentId, projectId, threadRef };
  return (
    <div
      role="tablist"
      aria-label="Bottom panel"
      data-terminal-owner={NOT_TERMINAL}
      className="relative flex h-8 shrink-0 overflow-x-auto bg-muted/20 before:absolute before:inset-x-0 before:bottom-0 before:h-px before:bg-border"
    >
      <DrawerTab
        active={shownId === null}
        icon={<TerminalSquareIcon className="size-3.5 shrink-0" />}
        label="Terminal"
        onSelect={() => showDatabaseTab(registry, threadRef, null)}
      />
      {workspace.tabs.map((tab) => (
        <DrawerTab
          key={tab.id}
          active={tab.id === shownId}
          icon={
            tab.table ? (
              <Table2Icon className="size-3.5 shrink-0" />
            ) : (
              <SquareTerminalIcon className="size-3.5 shrink-0" />
            )
          }
          label={tab.title}
          {...(!tab.table && tab.sql.trim() && tab.sql !== tab.savedSql
            ? { hint: `${tab.title} · Not saved to a file` }
            : {})}
          onSelect={() => showDatabaseTab(registry, threadRef, tab.id)}
        >
          <DatabaseToolbarButton
            label={`Close ${tab.title}`}
            onClick={() => void closeDatabaseTab(scope, tab)}
          >
            <XIcon />
          </DatabaseToolbarButton>
        </DrawerTab>
      ))}
    </div>
  );
}

export function DatabaseDrawerView({
  environmentId,
  projectId,
  threadRef,
  tabId,
  workspaceRoot,
}: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  threadRef: ScopedThreadRef;
  tabId: string;
  workspaceRoot: string;
}) {
  const threadKey = scopedThreadKey(threadRef);
  const isTable = useAtomValue(databaseState.workspaces(threadKey), (workspace) =>
    workspace.tabs.some((tab) => tab.id === tabId && tab.table !== undefined),
  );
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-terminal-owner={NOT_TERMINAL}>
      {isTable ? (
        <DatabaseTableView
          environmentId={environmentId}
          projectId={projectId}
          threadKey={threadKey}
          tabId={tabId}
        />
      ) : (
        <DatabaseConsoleView
          environmentId={environmentId}
          projectId={projectId}
          threadRef={threadRef}
          tabId={tabId}
          workspaceRoot={workspaceRoot}
        />
      )}
    </div>
  );
}
