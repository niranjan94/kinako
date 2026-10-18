import { useDatabaseGlobalDeletes } from "../../state/databaseGlobalDeletes";
import { RegistryContext, useAtomValue } from "@effect/atom-react";
import {
  databaseCacheKey,
  databaseGlobalCoverage,
  fanOutDatabaseOperation,
} from "@t3tools/client-runtime/state/database";
import type { DatabaseConnection, EnvironmentId, ProjectId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { useContext, useState, type ReactNode } from "react";
import { databaseState } from "../../state/database";
import { useEnvironments } from "../../state/environments";
import { DatabaseConnectionDialog } from "../database/DatabaseConnectionDialog";
import { databaseValue, useDatabaseConnections } from "../database/databaseHooks";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { useSettingsScope } from "./SettingsScopeContext";
import { ensureLocalApi } from "../../localApi";

const connectionCopiesAtom = Atom.family((key: string) => {
  const { contexts, globalOnly } = JSON.parse(key) as {
    contexts: ReadonlyArray<{ environmentId: EnvironmentId; projectId?: ProjectId }>;
    globalOnly: boolean;
  };
  return Atom.make((get) =>
    contexts.flatMap(({ environmentId, projectId }) =>
      get(
        databaseState.connections(databaseCacheKey(environmentId, projectId ? { projectId } : {})),
      )
        .filter((connection) => !globalOnly || connection.level === "global")
        .map((connection) => ({ environmentId, connection })),
    ),
  );
});

function ConnectionLoader({
  environmentId,
  projectId,
  label,
}: {
  environmentId: EnvironmentId;
  projectId?: ProjectId;
  label: string;
}) {
  const { error, allowed } = useDatabaseConnections(environmentId, projectId);
  return error ? (
    <SettingsRow
      title={`Could not load connections on ${label}`}
      description={error}
      role="alert"
    />
  ) : !allowed ? (
    <SettingsRow
      title={`No database access on ${label}`}
      description="Database access requires terminal permission on this environment."
    />
  ) : null;
}

function ConnectionRow({
  connection,
  environmentId,
  status,
  onEdit,
  onDelete,
  children,
}: {
  connection: DatabaseConnection;
  environmentId: EnvironmentId;
  status: string;
  onEdit: () => void;
  onDelete: () => void;
  children?: ReactNode;
}) {
  const canEdit = useAtomValue(databaseState.saveConnection.permissionAtom(environmentId));
  return (
    <SettingsRow
      title={
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate">{connection.name}</span>
          {connection.readOnly && (
            <Badge size="sm" variant="outline">
              Read-only
            </Badge>
          )}
        </span>
      }
      description={
        <span className="font-mono">
          {connection.target.engine === "sqlite"
            ? connection.target.path
            : `${connection.target.user}@${connection.target.host}:${connection.target.port}/${connection.target.database}`}
        </span>
      }
      status={status}
      control={
        <>
          <Button size="sm" variant="outline" disabled={!canEdit} onClick={onEdit}>
            Edit
          </Button>
          <Button size="sm" variant="ghost" disabled={!canEdit} onClick={onDelete}>
            Delete
          </Button>
        </>
      }
    >
      {children}
    </SettingsRow>
  );
}

export function DatabaseSettings() {
  const registry = useContext(RegistryContext);
  const { scope, targets, connectedEnvironments, target } = useSettingsScope();
  const { environments } = useEnvironments();
  const ids = connectedEnvironments.map((item) => item.environmentId);
  const contexts = (() =>
    connectedEnvironments.map((environment) => ({
      environmentId: environment.environmentId,
      projectId:
        targets.find((item) => item.environmentId === environment.environmentId)?.projectId ??
        undefined,
    })))();
  const copies = useAtomValue(
    connectionCopiesAtom(JSON.stringify({ contexts, globalOnly: false })),
  );
  const globalEnvironments = (() =>
    environments.filter((item) => item.connection.phase === "connected"))();
  const globalCopies = useAtomValue(
    connectionCopiesAtom(
      JSON.stringify({
        contexts: globalEnvironments.map(({ environmentId }) => ({ environmentId })),
        globalOnly: true,
      }),
    ),
  );
  const coverage = databaseGlobalCoverage(
    globalCopies,
    environments.map((item) => item.environmentId),
  );
  const loaders = new Map(
    contexts.map((context) => [
      databaseCacheKey(
        context.environmentId,
        context.projectId ? { projectId: context.projectId } : {},
      ),
      context,
    ]),
  );
  for (const { environmentId } of globalEnvironments)
    loaders.set(databaseCacheKey(environmentId, {}), { environmentId, projectId: undefined });
  const [editing, setEditing] = useState<{
    environmentId: EnvironmentId;
    connection?: DatabaseConnection;
    copyTo?: EnvironmentId;
  } | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const deleted = useDatabaseGlobalDeletes((state) => state.pending);
  const initialLevel =
    scope.kind === "project" || scope.kind === "checkout" ? "project" : "environment";
  const environmentLabel = (id: EnvironmentId) =>
    environments.find((item) => item.environmentId === id)?.label ?? id;
  const initialEnvironment = target?.environmentId ?? ids[0];
  const remove = async (connection: DatabaseConnection, environmentId: EnvironmentId) => {
    const confirmed = await ensureLocalApi().dialogs.confirm(
      [
        `Delete ${connection.name}?`,
        connection.level === "global"
          ? "The connection is removed from every reachable environment. Offline environments keep their copy until you delete it here."
          : "Its stored password is removed too. Database contents are not affected.",
      ].join("\n"),
      { variant: "destructive" },
    );
    if (!confirmed) return;
    const destinations =
      connection.level === "global"
        ? environments
            .filter((item) => item.connection.phase === "connected")
            .map((item) => item.environmentId)
        : [environmentId];
    const results = await fanOutDatabaseOperation(destinations, async (id) =>
      databaseValue(
        await databaseState.deleteConnection.run(registry, {
          environmentId: id,
          input: { id: connection.id },
        }),
      ),
    );
    const failures = results.filter((item) => !item.ok);
    setMessage(
      failures.length
        ? `${failures.length} environment(s) could not delete this connection. Reconnect and delete the remaining copies.`
        : null,
    );
    if (connection.level === "global")
      useDatabaseGlobalDeletes.getState().remember(
        connection.id,
        environments
          .filter(
            (item) =>
              item.connection.phase !== "connected" ||
              results.some((result) => result.environmentId === item.environmentId && !result.ok),
          )
          .map((item) => item.environmentId),
      );
  };
  return (
    <SettingsPageContainer>
      <SettingsSection
        id="database-connections"
        title="Databases"
        headerAction={
          <Button
            size="xs"
            variant="outline"
            disabled={!initialEnvironment}
            onClick={() => initialEnvironment && setEditing({ environmentId: initialEnvironment })}
          >
            New connection
          </Button>
        }
      >
        {[...loaders].map(([key, { environmentId, projectId }]) => (
          <ConnectionLoader
            key={key}
            environmentId={environmentId}
            label={environmentLabel(environmentId)}
            {...(projectId ? { projectId } : {})}
          />
        ))}
        {message && <SettingsRow title="Some copies remain" description={message} role="status" />}
        {coverage.map((entry) => {
          const source = entry.copies.find(
            (copy) => copy.connection.updatedAt === entry.connection.updatedAt,
          )!;
          const stale = [...entry.missing, ...entry.older.map((copy) => copy.environmentId)];
          const orphaned = entry.copies.some((copy) =>
            deleted[entry.id]?.includes(copy.environmentId),
          );
          return (
            <ConnectionRow
              key={entry.id}
              connection={entry.connection}
              environmentId={source.environmentId}
              status={[
                `All environments · on ${entry.copies.length} of ${environments.length}`,
                entry.older.length ? `${entry.older.length} out of date` : "",
                orphaned ? "Deleted elsewhere; delete this copy here" : "",
              ]
                .filter(Boolean)
                .join(" · ")}
              onEdit={() =>
                setEditing({ environmentId: source.environmentId, connection: source.connection })
              }
              onDelete={() => void remove(entry.connection, source.environmentId)}
            >
              {stale.length > 0 && (
                <div className="flex flex-wrap gap-2 pb-2">
                  {stale.map((id) => (
                    <Button
                      key={id}
                      size="xs"
                      variant="outline"
                      disabled={
                        environments.find((item) => item.environmentId === id)?.connection.phase !==
                        "connected"
                      }
                      onClick={() =>
                        setEditing({
                          environmentId: source.environmentId,
                          connection: source.connection,
                          copyTo: id,
                        })
                      }
                    >
                      Copy to {environmentLabel(id)}
                    </Button>
                  ))}
                </div>
              )}
            </ConnectionRow>
          );
        })}
        {copies
          .filter((copy) => copy.connection.level !== "global")
          .map((copy) => (
            <ConnectionRow
              key={`${copy.environmentId}:${copy.connection.id}`}
              connection={copy.connection}
              environmentId={copy.environmentId}
              status={`${copy.connection.level === "project" ? "This project" : "Every project"} on ${environmentLabel(copy.environmentId)}`}
              onEdit={() => setEditing(copy)}
              onDelete={() => void remove(copy.connection, copy.environmentId)}
            />
          ))}
        {coverage.length === 0 && !copies.some((copy) => copy.connection.level !== "global") && (
          <SettingsRow
            title="No database connections"
            description="Add a PostgreSQL or SQLite connection to browse and query it from a thread's Databases panel. Connections open on the environment they are saved to."
          />
        )}
      </SettingsSection>
      {editing && (
        <DatabaseConnectionDialog
          key={`${editing.environmentId}:${editing.connection?.id ?? "new"}:${editing.copyTo ?? ""}`}
          {...editing}
          {...((editing.connection?.projectId ??
          contexts.find((item) => item.environmentId === editing.environmentId)?.projectId)
            ? {
                projectId:
                  editing.connection?.projectId ??
                  contexts.find((item) => item.environmentId === editing.environmentId)!.projectId!,
              }
            : {})}
          initialLevel={initialLevel}
          onClose={() => setEditing(null)}
        />
      )}
    </SettingsPageContainer>
  );
}
