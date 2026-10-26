import type { AnyRouter } from "@tanstack/react-router";
import type { ClientSettings } from "@t3tools/contracts/settings";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import { Atom, AtomRegistry } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

import { stubGlobal } from "../../test/render";

const state = vi.hoisted(() => ({
  mode: "off" as ClientSettings["notificationMode"],
  active: { environmentId: "env-1", threadId: "other-thread" },
  focused: true,
  add: vi.fn(
    (_toast: { title: string; description: string; actionProps: { onClick: () => void } }) =>
      "toast-1",
  ),
  close: vi.fn(),
  navigate: vi.fn(),
  sound: vi.fn(),
  notification: vi.fn(function (_title: string, options: NotificationOptions) {
    return Object.assign(new EventTarget(), { tag: options.tag, close: vi.fn() });
  }),
}));

vi.mock(import("../state/shell"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    environmentShell: {
      ...actual.environmentShell,
      stateValueAtom: ((id: string) => shellAtom(id)) as never,
    },
  };
});
vi.mock(import("../state/presentation"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    environmentSummaries: {
      ...actual.environmentSummaries,
      // Read lazily: the factory runs before this module's own bindings exist.
      get environmentIdsAtom() {
        return environmentIdsAtom as never;
      },
    },
  };
});
vi.mock(import("../hooks/useSettings"), async (original) => ({
  ...(await original()),
  subscribeClientSettings: (() => () => undefined) as never,
  getClientSettings: (() => ({
    notificationMode: state.mode,
    inAppNotificationsEnabled: true,
  })) as never,
}));
vi.mock(import("../threadNotifications"), async (original) => ({
  ...(await original()),
  playNotificationSound: state.sound,
  unlockNotificationAudio: vi.fn(),
  setNotificationBadge: vi.fn(),
}));
vi.mock(import("./ui/toast"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    toastManager: { ...actual.toastManager, add: state.add as never, close: state.close },
  };
});

import { startThreadNotifications } from "./ThreadNotificationCoordinator";

const shellAtom = Atom.family((_id: string) => Atom.make<unknown>(null));
const environmentIdsAtom = Atom.make<ReadonlyArray<string>>([]);

const SHELL_NOW = DateTime.makeUnsafe("2026-09-13T09:00:00.000Z");
const WAKE_AT = "2026-09-13T10:00:00.000Z";

function threadShell(wakeAt: string | null) {
  return {
    id: "thread-1",
    projectId: "project-1",
    title: "Fix the login form",
    providerInstanceId: "codex",
    modelSelection: { instanceId: "codex", model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: { rootThreadId: "thread-1", parentThreadId: null, relationshipToParent: null },
    forkedFrom: null,
    createdBy: "user",
    creationSource: "web",
    latestRunId: "run-1",
    activeRunId: null,
    status: "running",
    lastErrorClass: null,
    pendingRuntimeRequest: null,
    latestVisibleMessage: null,
    latestUserMessageAt: null,
    hasActionableProposedPlan: false,
    pendingBackgroundTasks: [],
    itemCount: 0,
    visibleItemCount: 0,
    createdAt: SHELL_NOW,
    updatedAt: SHELL_NOW,
    latestRunRequestedAt: SHELL_NOW,
    latestRunStartedAt: SHELL_NOW,
    latestRunCompletedAt: undefined,
    snoozeWakeNotifiedAt: wakeAt ? DateTime.makeUnsafe(wakeAt) : null,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  };
}

const liveShell = (wakeAt: string | null) => ({
  status: "live",
  snapshot: Option.some({ threads: [threadShell(wakeAt)] }),
});

// The mocked modules read `state`, so every test resets it before starting the service.
function setup() {
  vi.clearAllMocks();
  Object.assign(state, {
    mode: "off",
    active: { environmentId: "env-1", threadId: "other-thread" },
    focused: true,
  });
  const stack = new AsyncDisposableStack();
  const registry = AtomRegistry.make();
  stack.defer(() => registry.dispose());
  registry.set(environmentIdsAtom, ["env-1"]);
  stack.use(vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible"));
  stack.use(vi.spyOn(document, "hasFocus").mockImplementation(() => state.focused));
  stack.use(
    stubGlobal("Notification", Object.assign(state.notification, { permission: "granted" })),
  );
  const router = {
    get state() {
      return { matches: [{ params: state.active }] };
    },
    navigate: state.navigate,
  } as unknown as AnyRouter;
  return {
    start: () => {
      stack.defer(startThreadNotifications(registry, router));
    },
    setShell: (value: unknown) => registry.set(shellAtom("env-1"), value),
    [Symbol.asyncDispose]: () => stack.disposeAsync(),
  };
}

describe("snooze reminders", () => {
  it.each(["off", "notifications", "sound", "notifications-and-sound"] as const)(
    "respects %s mode and opens the thread",
    async (mode) => {
      await using app = setup();
      state.mode = mode;
      app.setShell(liveShell(null));
      app.start();
      app.setShell(liveShell(WAKE_AT));
      app.setShell(liveShell(WAKE_AT));
      expect(state.add).toHaveBeenCalledTimes(1);
      expect(state.add.mock.calls[0]?.[0].title).toBe("Snooze ended");
      expect(state.sound).toHaveBeenCalledTimes(
        mode === "sound" || mode === "notifications-and-sound" ? 1 : 0,
      );
      state.add.mock.calls[0]?.[0].actionProps.onClick();
      expect(state.navigate).toHaveBeenCalledWith({
        to: "/$environmentId/$threadId",
        params: { environmentId: "env-1", threadId: "thread-1" },
      });
    },
  );
  it.each(["off", "notifications", "sound", "notifications-and-sound"] as const)(
    "respects %s in the background",
    async (mode) => {
      await using app = setup();
      state.mode = mode;
      state.focused = false;
      app.setShell(liveShell(null));
      app.start();
      app.setShell(liveShell(WAKE_AT));
      expect(state.add).not.toHaveBeenCalled();
      expect(state.notification).toHaveBeenCalledTimes(
        mode === "notifications" || mode === "notifications-and-sound" ? 1 : 0,
      );
    },
  );
  it("suppresses the focused thread, including sound", async () => {
    await using app = setup();
    state.mode = "notifications-and-sound";
    state.active.threadId = "thread-1";
    app.setShell(liveShell(null));
    app.start();
    app.setShell(liveShell(WAKE_AT));
    expect(state.add).not.toHaveBeenCalled();
    expect(state.sound).not.toHaveBeenCalled();
    expect(state.notification).not.toHaveBeenCalled();
  });
  it("does not replay a persisted announcement on load or reconnect", async () => {
    await using app = setup();
    app.setShell(liveShell(WAKE_AT));
    app.start();
    app.setShell({ status: "disconnected", snapshot: Option.none() });
    app.setShell(liveShell(WAKE_AT));
    expect(state.add).not.toHaveBeenCalled();
  });
});
