import { useAtomValue } from "@effect/atom-react";
import { hasNewSnoozeWake } from "@t3tools/client-runtime/state/thread-settled";
import type { EnvironmentId, OrchestrationV2ThreadShell, ThreadId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Notifications from "expo-notifications";
import { useEffect, useRef } from "react";
import { AppState } from "react-native";

import { useEnvironments } from "../../state/environments";
import { environmentShell } from "../../state/shell";

export function SnoozeWakeNotifications() {
  const { environments } = useEnvironments();
  return environments.map(({ environmentId }) => (
    <EnvironmentSnoozeWakeNotifications key={environmentId} environmentId={environmentId} />
  ));
}

function EnvironmentSnoozeWakeNotifications({ environmentId }: { environmentId: EnvironmentId }) {
  const shell = useAtomValue(environmentShell.stateValueAtom(environmentId));
  const threads =
    shell.status === "live" && Option.isSome(shell.snapshot) ? shell.snapshot.value.threads : null;
  const previous = useRef(new Map<ThreadId, OrchestrationV2ThreadShell>());
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- posts a local notification when the server reports a new snooze wake
  useEffect(() => {
    if (threads === null) {
      previous.current.clear();
      return;
    }
    const prior = previous.current;
    previous.current = new Map(threads.map((thread) => [thread.id, thread]));
    if (AppState.currentState !== "active") return;
    for (const thread of threads) {
      const before = prior.get(thread.id);
      if (
        !before ||
        thread.archivedAt !== null ||
        thread.deletedAt !== null ||
        !hasNewSnoozeWake(before.snoozeWakeNotifiedAt, thread.snoozeWakeNotifiedAt)
      )
        continue;
      // Local delivery uses the same foreground suppression and tap navigation
      // as relay notifications, and respects device notification permission.
      void Notifications.scheduleNotificationAsync({
        content: {
          title: "Snooze ended",
          body: thread.title,
          data: { environmentId, threadId: thread.id },
        },
        trigger: null,
      }).catch(() => undefined);
    }
  }, [environmentId, threads]);
  return null;
}
