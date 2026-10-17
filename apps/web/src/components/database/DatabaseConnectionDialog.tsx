import { useDatabaseGlobalDeletes } from "../../state/databaseGlobalDeletes";
import { randomUUID } from "../../lib/utils";
import { RegistryContext, useAtomValue } from "@effect/atom-react";
import {
  DatabaseConnectionDraft,
  DatabaseConnectionId,
  type DatabaseConnection,
  type DatabaseConnectionLevel,
  type EnvironmentId,
  type ProjectId,
  type DatabasePostgresSslMode,
} from "@t3tools/contracts";
import {
  databaseGlobalDraft,
  fanOutDatabaseOperation,
} from "@t3tools/client-runtime/state/database";
import * as Schema from "effect/Schema";
import { useContext, useState } from "react";
import { databaseState } from "../../state/database";
import { useEnvironments } from "../../state/environments";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogPanel,
  DialogFooter,
} from "../ui/dialog";
import { DatabaseSelect } from "./DatabaseSelect";
import { databaseValue } from "./databaseHooks";

const decodeDraft = Schema.decodeUnknownSync(DatabaseConnectionDraft);

export function DatabaseConnectionDialog({
  environmentId,
  projectId,
  connection,
  initialLevel = "environment",
  copyTo,
  onClose,
}: {
  environmentId: EnvironmentId;
  projectId?: ProjectId;
  connection?: DatabaseConnection;
  initialLevel?: DatabaseConnectionLevel;
  copyTo?: EnvironmentId;
  onClose: () => void;
}) {
  const registry = useContext(RegistryContext);
  const { environments } = useEnvironments();
  const canSave = useAtomValue(
    databaseState.saveConnection.permissionAtom(copyTo ?? environmentId),
  );
  const [name, setName] = useState(connection?.name ?? "");
  const [level, setLevel] = useState(connection?.level ?? initialLevel);
  const [engine, setEngine] = useState(connection?.target.engine ?? "postgres");
  const pg = connection?.target.engine === "postgres" ? connection.target : null;
  const [host, setHost] = useState(pg?.host ?? "localhost");
  const [port, setPort] = useState(String(pg?.port ?? 5432));
  const [database, setDatabase] = useState(pg?.database ?? "");
  const [user, setUser] = useState(pg?.user ?? "");
  const [sslMode, setSslMode] = useState<DatabasePostgresSslMode>(pg?.sslMode ?? "prefer");
  const [path, setPath] = useState(
    connection?.target.engine === "sqlite" ? connection.target.path : "",
  );
  const [readOnly, setReadOnly] = useState(connection?.readOnly ?? true);
  const [passwordAction, setPasswordAction] = useState<"keep" | "replace" | "clear">(
    copyTo ? "replace" : "keep",
  );
  const [password, setPassword] = useState("");
  const [globalId] = useState(() => connection?.id ?? DatabaseConnectionId.make(randomUUID()));
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const draft = () =>
    decodeDraft({
      ...(connection ? { id: connection.id } : {}),
      name,
      level,
      ...(level === "project"
        ? { projectId: projectId ?? connection?.projectId ?? undefined }
        : {}),
      target:
        engine === "sqlite"
          ? { engine, path }
          : { engine, host, port: Number(port), database, user, sslMode },
      readOnly,
      ...(passwordAction === "replace"
        ? { password }
        : passwordAction === "clear"
          ? { password: null }
          : {}),
    });
  const test = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const result = databaseValue(
        await databaseState.testConnection.run(registry, {
          environmentId: copyTo ?? environmentId,
          input: draft(),
        }),
      );
      setMessage(
        result.ok ? `Connected · ${result.serverVersion}` : `Connection failed: ${result.message}`,
      );
    } catch (error) {
      setMessage(String(error));
    } finally {
      setBusy(false);
    }
  };
  const save = async () => {
    setBusy(true);
    setMessage(null);
    try {
      let input = draft();
      if (level === "global")
        input = databaseGlobalDraft(input, globalId, new Date().toISOString());
      const targets = copyTo
        ? [copyTo]
        : level === "global"
          ? environments
              .filter((item) => item.connection.phase === "connected")
              .map((item) => item.environmentId)
          : [environmentId];
      if (targets.length === 0)
        throw new Error("Connect an environment before saving a connection.");
      if (level === "global" && connection?.hasPassword && passwordAction === "keep") {
        for (const id of targets) {
          const list = databaseValue(
            await databaseState.listConnections.run(registry, { environmentId: id, input: {} }),
          );
          if (!list.connections.some((item) => item.id === globalId && item.hasPassword))
            throw new Error(
              "Set the password again to create a missing global copy, or explicitly clear it. This device cannot read the stored password.",
            );
        }
      }
      const results = await fanOutDatabaseOperation(targets, async (id) =>
        databaseValue(
          await databaseState.saveConnection.run(registry, { environmentId: id, input }),
        ),
      );
      const failures = results.flatMap((result, index) =>
        !result.ok
          ? [
              `${environments.find((item) => item.environmentId === targets[index])?.label ?? targets[index]}: ${String(result.error)}`,
            ]
          : [],
      );
      if (failures.length) throw new Error(failures.join("\n"));
      if (level === "global") useDatabaseGlobalDeletes.getState().clear(globalId);
      onClose();
    } catch (error) {
      setMessage(String(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>
            {copyTo
              ? "Copy database connection"
              : connection
                ? "Edit database connection"
                : "New database connection"}
          </DialogTitle>
          <DialogDescription>
            Connections open on the selected environment. Stored passwords are never sent back to
            this device.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <label className="grid gap-1 text-sm">
            Name
            <Input value={name} onChange={(event) => setName(event.target.value)} autoFocus />
          </label>
          <label className="grid gap-1 text-sm">
            Level
            <DatabaseSelect
              label="Connection level"
              value={level}
              disabled={!!copyTo}
              options={[
                { value: "global", label: "Global · all reachable environments" },
                { value: "environment", label: "Environment" },
                ...(projectId || connection?.projectId
                  ? [{ value: "project" as const, label: "Project" }]
                  : []),
              ]}
              onChange={setLevel}
            />
          </label>
          <DatabaseSelect
            label="Database engine"
            value={engine}
            options={[
              { value: "postgres", label: "Postgres" },
              { value: "sqlite", label: "SQLite" },
            ]}
            onChange={setEngine}
            disabled={!!copyTo}
          />
          {engine === "sqlite" ? (
            <label className="grid gap-1 text-sm">
              Absolute file path on the environment
              <Input value={path} onChange={(event) => setPath(event.target.value)} />
            </label>
          ) : (
            <>
              <div className="grid grid-cols-[1fr_6rem] gap-2">
                <label className="grid gap-1 text-sm">
                  Host
                  <Input value={host} onChange={(event) => setHost(event.target.value)} />
                </label>
                <label className="grid gap-1 text-sm">
                  Port
                  <Input
                    type="number"
                    value={port}
                    onChange={(event) => setPort(event.target.value)}
                  />
                </label>
              </div>
              <label className="grid gap-1 text-sm">
                Database
                <Input value={database} onChange={(event) => setDatabase(event.target.value)} />
              </label>
              <label className="grid gap-1 text-sm">
                User
                <Input value={user} onChange={(event) => setUser(event.target.value)} />
              </label>
              <DatabaseSelect
                label="TLS mode"
                value={sslMode}
                options={["disable", "prefer", "require", "verify-full"].map((value) => ({
                  value: value as DatabasePostgresSslMode,
                  label: `TLS: ${value}`,
                }))}
                onChange={setSslMode}
              />
              <DatabaseSelect
                label="Password action"
                value={passwordAction}
                options={[
                  {
                    value: "keep",
                    label: connection?.hasPassword ? "Keep stored password" : "No stored password",
                  },
                  { value: "replace", label: "Set password" },
                  { value: "clear", label: "Clear password" },
                ]}
                onChange={setPasswordAction}
              />
              {passwordAction === "replace" && (
                <label className="grid gap-1 text-sm">
                  Password
                  <Input
                    type="password"
                    autoComplete="new-password"
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                  />
                </label>
              )}
            </>
          )}
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={readOnly}
              onChange={(event) => setReadOnly(event.target.checked)}
            />
            Read-only
          </label>
          {level === "global" && engine === "sqlite" && (
            <p role="alert" className="text-sm">
              SQLite files are local to an environment. Choose Environment or Project.
            </p>
          )}
          {level === "global" &&
            engine === "postgres" &&
            /^(localhost|127\.|\[?::1\]?$|0\.0\.0\.0$)/i.test(host) && (
              <p role="note" className="text-sm">
                Loopback points to a different database on each environment. Use a shared database
                hostname for global connections.
              </p>
            )}
          {message && (
            <p role="status" className="whitespace-pre-wrap break-words text-sm">
              {message}
            </p>
          )}
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button variant="outline" disabled={busy || !canSave} onClick={() => void test()}>
            Test connection
          </Button>
          <Button
            disabled={
              busy || !canSave || !name.trim() || (level === "global" && engine === "sqlite")
            }
            onClick={() => void save()}
          >
            {busy ? "Working…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
