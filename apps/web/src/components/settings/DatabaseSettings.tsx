import { useDatabaseGlobalDeletes } from "../../state/databaseGlobalDeletes";
import { RegistryContext, useAtomValue } from "@effect/atom-react";
import {
  databaseCacheKey,
  databaseGlobalCoverage,
  fanOutDatabaseOperation,
} from "@t3tools/client-runtime/state/database";
import type { DatabaseConnection, EnvironmentId, ProjectId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { useContext, useMemo, useState } from "react";
import { databaseState } from "../../state/database";
import { useEnvironments } from "../../state/environments";
import { DatabaseConnectionDialog } from "../database/DatabaseConnectionDialog";
import { databaseValue, useDatabaseConnections } from "../database/databaseHooks";
import { Button } from "../ui/button";
import { SettingsPageContainer, SettingsSection } from "./settingsLayout";
import { useSettingsScope } from "./SettingsScopeContext";
import { ensureLocalApi } from "../../localApi";

function ConnectionLoader({
  environmentId,
  projectId,
}: {
  environmentId: EnvironmentId;
  projectId?: ProjectId;
}) {
  const { error, allowed } = useDatabaseConnections(environmentId, projectId);
  return error ? (
    <p role="alert" className="text-sm">
      {error}
    </p>
  ) : !allowed ? (
    <p className="text-sm text-muted-foreground">
      Database access requires terminal permission on this environment.
    </p>
  ) : null;
}

function ConnectionRow({
  connection,
  environmentId,
  suffix,
  onEdit,
  onDelete,
}: {
  connection: DatabaseConnection;
  environmentId: EnvironmentId;
  suffix?: string;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const canEdit = useAtomValue(databaseState.saveConnection.permissionAtom(environmentId));
  return (
    <div className="flex items-center gap-3 border-b py-3">
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">
          {connection.name}{" "}
          {connection.readOnly && <span className="text-xs text-muted-foreground">Read-only</span>}
        </p>
        <p className="truncate text-xs text-muted-foreground">
          {connection.target.engine === "sqlite"
            ? connection.target.path
            : `${connection.target.user}@${connection.target.host}:${connection.target.port}/${connection.target.database}`}
          {suffix ? ` · ${suffix}` : ""}
        </p>
      </div>
      <Button size="sm" variant="outline" disabled={!canEdit} onClick={onEdit}>
        Edit
      </Button>
      <Button size="sm" variant="ghost" disabled={!canEdit} onClick={onDelete}>
        Delete
      </Button>
    </div>
  );
}

export function DatabaseSettings() {
  const registry = useContext(RegistryContext);
  const { scope, targets, connectedEnvironments, target } = useSettingsScope();
  const { environments } = useEnvironments();
  const ids = connectedEnvironments.map((item) => item.environmentId);
  const contexts = useMemo(
    () =>
      connectedEnvironments.map((environment) => ({
        environmentId: environment.environmentId,
        projectId:
          targets.find((item) => item.environmentId === environment.environmentId)?.projectId ??
          undefined,
      })),
    [connectedEnvironments, targets],
  );
  const copies = useAtomValue(
    useMemo(
      () =>
        Atom.make((get) =>
          contexts.flatMap(({ environmentId, projectId }) =>
            get(
              databaseState.connections(
                databaseCacheKey(environmentId, projectId ? { projectId } : {}),
              ),
            ).map((connection) => ({ environmentId, connection })),
          ),
        ),
      [contexts],
    ),
  );
  const globalEnvironments = useMemo(
    () => environments.filter((item) => item.connection.phase === "connected"),
    [environments],
  );
  const globalCopies = useAtomValue(
    useMemo(
      () =>
        Atom.make((get) =>
          globalEnvironments.flatMap(({ environmentId }) =>
            get(databaseState.connections(databaseCacheKey(environmentId, {})))
              .filter((connection) => connection.level === "global")
              .map((connection) => ({ environmentId, connection })),
          ),
        ),
      [globalEnvironments],
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
    scope.kind === "all"
      ? "global"
      : scope.kind === "project" || scope.kind === "checkout"
        ? "project"
        : "environment";
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
      <SettingsSection title="Databases">
        <p className="px-3 text-sm text-muted-foreground">
          Connect to Postgres and SQLite on your environments. Global connections are copied when
          you save; offline environments keep their previous copy.
        </p>
        <div className="flex items-center gap-2">
          <Button
            disabled={!initialEnvironment}
            onClick={() => initialEnvironment && setEditing({ environmentId: initialEnvironment })}
          >
            New connection
          </Button>
        </div>
        {[...loaders].map(([key, { environmentId, projectId }]) => (
          <ConnectionLoader
            key={key}
            environmentId={environmentId}
            {...(projectId ? { projectId } : {})}
          />
        ))}
        {message && (
          <p role="status" className="text-sm">
            {message}
          </p>
        )}
        <div id="database-connections" className="space-y-5">
          {(["global", "environment", "project"] as const).map((level) => (
            <section key={level} className="space-y-2">
              <h3 className="text-sm font-medium capitalize">{level}</h3>
              {level === "global"
                ? coverage.map((entry) => {
                    const source = entry.copies.find(
                      (copy) => copy.connection.updatedAt === entry.connection.updatedAt,
                    )!;
                    return (
                      <div key={entry.id}>
                        <ConnectionRow
                          connection={entry.connection}
                          environmentId={source.environmentId}
                          suffix={`on ${entry.copies.length} of ${environments.length} environments${entry.older.length ? ` · ${entry.older.length} older` : ""}${entry.copies.some((copy) => deleted[entry.id]?.includes(copy.environmentId)) ? " · orphaned copy: delete it here" : ""}`}
                          onEdit={() =>
                            setEditing({
                              environmentId: source.environmentId,
                              connection: source.connection,
                            })
                          }
                          onDelete={() => void remove(entry.connection, source.environmentId)}
                        />
                        <div className="flex flex-wrap gap-2 py-2">
                          {[...entry.missing, ...entry.older.map((copy) => copy.environmentId)].map(
                            (id) => (
                              <Button
                                key={id}
                                size="xs"
                                variant="outline"
                                disabled={
                                  environments.find((item) => item.environmentId === id)?.connection
                                    .phase !== "connected"
                                }
                                onClick={() =>
                                  setEditing({
                                    environmentId: source.environmentId,
                                    connection: source.connection,
                                    copyTo: id,
                                  })
                                }
                              >
                                Copy to{" "}
                                {environments.find((item) => item.environmentId === id)?.label ??
                                  id}
                              </Button>
                            ),
                          )}
                        </div>
                      </div>
                    );
                  })
                : copies
                    .filter((copy) => copy.connection.level === level)
                    .map((copy) => (
                      <ConnectionRow
                        key={`${copy.environmentId}:${copy.connection.id}`}
                        connection={copy.connection}
                        environmentId={copy.environmentId}
                        suffix={
                          environments.find((item) => item.environmentId === copy.environmentId)
                            ?.label ?? copy.environmentId
                        }
                        onEdit={() => setEditing(copy)}
                        onDelete={() => void remove(copy.connection, copy.environmentId)}
                      />
                    ))}
              {!(level === "global" ? globalCopies : copies).some(
                (copy) => copy.connection.level === level,
              ) && <p className="text-sm text-muted-foreground">No {level} connections.</p>}
            </section>
          ))}
        </div>
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
