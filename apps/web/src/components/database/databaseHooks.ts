import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { databaseCacheKey } from "@t3tools/client-runtime/state/database";
import {
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { useContext, useEffect, useState } from "react";
import { databaseState } from "../../state/database";
import { useEnvironment } from "../../state/environments";

export function databaseValue<A, E>(result: AtomCommandResult<A, E>): A {
  if (AsyncResult.isSuccess(result)) return result.value;
  const error = squashAtomCommandFailure(result);
  throw error instanceof Error ? error : new Error(String(error));
}

export function databaseErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error !== null && "message" in error)
    return String(error.message);
  return String(error);
}

export function useDatabaseConnections(environmentId: EnvironmentId, projectId?: ProjectId) {
  const registry = useContext(RegistryContext);
  const input = projectId === undefined ? {} : { projectId };
  const items = useAtomValue(databaseState.connections(databaseCacheKey(environmentId, input)));
  const revision = useAtomValue(databaseState.revision(environmentId));
  const allowed = useAtomValue(databaseState.listConnections.permissionAtom(environmentId));
  const environment = useEnvironment(environmentId);
  const phase = environment?.connection.phase;
  const loadKey = JSON.stringify([environmentId, projectId, revision, phase]);
  const [settled, setSettled] = useState<{ key: string; error: string | null } | null>(null);
  useEffect(() => {
    if (!allowed || phase !== "connected") return;
    let active = true;
    void databaseState.listConnections
      .run(registry, { environmentId, input: projectId === undefined ? {} : { projectId } })
      .then((result) => {
        if (!active) return;
        try {
          databaseValue(result);
          setSettled({ key: loadKey, error: null });
        } catch (error) {
          setSettled({ key: loadKey, error: databaseErrorMessage(error) });
        }
      });
    return () => {
      active = false;
    };
  }, [allowed, environmentId, phase, projectId, registry, loadKey]);
  return {
    connections: items,
    error: settled?.key === loadKey ? settled.error : null,
    loading: allowed && phase === "connected" && settled?.key !== loadKey,
    allowed,
  };
}
