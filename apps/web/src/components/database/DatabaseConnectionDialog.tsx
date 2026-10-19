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
  type DatabasePostgresAuthKind,
  type DatabasePostgresSslMode,
} from "@t3tools/contracts";
import {
  databaseGlobalDraft,
  fanOutDatabaseOperation,
} from "@t3tools/client-runtime/state/database";
import * as Schema from "effect/Schema";
import { CircleAlertIcon, CircleCheckIcon } from "lucide-react";
import { useContext, useId, useState } from "react";
import { databaseState } from "../../state/database";
import { useEnvironments } from "../../state/environments";
import { Button } from "../ui/button";
import { Alert, AlertDescription } from "../ui/alert";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Switch } from "../ui/switch";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
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
import { databaseErrorMessage, databaseValue } from "./databaseHooks";

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
  const auth = pg?.auth;
  const [authKind, setAuthKind] = useState<DatabasePostgresAuthKind>(auth?.kind ?? "password");
  const [awsProfile, setAwsProfile] = useState(
    auth && auth.kind !== "password" ? (auth.profile ?? "") : "",
  );
  const [awsRegion, setAwsRegion] = useState(
    auth && auth.kind !== "password" ? (auth.region ?? "") : "",
  );
  const [secretId, setSecretId] = useState(
    auth?.kind === "aws-secrets-manager" ? auth.secretId : "",
  );
  const [useSecretHost, setUseSecretHost] = useState(
    auth?.kind === "aws-secrets-manager" && auth.useSecretHost,
  );
  const [parameterName, setParameterName] = useState(
    auth?.kind === "aws-parameter-store" ? auth.parameterName : "",
  );
  const [path, setPath] = useState(
    connection?.target.engine === "sqlite" ? connection.target.path : "",
  );
  const [readOnly, setReadOnly] = useState(connection?.readOnly ?? true);
  // Only an existing stored password has anything to keep or clear.
  const storedPassword = !copyTo && connection?.hasPassword === true;
  const [passwordAction, setPasswordAction] = useState<"keep" | "replace" | "clear">(
    storedPassword ? "keep" : "replace",
  );
  const [password, setPassword] = useState("");
  const [globalId] = useState(() => connection?.id ?? DatabaseConnectionId.make(randomUUID()));
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  const id = useId();
  const usesPassword = authKind === "password";
  const awsLocation = () => ({
    ...(awsProfile.trim() ? { profile: awsProfile } : {}),
    ...(awsRegion.trim() ? { region: awsRegion } : {}),
  });
  const postgresAuth = () => {
    switch (authKind) {
      case "password":
        return {};
      case "aws-iam":
        return { auth: { kind: authKind, ...awsLocation() } };
      case "aws-secrets-manager":
        return { auth: { kind: authKind, ...awsLocation(), secretId, useSecretHost } };
      case "aws-parameter-store":
        return { auth: { kind: authKind, ...awsLocation(), parameterName } };
    }
  };
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
          : { engine, host, port: Number(port), database, user, sslMode, ...postgresAuth() },
      readOnly,
      ...(engine === "postgres" && !usesPassword
        ? {}
        : passwordAction === "replace" && (storedPassword || password)
          ? { password }
          : passwordAction === "clear"
            ? { password: null }
            : {}),
    });
  const test = async () => {
    setBusy(true);
    setMessage(null);
    return await (async () => {
      const result = databaseValue(
        await databaseState.testConnection.run(registry, {
          environmentId: copyTo ?? environmentId,
          input: draft(),
        }),
      );
      setMessage(
        result.ok
          ? { tone: "success", text: `Connected (${result.serverVersion})` }
          : { tone: "error", text: result.message },
      );
    })()
      .catch(async (error: unknown) => {
        setMessage({ tone: "error", text: databaseErrorMessage(error) });
      })
      .finally(() => {
        setBusy(false);
      });
  };
  const save = async () => {
    setBusy(true);
    setMessage(null);
    return await (async () => {
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
      if (
        level === "global" &&
        connection?.hasPassword &&
        usesPassword &&
        passwordAction === "keep"
      ) {
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
              `${environments.find((item) => item.environmentId === targets[index])?.label ?? targets[index]}: ${databaseErrorMessage(result.error)}`,
            ]
          : [],
      );
      if (failures.length) throw new Error(failures.join("\n"));
      if (level === "global") useDatabaseGlobalDeletes.getState().clear(globalId);
      onClose();
    })()
      .catch(async (error: unknown) => {
        setMessage({ tone: "error", text: databaseErrorMessage(error) });
      })
      .finally(() => {
        setBusy(false);
      });
  };
  const loopback = engine === "postgres" && /^(localhost|127\.|\[?::1\]?$|0\.0\.0\.0$)/i.test(host);
  const canSubmit = !busy && canSave && name.trim() !== "";
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
        <form
          className="flex min-h-0 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            if (canSubmit) void save();
          }}
        >
          <DialogPanel>
            <div className="flex flex-col gap-4">
              <div className="flex flex-col gap-1.5">
                <Label id={`${id}-engine`}>Engine</Label>
                <ToggleGroup
                  aria-labelledby={`${id}-engine`}
                  className="w-full *:flex-1"
                  value={[engine]}
                  disabled={!!copyTo}
                  onValueChange={(next) => {
                    const value = next[0];
                    if (value !== "postgres" && value !== "sqlite") return;
                    setEngine(value);
                    if (value === "sqlite" && level === "global") setLevel("environment");
                  }}
                >
                  <Toggle value="postgres">PostgreSQL</Toggle>
                  <Toggle value="sqlite">SQLite</Toggle>
                </ToggleGroup>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor={`${id}-name`}>Name</Label>
                <Input
                  id={`${id}-name`}
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  autoFocus
                />
              </div>
              {engine === "sqlite" ? (
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor={`${id}-path`}>File path</Label>
                  <Input
                    id={`${id}-path`}
                    font="mono"
                    placeholder="/absolute/path/to/database.sqlite"
                    value={path}
                    onChange={(event) => setPath(event.target.value)}
                  />
                  <p className="text-xs text-muted-foreground">
                    An absolute path on the environment, not on this device.
                  </p>
                </div>
              ) : (
                <>
                  <div className="grid grid-cols-[1fr_6rem] gap-3">
                    <div className="flex min-w-0 flex-col gap-1.5">
                      <Label htmlFor={`${id}-host`}>Host</Label>
                      <Input
                        id={`${id}-host`}
                        value={host}
                        onChange={(event) => setHost(event.target.value)}
                      />
                    </div>
                    <div className="flex min-w-0 flex-col gap-1.5">
                      <Label htmlFor={`${id}-port`}>Port</Label>
                      <Input
                        id={`${id}-port`}
                        type="number"
                        value={port}
                        onChange={(event) => setPort(event.target.value)}
                      />
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div className="flex min-w-0 flex-col gap-1.5">
                      <Label htmlFor={`${id}-database`}>Database</Label>
                      <Input
                        id={`${id}-database`}
                        value={database}
                        onChange={(event) => setDatabase(event.target.value)}
                      />
                    </div>
                    <div className="flex min-w-0 flex-col gap-1.5">
                      <Label htmlFor={`${id}-user`}>User</Label>
                      <Input
                        id={`${id}-user`}
                        autoComplete="off"
                        value={user}
                        onChange={(event) => setUser(event.target.value)}
                      />
                    </div>
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor={`${id}-auth`}>Authentication</Label>
                    <DatabaseSelect
                      id={`${id}-auth`}
                      label="Authentication"
                      value={authKind}
                      options={[
                        { value: "password", label: "Password" },
                        { value: "aws-iam", label: "AWS IAM" },
                        { value: "aws-secrets-manager", label: "AWS Secrets Manager" },
                        { value: "aws-parameter-store", label: "AWS Parameter Store" },
                      ]}
                      onChange={setAuthKind}
                    />
                  </div>
                  {usesPassword && (
                    <div className="flex flex-col gap-1.5">
                      <Label htmlFor={`${id}-password`}>Password</Label>
                      {storedPassword && (
                        <DatabaseSelect
                          id={`${id}-password-action`}
                          label="Stored password"
                          value={passwordAction}
                          options={[
                            { value: "keep", label: "Keep the stored password" },
                            { value: "replace", label: "Set a new password" },
                            { value: "clear", label: "Remove the stored password" },
                          ]}
                          onChange={setPasswordAction}
                        />
                      )}
                      {passwordAction === "replace" && (
                        <Input
                          id={`${id}-password`}
                          type="password"
                          autoComplete="new-password"
                          placeholder={storedPassword ? "New password" : "Leave empty for none"}
                          value={password}
                          onChange={(event) => setPassword(event.target.value)}
                        />
                      )}
                    </div>
                  )}
                  {!usesPassword && (
                    <>
                      <div className="grid grid-cols-2 gap-3">
                        <div className="flex min-w-0 flex-col gap-1.5">
                          <Label htmlFor={`${id}-aws-profile`}>AWS profile</Label>
                          <Input
                            id={`${id}-aws-profile`}
                            autoComplete="off"
                            placeholder="Default credentials"
                            value={awsProfile}
                            onChange={(event) => setAwsProfile(event.target.value)}
                          />
                        </div>
                        <div className="flex min-w-0 flex-col gap-1.5">
                          <Label htmlFor={`${id}-aws-region`}>Region</Label>
                          <Input
                            id={`${id}-aws-region`}
                            autoComplete="off"
                            placeholder="From the profile"
                            value={awsRegion}
                            onChange={(event) => setAwsRegion(event.target.value)}
                          />
                        </div>
                      </div>
                      {authKind === "aws-secrets-manager" && (
                        <>
                          <div className="flex flex-col gap-1.5">
                            <Label htmlFor={`${id}-secret-id`}>Secret name or ARN</Label>
                            <Input
                              id={`${id}-secret-id`}
                              font="mono"
                              autoComplete="off"
                              value={secretId}
                              onChange={(event) => setSecretId(event.target.value)}
                            />
                          </div>
                          <div className="flex items-start justify-between gap-4">
                            <div className="flex flex-col gap-1">
                              <Label htmlFor={`${id}-secret-host`}>
                                Use host and port from the secret
                              </Label>
                              <p className="text-xs text-muted-foreground">
                                Falls back to the host and port above when the secret has none.
                              </p>
                            </div>
                            <Switch
                              id={`${id}-secret-host`}
                              checked={useSecretHost}
                              onCheckedChange={setUseSecretHost}
                            />
                          </div>
                        </>
                      )}
                      {authKind === "aws-parameter-store" && (
                        <div className="flex flex-col gap-1.5">
                          <Label htmlFor={`${id}-parameter`}>Parameter name</Label>
                          <Input
                            id={`${id}-parameter`}
                            font="mono"
                            autoComplete="off"
                            placeholder="/app/database/password"
                            value={parameterName}
                            onChange={(event) => setParameterName(event.target.value)}
                          />
                        </div>
                      )}
                      <p className="text-xs text-muted-foreground">
                        {authKind === "aws-iam"
                          ? "Signs a token with the environment's AWS credentials. The user needs the rds_iam role, and RDS requires TLS."
                          : "Read with the environment's AWS credentials on each connect. A JSON value may supply username, password, host and port; any other value is the password."}
                      </p>
                    </>
                  )}
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor={`${id}-tls`}>TLS</Label>
                    <DatabaseSelect
                      id={`${id}-tls`}
                      label="TLS"
                      value={sslMode}
                      options={[
                        { value: "disable", label: "Disable" },
                        { value: "prefer", label: "Prefer (use TLS when the server offers it)" },
                        { value: "require", label: "Require" },
                        { value: "verify-full", label: "Require and verify the certificate" },
                      ]}
                      onChange={setSslMode}
                    />
                  </div>
                </>
              )}
              <div className="flex flex-col gap-1.5">
                <Label htmlFor={`${id}-level`}>Available in</Label>
                <DatabaseSelect
                  id={`${id}-level`}
                  label="Available in"
                  value={level}
                  disabled={!!copyTo}
                  options={[
                    ...(projectId || connection?.projectId
                      ? [{ value: "project" as const, label: "This project" }]
                      : []),
                    { value: "environment", label: "Every project on this environment" },
                    ...(engine === "postgres"
                      ? [{ value: "global" as const, label: "Every connected environment" }]
                      : []),
                  ]}
                  onChange={setLevel}
                />
                {level === "global" && loopback && (
                  <p role="note" className="text-xs text-warning-foreground">
                    {host} points to a different database on each environment. Use a hostname every
                    environment can reach.
                  </p>
                )}
              </div>
              <div className="flex items-start justify-between gap-4">
                <div className="flex flex-col gap-1">
                  <Label htmlFor={`${id}-read-only`}>Read-only</Label>
                  <p className="text-xs text-muted-foreground">
                    Statements that change data are rejected.
                  </p>
                </div>
                <Switch id={`${id}-read-only`} checked={readOnly} onCheckedChange={setReadOnly} />
              </div>
              {message && (
                <Alert variant={message.tone} role={message.tone === "error" ? "alert" : "status"}>
                  {message.tone === "success" ? <CircleCheckIcon /> : <CircleAlertIcon />}
                  <AlertDescription className="whitespace-pre-wrap break-words">
                    {message.text}
                  </AlertDescription>
                </Alert>
              )}
            </div>
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="outline" disabled={busy} onClick={onClose}>
              Cancel
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={busy || !canSave}
              onClick={() => void test()}
            >
              Test connection
            </Button>
            <Button type="submit" disabled={!canSubmit}>
              {busy ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
