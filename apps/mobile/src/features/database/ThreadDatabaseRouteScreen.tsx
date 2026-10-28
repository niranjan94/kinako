import { RegistryContext, useAtomValue } from "@effect/atom-react";
import type { StaticScreenProps } from "@react-navigation/native";
import { databaseCacheKey, releaseDatabaseResources } from "@t3tools/client-runtime/state/database";
import {
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import {
  DatabaseQueryId,
  type DatabaseConnection,
  type DatabaseIntrospectResult,
  type DatabaseIntrospectScope,
  type DatabaseExecuteResult,
  type DatabaseCell,
  type EnvironmentId,
  type ProjectId,
} from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { useContext, useEffect, useMemo, useRef, useState } from "react";
import { FlatList, Modal, Pressable, ScrollView, View } from "react-native";
import { AppText, AppTextInput } from "../../components/ui/AppText";
import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { Button } from "../../components/ui/Button";
import { ScreenContent } from "../../components/ui/ScreenContent";
import { databaseState } from "../../state/database";
import { useThreadSelection } from "../../state/use-thread-selection";
import { useEnvironmentPresentation } from "../../state/presentation";
import { uuidv4 } from "../../lib/uuid";

function value<A, E>(result: AtomCommandResult<A, E>): A {
  if (AsyncResult.isSuccess(result)) return result.value;
  const error = squashAtomCommandFailure(result);
  throw error instanceof Error ? error : new Error(String(error));
}
const errorMessage = (error: unknown) =>
  error instanceof Error
    ? error.message
    : typeof error === "object" && error !== null && "message" in error
      ? String(error.message)
      : String(error);
const cellText = (cell: DatabaseCell) =>
  cell === null
    ? "NULL"
    : typeof cell === "object"
      ? `${cell.truncated}… (${cell.length} characters)`
      : String(cell);

const LEVEL_LABELS = {
  project: "This project",
  environment: "This environment",
  global: "All environments",
} as const;

type Props = StaticScreenProps<{ environmentId: string; threadId: string }>;
export function ThreadDatabaseRouteScreen(_props: Props) {
  const { selectedThread } = useThreadSelection();
  if (!selectedThread)
    return (
      <View className="flex-1 bg-screen p-4">
        <AppText>Open a project thread to browse its databases.</AppText>
      </View>
    );
  return (
    <DatabaseScreen
      environmentId={selectedThread.environmentId}
      projectId={selectedThread.projectId}
    />
  );
}

function DatabaseScreen({
  environmentId,
  projectId,
}: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
}) {
  const registry = useContext(RegistryContext);
  const allowed = useAtomValue(databaseState.execute.permissionAtom(environmentId));
  const revision = useAtomValue(databaseState.revision(environmentId));
  const connections = useAtomValue(
    databaseState.connections(databaseCacheKey(environmentId, { projectId })),
  );
  const { presentation } = useEnvironmentPresentation(environmentId);
  const status = presentation?.connection.phase;
  const [connection, setConnection] = useState<DatabaseConnection | null>(null);
  const [metadata, setMetadata] = useState<DatabaseIntrospectResult | null>(null);
  const [databaseName, setDatabaseName] = useState<string | undefined>(undefined);
  const [scope, setScope] = useState<DatabaseIntrospectScope>({ kind: "schemas" });
  const [sql, setSql] = useState("SELECT 1");
  const [result, setResult] = useState<DatabaseExecuteResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [viewer, setViewer] = useState<string | null>(null);
  const [listed, setListed] = useState<string | null>(null);
  const queryId = useRef<DatabaseQueryId | undefined>(undefined);
  const mounted = useRef(true);
  const running = useRef(false);
  const [tablePage, setTablePage] = useState<{
    schema: string;
    object: string;
    offset: number;
    after: readonly (string | number | boolean | null)[] | null;
  } | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- lists saved database connections from the server while connected
  useEffect(() => {
    if (!allowed || status !== "connected") return;
    const key = `${environmentId}:${projectId}:${revision}`;
    void databaseState.listConnections
      .run(registry, { environmentId, input: { projectId } })
      .then((result) => {
        try {
          value(result);
          if (registry.get(databaseState.revision(environmentId)) !== revision) return;
        } catch (error) {
          if (mounted.current) setError(errorMessage(error));
        } finally {
          if (mounted.current) setListed(key);
        }
      });
  }, [allowed, environmentId, projectId, registry, revision, status]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- releases this screen's server-side database session and query on unmount
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      void releaseDatabaseResources(
        databaseState,
        registry,
        { environmentId, projectId },
        queryId.current ? { queryId: queryId.current } : {},
      );
    };
  }, [environmentId, projectId, registry]);
  const describe = async (
    next: DatabaseIntrospectScope,
    nextConnection = connection,
    nextDatabase = nextConnection?.id === connection?.id ? databaseName : undefined,
  ) => {
    if (!nextConnection || running.current) return;
    running.current = true;
    setBusy(true);
    setError(null);
    setScope(next);
    setMetadata(null);
    if (next.kind === "databases") {
      nextDatabase = undefined;
      setDatabaseName(undefined);
      setResult(null);
      setTablePage(null);
    } else setDatabaseName(nextDatabase);
    try {
      if (next.kind === "databases") await closeResult();
      const data = value(
        await databaseState.introspect.run(registry, {
          environmentId,
          input: {
            projectId,
            connectionId: nextConnection.id,
            ...(nextDatabase !== undefined ? { database: nextDatabase } : {}),
            scope: next,
          },
        }),
      );
      if (mounted.current) setMetadata(data);
    } catch (error) {
      if (mounted.current) setError(errorMessage(error));
    } finally {
      running.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  const closeResult = async () => {
    if (queryId.current)
      await releaseDatabaseResources(
        databaseState,
        registry,
        { environmentId, projectId },
        { queryId: queryId.current },
      );
    queryId.current = undefined;
  };
  const execute = async () => {
    if (!connection || running.current || !sql.trim() || scope.kind === "databases") return;
    running.current = true;
    setBusy(true);
    setError(null);
    setTablePage(null);
    try {
      await closeResult();
      const id = DatabaseQueryId.make(uuidv4());
      queryId.current = id;
      const data = value(
        await databaseState.execute.run(registry, {
          environmentId,
          input: {
            projectId,
            connectionId: connection.id,
            ...(databaseName !== undefined ? { database: databaseName } : {}),
            queryId: id,
            sql,
            forceReadOnly: true,
          },
        }),
      );
      if (mounted.current) setResult(data);
      else await closeResult();
    } catch (error) {
      if (mounted.current) setError(errorMessage(error));
    } finally {
      running.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  const browse = async (schema: string, object: string, more = false) => {
    if (!connection || running.current) return;
    running.current = true;
    setBusy(true);
    setError(null);
    try {
      await closeResult();
      const data = value(
        await databaseState.browseTable.run(registry, {
          environmentId,
          input: {
            projectId,
            connectionId: connection.id,
            ...(databaseName !== undefined ? { database: databaseName } : {}),
            schema,
            object,
            offset: more ? (tablePage?.offset ?? 0) : 0,
            ...(more && tablePage?.after ? { after: tablePage.after } : {}),
          },
        }),
      );
      if (mounted.current) {
        setTablePage({ schema, object, offset: data.nextOffset, after: data.nextAfter });
        setResult({
          kind: "rows",
          rows: [...(more && result?.kind === "rows" ? result.rows : []), ...data.rows],
          columns: data.columns,
          hasMore: data.hasMore,
          durationMs: 0,
        });
      }
    } catch (error) {
      if (mounted.current) setError(errorMessage(error));
    } finally {
      running.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  const more = async () => {
    if (tablePage) {
      await browse(tablePage.schema, tablePage.object, true);
      return;
    }
    if (!queryId.current || result?.kind !== "rows" || running.current) return;
    running.current = true;
    setBusy(true);
    try {
      const data = value(
        await databaseState.fetchPage.run(registry, {
          environmentId,
          input: { projectId, queryId: queryId.current },
        }),
      );
      if (mounted.current)
        setResult({ ...result, rows: [...result.rows, ...data.rows], hasMore: data.hasMore });
    } catch (error) {
      if (mounted.current) setError(errorMessage(error));
    } finally {
      running.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  const listing = status === "connected" && listed !== `${environmentId}:${projectId}:${revision}`;
  const parent =
    scope.kind === "objects"
      ? { label: "All schemas", scope: { kind: "schemas" } as const }
      : scope.kind === "columns"
        ? {
            label: scope.schema,
            scope: { kind: "objects", schema: scope.schema } as const,
          }
        : scope.kind === "schemas" &&
            connection?.target.engine === "postgres" &&
            connection.target.databaseSelection
          ? { label: "All databases", scope: { kind: "databases" } as const }
          : null;
  const resultColumns = useMemo(
    () =>
      result?.kind === "rows"
        ? result.columns.map((column, ordinal) => ({
            ...column,
            ordinal,
            key: `${ordinal}:${column.name}`,
          }))
        : [],
    [result],
  );
  return (
    <ScreenContent>
      <View className="flex-1 bg-screen">
        {error && !connection && (
          <AppText accessibilityRole="alert" className="p-3">
            {error}
          </AppText>
        )}
        {!allowed ? (
          <AppText className="p-4">Database access requires terminal permission.</AppText>
        ) : !connection ? (
          <ScrollView>
            {connections.map((item) => (
              <DatabaseRow
                key={item.id}
                busy={busy}
                label={`${item.name} · ${LEVEL_LABELS[item.level]}${item.readOnly ? " · Read-only" : ""}`}
                onPress={() => {
                  setConnection(item);
                  setResult(null);
                  setDatabaseName(undefined);
                  void describe(
                    {
                      kind:
                        item.target.engine === "postgres" && item.target.databaseSelection
                          ? "databases"
                          : "schemas",
                    },
                    item,
                    undefined,
                  );
                }}
              />
            ))}
            {connections.length === 0 &&
              (listing || status !== "connected" ? (
                <View className="flex-row items-center gap-2 p-4">
                  <AppActivityIndicator />
                  <AppText>
                    {status === "connected" ? "Loading connections…" : "Connecting…"}
                  </AppText>
                </View>
              ) : (
                <AppText className="p-4">
                  Create a database connection in Settings → Databases on web or desktop.
                </AppText>
              ))}
          </ScrollView>
        ) : (
          <>
            <View className="flex-row flex-wrap gap-2 p-3">
              <Button
                label="Connections"
                tone="text"
                disabled={busy}
                onPress={() => {
                  void closeResult();
                  setConnection(null);
                  setResult(null);
                  setMetadata(null);
                }}
              />
              <AppText className="self-center font-t3-medium">
                {connection.name}
                {databaseName ? ` · ${databaseName}` : ""} · Read-only
              </AppText>
            </View>
            <ScrollView style={result ? { maxHeight: "40%" } : { flex: 1 }}>
              {parent && (
                <DatabaseRow
                  busy={busy}
                  label={`‹ ${parent.label}`}
                  accessibilityLabel={`Back to ${parent.label}`}
                  onPress={() => void describe(parent.scope)}
                />
              )}
              {metadata?.kind === "databases" &&
                metadata.databases.map((item) => (
                  <DatabaseRow
                    key={item.name}
                    busy={busy}
                    label={item.name}
                    onPress={() => void describe({ kind: "schemas" }, connection, item.name)}
                  />
                ))}
              {metadata?.kind === "databases" && metadata.databases.length === 0 && (
                <AppText className="p-4">No databases available.</AppText>
              )}
              {metadata?.kind === "schemas" &&
                metadata.schemas.map((schema) => (
                  <DatabaseRow
                    key={schema.name}
                    busy={busy}
                    label={schema.name}
                    onPress={() => void describe({ kind: "objects", schema: schema.name })}
                  />
                ))}
              {metadata?.kind === "objects" &&
                scope.kind === "objects" &&
                metadata.objects.map((object) => (
                  <DatabaseRow
                    key={object.name}
                    busy={busy}
                    label={`${object.name} · ${object.type}`}
                    onPress={() =>
                      void describe({ kind: "columns", schema: scope.schema, object: object.name })
                    }
                  />
                ))}
              {metadata?.kind === "columns" &&
                metadata.columns.map((column) => (
                  <AppText key={column.name} className="px-4 py-1 text-xs">
                    {column.primaryKey ? "PK " : ""}
                    {column.references ? "FK " : ""}
                    {column.name} · {column.dataType}
                  </AppText>
                ))}
              {scope.kind === "columns" && (
                <DatabaseRow
                  busy={busy}
                  label={`Browse ${scope.schema}.${scope.object}`}
                  onPress={() => void browse(scope.schema, scope.object)}
                />
              )}
            </ScrollView>
            <View className="gap-2 border-y border-border p-3">
              <AppTextInput
                accessibilityLabel="SQL query"
                value={sql}
                onChangeText={setSql}
                multiline
                autoCapitalize="none"
                autoCorrect={false}
                className="min-h-20 max-h-40 font-mono text-foreground"
              />
              <View className="flex-row gap-2">
                <Button
                  label="Run read-only query"
                  loading={busy}
                  disabled={!allowed || !sql.trim() || scope.kind === "databases"}
                  onPress={() => void execute()}
                />
                <Button
                  label="Cancel"
                  tone="text"
                  disabled={!busy}
                  onPress={() => {
                    if (queryId.current)
                      void databaseState.cancelQuery.run(registry, {
                        environmentId,
                        input: { projectId, queryId: queryId.current },
                      });
                  }}
                />
              </View>
            </View>
            {error && (
              <AppText accessibilityRole="alert" className="p-3">
                {error}
              </AppText>
            )}
            {result?.kind === "failed" ? (
              <AppText accessibilityRole="alert" className="p-3">
                {result.message}
                {result.code ? ` · ${result.code}` : ""} · {result.durationMs} ms
              </AppText>
            ) : result?.kind === "command" ? (
              <AppText className="p-3">
                {result.command}
                {result.affectedRows !== null
                  ? ` · ${result.affectedRows} ${result.affectedRows === 1 ? "row" : "rows"}`
                  : ""}{" "}
                · {result.durationMs} ms
              </AppText>
            ) : result?.kind === "rows" ? (
              <>
                <AppText className="px-3 py-1 text-xs">
                  {result.rows.length} rows · {result.durationMs} ms
                  {result.hasMore && !tablePage ? " · Unread results expire after 60 seconds" : ""}
                </AppText>
                <ScrollView horizontal style={{ flex: 1 }}>
                  <View style={{ width: Math.max(1, result.columns.length) * 160, flex: 1 }}>
                    <View className="flex-row border-b border-border">
                      {resultColumns.map((column) => (
                        <AppText
                          key={column.key}
                          numberOfLines={1}
                          style={{ width: 160 }}
                          className="p-2 font-t3-medium"
                        >
                          {column.name}
                        </AppText>
                      ))}
                    </View>
                    <FlatList
                      data={result.rows}
                      keyExtractor={(_row, index) => String(index)}
                      getItemLayout={(_data, index) => ({ length: 40, offset: 40 * index, index })}
                      onEndReached={() => {
                        if (result.hasMore && !busy) void more();
                      }}
                      onEndReachedThreshold={0.4}
                      renderItem={({ item }) => (
                        <View className="flex-row border-b border-border" style={{ height: 40 }}>
                          {resultColumns.map((column) => {
                            const cell = item[column.ordinal] ?? null;
                            return (
                              <Pressable
                                key={column.key}
                                accessibilityRole="button"
                                onPress={() => setViewer(cellText(cell))}
                                style={{ width: 160 }}
                                className="justify-center px-2"
                              >
                                <AppText
                                  numberOfLines={1}
                                  className={cell === null ? "text-foreground-muted italic" : ""}
                                >
                                  {cellText(cell)}
                                </AppText>
                              </Pressable>
                            );
                          })}
                        </View>
                      )}
                    />
                  </View>
                </ScrollView>
                {result.hasMore && (
                  <View className="p-2">
                    <Button label="Load more" disabled={busy} onPress={() => void more()} />
                  </View>
                )}
              </>
            ) : null}
          </>
        )}
        <Modal
          visible={viewer !== null}
          animationType="slide"
          onRequestClose={() => setViewer(null)}
          presentationStyle="pageSheet"
        >
          <View className="flex-1 bg-screen p-4">
            <Button label="Close value" onPress={() => setViewer(null)} />
            <ScrollView>
              <AppText selectable className="py-4">
                {viewer}
              </AppText>
            </ScrollView>
          </View>
        </Modal>
      </View>
    </ScreenContent>
  );
}

function DatabaseRow({
  label,
  accessibilityLabel,
  busy,
  onPress,
}: {
  label: string;
  accessibilityLabel?: string;
  busy: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      disabled={busy}
      onPress={onPress}
      className="border-b border-border px-4 py-3"
    >
      <AppText>{label}</AppText>
    </Pressable>
  );
}
