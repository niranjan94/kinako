import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { databaseCacheKey } from "@t3tools/client-runtime/state/database";
import type {
  DatabaseConnection,
  DatabaseObjectType,
  DatabaseIntrospectScope,
  EnvironmentId,
  ProjectId,
} from "@t3tools/contracts";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  Columns3Icon,
  DatabaseIcon,
  EyeIcon,
  FileKey2Icon,
  FolderIcon,
  KeyRoundIcon,
  LinkIcon,
  MoreHorizontalIcon,
  Settings2Icon,
  SquareTerminalIcon,
  Table2Icon,
} from "lucide-react";
import { memo, useContext, useEffect, useMemo, useRef, useState } from "react";
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
  level,
  objectType = "table",
  filter,
  onTable,
}: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  connection: DatabaseConnection;
  scope: DatabaseIntrospectScope;
  label: string;
  level: number;
  objectType?: DatabaseObjectType;
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
  const Icon =
    kind === "schemas"
      ? DatabaseIcon
      : kind === "objects"
        ? FolderIcon
        : objectType === "table"
          ? Table2Icon
          : EyeIcon;
  const description =
    kind === "schemas"
      ? `${connection.name} · ${connection.target.engine === "sqlite" ? "SQLite" : "PostgreSQL"}${connection.readOnly ? " · Read-only" : ""}`
      : kind === "columns" && objectType !== "table"
        ? `${label} · ${objectType === "view" ? "View" : "Materialized view"}`
        : label;
  return (
    <div className="min-w-0" role="none">
      <DatabaseHint label={description}>
        <button
          data-database-tree-row
          role="treeitem"
          aria-expanded={open}
          aria-level={level}
          tabIndex={-1}
          className="flex h-7 w-full min-w-0 items-center gap-1.5 rounded-sm px-1 text-left text-xs outline-none hover:bg-accent focus:bg-accent focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
          aria-label={label}
          aria-description={
            kind === "columns" ? `${description}. Press Enter to open its rows.` : description
          }
          onClick={() => setExpanded(!open)}
          onDoubleClick={() => {
            if (scope.kind === "columns") onTable(connection, scope.schema, scope.object);
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
              if (open) setExpanded(false);
              else
                event.currentTarget.parentElement
                  ?.closest<HTMLElement>("[role=group]")
                  ?.parentElement?.querySelector<HTMLElement>("[data-database-tree-row]")
                  ?.focus();
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
                level={level + 1}
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
                  level={level + 1}
                  objectType={object.type}
                />
              ))
          ) : metadata.kind === "columns" ? (
            <>
              <div
                className="flex h-7 items-center gap-1.5 text-xs text-muted-foreground"
                aria-hidden
              >
                <Columns3Icon className="size-3.5" />
                Columns <span className="text-2xs">{metadata.columns.length}</span>
              </div>
              <div className="ml-4" role="none">
                {metadata.columns.map((column) => {
                  const ColumnIcon = column.primaryKey
                    ? KeyRoundIcon
                    : column.references
                      ? LinkIcon
                      : Columns3Icon;
                  return (
                    <div
                      key={column.name}
                      data-database-tree-row
                      role="treeitem"
                      aria-level={level + 1}
                      tabIndex={-1}
                      className="flex h-6 min-w-0 items-center gap-1.5 rounded-sm text-xs outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
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

const LEVEL_LABELS = {
  project: "This project",
  environment: "This environment",
  global: "All environments",
} as const;

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
  const tree = useRef<HTMLDivElement>(null);
  // Roving tabindex: the tree is one tab stop, landing on the last focused row.
  useEffect(() => {
    const rows = tree.current?.querySelectorAll<HTMLElement>("[data-database-tree-row]");
    if (rows?.length && ![...rows].some((row) => row.tabIndex === 0)) rows[0]!.tabIndex = 0;
  });
  return (
    <div
      className="min-h-0 flex-1 overflow-auto px-1 py-2"
      ref={tree}
      role="tree"
      aria-label="Database explorer"
      onFocus={(event) => {
        if (!event.target.matches("[data-database-tree-row]")) return;
        for (const row of event.currentTarget.querySelectorAll<HTMLElement>(
          "[data-database-tree-row]",
        ))
          row.tabIndex = row === event.target ? 0 : -1;
      }}
      onKeyDown={(event) => {
        if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
        const items = [
          ...event.currentTarget.querySelectorAll<HTMLElement>("[data-database-tree-row]"),
        ];
        const index = items.indexOf(document.activeElement as HTMLElement);
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
          <section key={level} className="mb-3" role="group" aria-label={LEVEL_LABELS[level]}>
            <h3 className="px-2 pb-1 text-2xs font-medium text-muted-foreground" aria-hidden>
              {LEVEL_LABELS[level]}
            </h3>
            {items.map((connection) => (
              <div key={connection.id} role="none">
                <div className="flex items-start" role="none">
                  <div className="min-w-0 flex-1" role="none">
                    <DatabaseNode
                      {...{ environmentId, projectId, connection, onTable }}
                      level={1}
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
