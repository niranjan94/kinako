import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { addTab, adjacentTab, closeTab, moveTab, pruneTabs } from "./openThreadTabs.logic";

const ref = (environment: string, thread: string) =>
  scopeThreadRef(EnvironmentId.make(environment), ThreadId.make(thread));
const a = ref("local", "a");
const b = ref("local", "b");
const c = ref("local", "c");
const sameThreadOtherEnvironment = ref("remote", "a");

describe("open thread tabs", () => {
  it("adds a thread last and keeps an open one in place", () => {
    const tabs = addTab(addTab([], a), b);
    expect(tabs).toEqual([a, b]);
    expect(addTab(tabs, ref("local", "a"))).toBe(tabs);
    expect(addTab(tabs, sameThreadOtherEnvironment)).toEqual([a, b, sameThreadOtherEnvironment]);
  });

  it("picks the right neighbor after a close, else the new last tab", () => {
    expect(closeTab([a, b, c], b)).toEqual({ tabs: [a, c], successor: c });
    expect(closeTab([a, b, c], c)).toEqual({ tabs: [a, b], successor: b });
    expect(closeTab([a], a)).toEqual({ tabs: [], successor: null });
    const tabs = [a, b];
    expect(closeTab(tabs, c)).toEqual({ tabs, successor: null });
  });

  it("reorders and ignores moves out of range", () => {
    expect(moveTab([a, b, c], 0, 2)).toEqual([b, c, a]);
    const tabs = [a, b];
    expect(moveTab(tabs, 0, 5)).toBe(tabs);
  });

  it("walks tabs in both directions and wraps around", () => {
    expect(adjacentTab([a, b, c], c, "next")).toBe(a);
    expect(adjacentTab([a, b, c], a, "previous")).toBe(c);
    expect(adjacentTab([a, b, c], null, "previous")).toBe(c);
    expect(adjacentTab([], a, "next")).toBeNull();
  });

  it("prunes only tabs known to be gone", () => {
    const deleted = ref("local", "deleted");
    const offline = ref("offline", "x");
    const removed = ref("removed", "y");
    const tabs = [a, deleted, offline, removed];
    const owner = (catalogReady: boolean) => (tab: typeof a) => ({
      environmentKnown: tab.environmentId !== removed.environmentId,
      catalogReady,
      shellLive: tab.environmentId === a.environmentId,
      threadExists: tab !== deleted,
    });
    expect(pruneTabs(tabs, owner(false))).toEqual([a, offline, removed]);
    expect(pruneTabs(tabs, owner(true))).toEqual([a, offline]);
    const kept = [a];
    expect(pruneTabs(kept, owner(true))).toBe(kept);
  });
});
