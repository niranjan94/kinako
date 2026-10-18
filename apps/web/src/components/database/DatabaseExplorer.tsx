import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { databaseCacheKey } from "@t3tools/client-runtime/state/database";
import type {
  DatabaseConnection,
  DatabaseIntrospectScope,
  EnvironmentId,
  ProjectId,
} from "@t3tools/contracts";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  Columns3Icon,
  DatabaseIcon,
  FileKey2Icon,
  FolderIcon,
  KeyRoundIcon,
  LinkIcon,
  MoreHorizontalIcon,
  Settings2Icon,
  SquareTerminalIcon,
  Table2Icon,
} from "lucide-react";
import { memo, useContext, useEffect, useMemo, useState } from "react";
import { databaseState } from "../../state/database";
import { Menu, MenuTrigger, MenuPopup, MenuItem } from "../ui/menu";
import { DatabaseToolbarButton, DatabaseHint } from "./DatabaseToolbarButton";
import { databaseErrorMessage, databaseValue } from "./databaseHooks";

function DatabaseNode({
  environmentId,
  projectId,
  connection,
  scope,
  label,
  filter,
  onTable,
}: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  connection: DatabaseConnection;
  scope: DatabaseIntrospectScope;
  label: string;
  filter: string;
  onTable: (connection: DatabaseConnection, schema: string, object: string) => void;
}) {
  const registry = useContext(RegistryContext);
  const revision = useAtomValue(databaseState.revision(environmentId));
  const kind = scope.kind;
  const schema = scope.kind === "schemas" ? "" : scope.schema;
  const object = scope.kind === "columns" ? scope.object : "";
  const input = useMemo(
    () => ({
      connectionId: connection.id,
      projectId,
      scope:
        kind === "schemas"
          ? { kind }
          : kind === "objects"
            ? { kind, schema }
            : { kind, schema, object },
    }),
    [connection.id, projectId, kind, schema, object],
  );
  const metadata = useAtomValue(
    databaseState.metadata(databaseCacheKey(environmentId, { ...input, revision })),
  );
  const [expanded, setExpanded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Filtering searches the schemas of connections already loaded; it never opens a new connection.
  const open =
    expanded || (!!filter && (kind === "objects" || (kind === "schemas" && metadata !== null)));
  useEffect(() => {
    if (!open || metadata) return;
    let active = true;
    void databaseState.introspect.run(registry, { environmentId, input }).then((result) => {
      try {
        databaseValue(result);
        if (active) setError(null);
      } catch (error) {
        if (active) setError(databaseErrorMessage(error));
      }
    });
    return () => {
      active = false;
    };
  }, [open, metadata, environmentId, input, registry]);
  const Icon = kind === "schemas" ? DatabaseIcon : kind === "objects" ? FolderIcon : Table2Icon;
  return (
    <div className="min-w-0" role="treeitem" aria-expanded={open} aria-label={label}>
      <DatabaseHint
        label={
          kind === "schemas"
            ? `${connection.name} · ${connection.target.engine} · ${connection.level}${connection.readOnly ? " · Read-only" : ""}`
            : label
        }
      >
        <button
          data-database-tree-row
          className="flex h-7 w-full min-w-0 items-center gap-1.5 rounded-sm px-1 text-left text-xs outline-none hover:bg-accent focus:bg-accent focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
          aria-label={kind === "columns" ? `Table ${label}` : label}
          aria-description={
            kind === "schemas"
              ? `${connection.name} · ${connection.target.engine} · ${connection.level}${connection.readOnly ? " · Read-only" : ""}`
              : label
          }
          onClick={() => setExpanded(!open)}
          onDoubleClick={() => {
            if (scope.kind === "columns") {
              setExpanded(true);
              onTable(connection, scope.schema, scope.object);
            }
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" && scope.kind === "columns") {
              event.preventDefault();
              onTable(connection, scope.schema, scope.object);
            } else if (event.key === "ArrowRight") {
              event.preventDefault();
              setExpanded(true);
            } else if (event.key === "ArrowLeft") {
              event.preventDefault();
              setExpanded(false);
            }
          }}
        >
          {open ? (
            <ChevronDownIcon className="size-3 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronRightIcon className="size-3 shrink-0 text-muted-foreground" />
          )}
          <Icon
            className={`size-3.5 shrink-0 ${kind === "schemas" ? "text-primary" : "text-muted-foreground"}`}
          />
          <span className="truncate">{label}</span>
          {kind === "schemas" && connection.readOnly && (
            <FileKey2Icon className="ml-auto size-3 shrink-0 text-muted-foreground" />
          )}
        </button>
      </DatabaseHint>
      {open && (
        <div className="ml-4" role="group">
          {error && !metadata ? (
            <p role="alert" className="break-words px-2 py-1 text-xs text-destructive-foreground">
              {error}
            </p>
          ) : !metadata ? (
            <p className="px-2 py-1 text-xs text-muted-foreground">Loading…</p>
          ) : metadata.kind === "schemas" ? (
            metadata.schemas.map((schema) => (
              <DatabaseNode
                key={schema.name}
                {...{ environmentId, projectId, connection, onTable, filter }}
                scope={{ kind: "objects", schema: schema.name }}
                label={schema.name}
              />
            ))
          ) : metadata.kind === "objects" && scope.kind === "objects" ? (
            metadata.objects
              .filter(
                (object) =>
                  !filter ||
                  object.name.toLowerCase().includes(filter) ||
                  connection.name.toLowerCase().includes(filter),
              )
              .map((object) => (
                <DatabaseNode
                  key={object.name}
                  {...{ environmentId, projectId, connection, onTable, filter }}
                  scope={{ kind: "columns", schema: scope.schema, object: object.name }}
                  label={object.name}
                />
              ))
          ) : metadata.kind === "columns" ? (
            <>
              <div className="flex h-7 items-center gap-1.5 text-xs text-muted-foreground">
                <Columns3Icon className="size-3.5" />
                Columns <span className="text-3xs">{metadata.columns.length}</span>
              </div>
              <div className="ml-4">
                {metadata.columns.map((column) => {
                  const ColumnIcon = column.primaryKey
                    ? KeyRoundIcon
                    : column.references
                      ? LinkIcon
                      : Columns3Icon;
                  return (
                    <div
                      key={column.name}
                      className="flex h-6 min-w-0 items-center gap-1.5 text-xs"
                      aria-description={`${column.name} ${column.dataType}${column.nullable ? "" : " NOT NULL"}${column.references ? ` → ${column.references.schema}.${column.references.object}.${column.references.column}` : ""}`}
                    >
                      <ColumnIcon
                        className={`size-3 shrink-0 ${column.primaryKey ? "text-warning-foreground" : column.references ? "text-primary" : "text-muted-foreground"}`}
                      />
                      <span className="shrink-0">{column.name}</span>
                      <span className="truncate text-2xs text-muted-foreground">
                        {column.dataType}
                      </span>
                    </div>
                  );
                })}
              </div>
            </>
          ) : null}
        </div>
      )}
    </div>
  );
}

