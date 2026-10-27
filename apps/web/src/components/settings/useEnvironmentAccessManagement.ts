import {
  AuthAccessReadScope,
  AuthAccessWriteScope,
  type AuthCreatePairingCredentialInput,
  type AuthPairingCredentialResult,
  type AuthEnvironmentScope,
  type EnvironmentId,
} from "@t3tools/contracts";
import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { useState } from "react";

import type { ServerClientSessionRecord } from "~/environments/primary";
import { authEnvironment } from "~/state/auth";
import { useEnvironmentQuery } from "~/state/query";
import {
  readEnvironmentScope,
  useEnvironmentScope,
  useEnvironmentSessionScopes,
} from "~/state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { stackedThreadToast, toastManager } from "../ui/toast";
import {
  sortDesktopClientSessions,
  sortDesktopPairingLinks,
  toDesktopClientSessionRecord,
  toDesktopPairingLinkRecord,
} from "./ConnectionsSettings.logic";

const EMPTY_SCOPES: ReadonlyArray<AuthEnvironmentScope> = [];

/** `subscribe` gates only the access stream, so created credentials outlive a collapsed list. */
export function useEnvironmentAccessManagement(
  environmentId: EnvironmentId | null,
  subscribe = true,
) {
  const canReadAccess = useEnvironmentScope(environmentId, AuthAccessReadScope);
  const canWriteAccess = useEnvironmentScope(environmentId, AuthAccessWriteScope);
  const delegatableScopes = useEnvironmentSessionScopes(environmentId) ?? EMPTY_SCOPES;
  const accessChanges = useEnvironmentQuery(
    subscribe && canReadAccess && environmentId !== null
      ? authEnvironment.accessChanges({ environmentId, input: null })
      : null,
  );
  const createPairingLinkCommand = useAtomCommand(authEnvironment.createPairingLink, {
    reportFailure: false,
  });
  const revokePairingLinkCommand = useAtomCommand(authEnvironment.revokePairingLink, {
    reportFailure: false,
  });
  const revokeClientCommand = useAtomCommand(authEnvironment.revokeClient, {
    reportFailure: false,
  });
  const revokeOtherClientsCommand = useAtomCommand(authEnvironment.revokeOtherClients, {
    reportFailure: false,
  });
  const [mutationError, setMutationError] = useState<string | null>(null);
  // Only this client's creation response can supply a shareable credential.
  const [createdPairingCredentials, setCreatedPairingCredentials] = useState<
    ReadonlyMap<string, string>
  >(() => new Map());
  const [revokingPairingLinkId, setRevokingPairingLinkId] = useState<string | null>(null);
  const [revokingClientSessionId, setRevokingClientSessionId] = useState<string | null>(null);
  const [isRevokingOtherClients, setIsRevokingOtherClients] = useState(false);

  const pairingLinks = (() => {
    const event = accessChanges.data;
    if (event?.type !== "snapshot") return [];
    return sortDesktopPairingLinks(event.payload.pairingLinks.map(toDesktopPairingLinkRecord));
  })();
  const clientSessions = (() => {
    const event = accessChanges.data;
    if (event?.type !== "snapshot") return [];
    return sortDesktopClientSessions(
      event.payload.clientSessions.map(toDesktopClientSessionRecord),
    );
  })();

  const reportMutationFailure = (
    title: string,
    fallback: string,
    result: Extract<AtomCommandResult<unknown, unknown>, { _tag: "Failure" }>,
  ) => {
    if (isAtomCommandInterrupted(result)) return;
    const error = squashAtomCommandFailure(result);
    const message = error instanceof Error ? error.message : fallback;
    setMutationError(message);
    toastManager.add(stackedThreadToast({ type: "error", title, description: message }));
  };

  // The header action guards scopes and reports failures, as it does for the primary environment.
  const createPairingCredential = async (input: AuthCreatePairingCredentialInput) => {
    if (environmentId === null) throw new Error("This environment is unavailable.");
    setMutationError(null);
    const result = await createPairingLinkCommand({ environmentId, input });
    if (result._tag === "Failure") throw squashAtomCommandFailure(result);
    return result.value;
  };
  const onPairingLinkCreated = (created: AuthPairingCredentialResult) => {
    setCreatedPairingCredentials((current) => new Map(current).set(created.id, created.credential));
  };

  const revokePairingLink = async (id: string) => {
    if (environmentId === null || !readEnvironmentScope(environmentId, AuthAccessWriteScope))
      return;
    setRevokingPairingLinkId(id);
    setMutationError(null);
    const result = await revokePairingLinkCommand({ environmentId, input: { id } });
    if (result._tag === "Failure") {
      reportMutationFailure(
        "Could not revoke pairing link",
        "Failed to revoke pairing link.",
        result,
      );
    }
    setRevokingPairingLinkId(null);
  };

  const revokeClientSession = async (sessionId: ServerClientSessionRecord["sessionId"]) => {
    if (environmentId === null || !readEnvironmentScope(environmentId, AuthAccessWriteScope))
      return;
    setRevokingClientSessionId(sessionId);
    setMutationError(null);
    const result = await revokeClientCommand({ environmentId, input: { sessionId } });
    if (result._tag === "Failure") {
      reportMutationFailure(
        "Could not revoke client access",
        "Failed to revoke client access.",
        result,
      );
    }
    setRevokingClientSessionId(null);
  };

  const revokeOtherClients = async () => {
    if (environmentId === null || !readEnvironmentScope(environmentId, AuthAccessWriteScope))
      return;
    setIsRevokingOtherClients(true);
    setMutationError(null);
    const result = await revokeOtherClientsCommand({ environmentId, input: null });
    if (result._tag === "Failure") {
      reportMutationFailure(
        "Could not revoke other clients",
        "Failed to revoke other clients.",
        result,
      );
    } else {
      const { revokedCount } = result.value;
      toastManager.add({
        type: "success",
        title: revokedCount === 1 ? "Revoked 1 other client" : `Revoked ${revokedCount} clients`,
        description: "Other paired clients will need a new pairing link before reconnecting.",
      });
    }
    setIsRevokingOtherClients(false);
  };

  return {
    canReadAccess,
    canWriteAccess,
    delegatableScopes,
    error: mutationError ?? accessChanges.error,
    isLoading: accessChanges.isPending && accessChanges.data === null,
    // The list loaded cleanly, so "Revoke others" can tell whether anyone else is paired.
    hasSnapshot: accessChanges.error === null && accessChanges.data?.type === "snapshot",
    pairingLinks,
    clientSessions,
    createdPairingCredentials,
    revokingPairingLinkId,
    revokingClientSessionId,
    isRevokingOtherClients,
    createPairingCredential,
    onPairingLinkCreated,
    revokePairingLink,
    revokeClientSession,
    revokeOtherClients,
  };
}
