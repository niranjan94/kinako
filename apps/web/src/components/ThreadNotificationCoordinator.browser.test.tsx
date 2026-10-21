import type { ClientSettings } from "@t3tools/contracts/settings";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import { describe, expect, it, vi } from "vite-plus/test";

import { render, stubGlobal, type Screen } from "../../test/render";

const state = vi.hoisted(() => ({
  mode: "off" as ClientSettings["notificationMode"],
  active: { environmentId: "env-1", threadId: "other-thread" },
  focused: true,
  live: true,
  wakeAt: null as string | null,
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

const SHELL_NOW = DateTime.makeUnsafe("2026-09-13T09:00:00.000Z");

function mockThreadShell() {
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
    snoozeWakeNotifiedAt: state.wakeAt ? DateTime.makeUnsafe(state.wakeAt) : null,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  };
}

vi.mock(import("@effect/atom-react"), async (original) => ({
  ...(await original()),
  useAtomValue: (() => ({
    status: state.live ? "live" : "disconnected",
    snapshot: Option.some({ threads: [mockThreadShell()] }),
  })) as never,
}));
vi.mock(import("@tanstack/react-router"), async (original) => ({
  ...(await original()),
  useNavigate: (() => state.navigate) as never,
  useParams: (() => state.active) as never,
}));
vi.mock(import("../hooks/useSettings"), async (original) => ({
  ...(await original()),
  useClientSettings: ((
    select: (
      settings: Pick<ClientSettings, "notificationMode" | "inAppNotificationsEnabled">,
    ) => unknown,
  ) => select({ notificationMode: state.mode, inAppNotificationsEnabled: true })) as never,
  getClientSettings: (() => ({ notificationMode: state.mode })) as never,
}));
vi.mock(import("../state/environments"), async (original) => ({
  ...(await original()),
  useEnvironmentIds: (() => ["env-1"]) as never,
}));
vi.mock(import("../threadNotifications"), async (original) => ({
  ...(await original()),
  playNotificationSound: state.sound,
  setNotificationBadge: vi.fn(),
}));
vi.mock(import("./ui/toast"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    toastManager: { ...actual.toastManager, add: state.add as never, close: state.close },
  };
});

import { ThreadNotificationCoordinator } from "./ThreadNotificationCoordinator";

// The mocked modules read `state`, so every test starts by resetting all of it. The first
// render is left to the test because some tests change state before the coordinator mounts.
function setup() {
  vi.clearAllMocks();
  Object.assign(state, {
    mode: "off",
    active: { environmentId: "env-1", threadId: "other-thread" },
    focused: true,
    live: true,
    wakeAt: null,
  });
  const stack = new AsyncDisposableStack();
  stack.use(vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible"));
  stack.use(vi.spyOn(document, "hasFocus").mockImplementation(() => state.focused));
  stack.use(
    stubGlobal("Notification", Object.assign(state.notification, { permission: "granted" })),
  );
  let screen: Screen | undefined;
  const renderCoordinator = async () => {
    if (screen) await screen.rerender(<ThreadNotificationCoordinator />);
    else screen = stack.use(await render(<ThreadNotificationCoordinator />));
  };
  return {
    render: renderCoordinator,
    [Symbol.asyncDispose]: () => stack.disposeAsync(),
  };
}

describe("snooze reminders", () => {
  it.each(["off", "notifications", "sound", "notifications-and-sound"] as const)(
    "respects %s mode and opens the thread",
    async (mode) => {
      await using app = setup();
      state.mode = mode;
      await app.render();
      state.wakeAt = "2026-09-13T10:00:00.000Z";
      await app.render();
      await app.render();
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
      await app.render();
      state.wakeAt = "2026-09-13T10:00:00.000Z";
      await app.render();
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
    await app.render();
    state.wakeAt = "2026-09-13T10:00:00.000Z";
    await app.render();
    expect(state.add).not.toHaveBeenCalled();
    expect(state.sound).not.toHaveBeenCalled();
    expect(state.notification).not.toHaveBeenCalled();
  });
  it("does not replay a persisted announcement on load or reconnect", async () => {
    await using app = setup();
    state.wakeAt = "2026-09-13T10:00:00.000Z";
    await app.render();
    state.live = false;
    await app.render();
    state.live = true;
    await app.render();
    expect(state.add).not.toHaveBeenCalled();
  });
});