export const DatabaseExplorer = memo(function DatabaseExplorer({
  connections,
  environmentId,
  projectId,
  filter,
  loading,
  onTable,
  onQuery,
  onEdit,
}: {
  connections: readonly DatabaseConnection[];
  loading: boolean;
  environmentId: EnvironmentId;
  projectId: ProjectId;
  filter: string;
  onTable: (connection: DatabaseConnection, schema: string, object: string) => void;
  onQuery: (connection: DatabaseConnection) => void;
  onEdit: (connection: DatabaseConnection) => void;
}) {
  const canEdit = useAtomValue(databaseState.saveConnection.permissionAtom(environmentId));
  return (
    <div
      className="min-h-0 flex-1 overflow-auto px-1 py-2"
      role="tree"
      aria-label="Database explorer"
      onKeyDown={(event) => {
        if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
        const items = [
          ...event.currentTarget.querySelectorAll<HTMLButtonElement>("[data-database-tree-row]"),
        ];
        const index = items.indexOf(document.activeElement as HTMLButtonElement);
        if (index < 0) return;
        event.preventDefault();
        const next =
          event.key === "Home"
            ? 0
            : event.key === "End"
              ? items.length - 1
              : Math.max(
                  0,
                  Math.min(items.length - 1, index + (event.key === "ArrowDown" ? 1 : -1)),
                );
        items[next]?.focus();
      }}
    >
      {(["project", "environment", "global"] as const).map((level) => {
        const items = connections.filter((connection) => connection.level === level);
        if (!items.length) return null;
        return (
          <section key={level} className="mb-3">
            <h3 className="px-2 pb-1 text-3xs font-medium tracking-wider text-muted-foreground uppercase">
              {level}
            </h3>
            {items.map((connection) => (
              <div key={connection.id}>
                <div className="flex items-start">
                  <div className="min-w-0 flex-1">
                    <DatabaseNode
                      {...{ environmentId, projectId, connection, onTable }}
                      scope={{ kind: "schemas" }}
                      filter={filter.toLowerCase()}
                      label={connection.name}
                    />
                  </div>
                  <Menu>
                    <MenuTrigger
                      render={<DatabaseToolbarButton label={`Actions for ${connection.name}`} />}
                    >
                      <MoreHorizontalIcon />
                    </MenuTrigger>
                    <MenuPopup align="end">
                      <MenuItem onClick={() => onQuery(connection)}>
                        <SquareTerminalIcon />
                        New query console
                      </MenuItem>
                      <MenuItem disabled={!canEdit} onClick={() => onEdit(connection)}>
                        <Settings2Icon />
                        Connection properties
                      </MenuItem>
                    </MenuPopup>
                  </Menu>
                </div>
              </div>
            ))}
          </section>
        );
      })}
      {!connections.length && (
        <p className="px-3 py-2 text-xs text-muted-foreground">
          {loading ? "Loading connections…" : "Add a connection to browse its schemas and tables."}
        </p>
      )}
    </div>
  );
});
