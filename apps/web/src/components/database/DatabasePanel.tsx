import { useStableCallback } from "../../hooks/useStableCallback";
import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type {
  DatabaseConnection,
  EnvironmentId,
  ProjectId,
  ScopedThreadRef,
} from "@t3tools/contracts";
import { useContext, useEffect, useEffectEvent, useRef, useState } from "react";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import { RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY } from "../../rightPanelLayout";
import { useRightPanelStore } from "../../rightPanelStore";
import { databaseState } from "../../state/database";
import { Input } from "../ui/input";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { DatabaseConnectionDialog } from "./DatabaseConnectionDialog";
import { DatabaseExplorer } from "./DatabaseExplorer";
import { DatabaseToolbarButton } from "./DatabaseToolbarButton";
import { PlusIcon, RefreshCwIcon, SearchIcon, SquareTerminalIcon } from "lucide-react";
import { useDatabaseConnections } from "./databaseHooks";
import { databasePanelIntent, useDatabasePanelIntent } from "./databasePanelIntent";
import { persistDatabaseWorkspace } from "./databaseConsoleStorage";
import { newDatabaseConsole, openDatabaseTable } from "./databaseWorkspace";

/** The database explorer; consoles and tables it opens live in the bottom drawer. */
export default function DatabasePanel({
  environmentId,
  projectId,
  threadRef,
}: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  threadRef: ScopedThreadRef;
}) {
  const registry = useContext(RegistryContext);
  const key = scopedThreadKey(threadRef);
  const workspaceAtom = databaseState.workspaces(key);
  const { connections, error, loading, allowed } = useDatabaseConnections(environmentId, projectId);
  const canSave = useAtomValue(databaseState.saveConnection.permissionAtom(environmentId));
  const [editing, setEditing] = useState<DatabaseConnection | "new" | null>(null);
  const [filter, setFilter] = useState("");
  const findTable = useRef<HTMLInputElement>(null);
  const scope = { registry, environmentId, projectId, threadRef };
  const activeConnectionId = useAtomValue(
    workspaceAtom,
    (workspace) => workspace.tabs.find((tab) => tab.id === workspace.activeId)?.connectionId,
  );
  const selected =
    connections.find((connection) => connection.id === activeConnectionId) ?? connections[0];
  // In the sheet layout the explorer covers the bottom drawer the new tab opens in.
  const sheet = useMediaQuery(RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY);
  const revealDrawer = () => {
    if (sheet) useRightPanelStore.getState().close(threadRef);
  };
  useEffect(() => {
    persistDatabaseWorkspace(key, registry.get(workspaceAtom));
    return registry.subscribe(workspaceAtom, (next) => persistDatabaseWorkspace(key, next));
  }, [key, registry, workspaceAtom]);
  const newQuery = (connection: DatabaseConnection) => {
    databasePanelIntent.consume(threadRef);
    void newDatabaseConsole(scope, connection);
    revealDrawer();
  };
  const onNewQuery = useStableCallback(newQuery);
  const onOpenTable = useStableCallback(
    (connection: DatabaseConnection, schema: string, object: string) => {
      databasePanelIntent.consume(threadRef);
      openDatabaseTable(scope, connection, schema, object);
      revealDrawer();
    },
  );
  const intent = useDatabasePanelIntent((state) => state.byThread[key]);
  const handleQueryIntent = useEffectEvent(() => {
    if (selected) newQuery(selected);
  });
  const readyForQuery = selected !== undefined;
  useEffect(() => {
    if (intent === "query" && readyForQuery) handleQueryIntent();
  }, [intent, readyForQuery]);
  useEffect(() => {
    if (intent === "table") findTable.current?.focus();
  }, [intent]);
  const refresh = () => {
    registry.set(
      databaseState.revision(environmentId),
      registry.get(databaseState.revision(environmentId)) + 1,
    );
  };
  const newConsole =
    connections.length > 1 ? (
      <Menu>
        <MenuTrigger render={<DatabaseToolbarButton label="New query console" />}>
          <SquareTerminalIcon />
        </MenuTrigger>
        <MenuPopup align="end">
          {connections.map((connection) => (
            <MenuItem key={connection.id} onClick={() => newQuery(connection)}>
              <SquareTerminalIcon />
              {connection.name}
            </MenuItem>
          ))}
        </MenuPopup>
      </Menu>
    ) : (
      <DatabaseToolbarButton
        label="New query console"
        disabled={!selected}
        onClick={() => selected && newQuery(selected)}
      >
        <SquareTerminalIcon />
      </DatabaseToolbarButton>
    );
  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      {!allowed ? (
        <p className="p-3 text-sm">Database access requires terminal permission.</p>
      ) : (
        <aside className="flex min-h-0 min-w-0 flex-1 flex-col" aria-label="Connections">
          {error && (
            <p role="alert" className="border-b p-2 text-xs text-destructive-foreground">
              {error}
            </p>
          )}
          <div className="flex h-8 shrink-0 items-center gap-1 border-b px-2">
            <h2 className="mr-auto text-xs font-medium">Connections</h2>
            {newConsole}
            <DatabaseToolbarButton
              label="New connection"
              disabled={!canSave}
              onClick={() => setEditing("new")}
            >
              <PlusIcon />
            </DatabaseToolbarButton>
            <DatabaseToolbarButton label="Refresh schemas" onClick={refresh}>
              <RefreshCwIcon />
            </DatabaseToolbarButton>
          </div>
          <div className="flex shrink-0 items-center gap-1 border-b px-2 py-1">
            <SearchIcon className="size-3.5 shrink-0 text-muted-foreground" />
            <Input
              ref={findTable}
              size="compact"
              unstyled
              aria-label="Find table in loaded connections"
              placeholder="Find table…"
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape" && filter) {
                  event.stopPropagation();
                  setFilter("");
                }
              }}
            />
          </div>
          <DatabaseExplorer
            {...{ connections, environmentId, projectId, filter, loading }}
            onTable={onOpenTable}
            onQuery={onNewQuery}
            onEdit={setEditing}
          />
        </aside>
      )}
      {editing && (
        <DatabaseConnectionDialog
          environmentId={environmentId}
          projectId={projectId}
          {...(editing === "new" ? {} : { connection: editing })}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}
