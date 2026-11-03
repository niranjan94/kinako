import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import { leaves } from "./splitView.logic";
import { useSplitViewStore } from "./splitViewStore";

const ref = (thread: string) => scopeThreadRef(EnvironmentId.make("local"), ThreadId.make(thread));
const shown = () => {
  const { root, focusedPaneId } = useSplitViewStore.getState();
  if (!root) return { threads: [], focused: null };
  const all = leaves(root);
  return {
    threads: all.map((leaf) => leaf.threadRef.threadId as string),
    focused: all.find((leaf) => leaf.id === focusedPaneId)?.threadRef.threadId ?? null,
  };
};

beforeEach(() => {
  useSplitViewStore.setState({ root: null, focusedPaneId: null });
});

describe("splitViewStore", () => {
  it("starts a split from the current thread and focuses the new pane", () => {
    const store = useSplitViewStore.getState();
    store.split(ref("1"), "row", ref("2"));
    expect(shown()).toEqual({ threads: ["1", "2"], focused: "2" });
    store.split(ref("2"), "column", ref("3"));
    expect(shown()).toEqual({ threads: ["1", "2", "3"], focused: "3" });
  });

  it("follows navigation: focuses a shown thread, else swaps the focused pane", () => {
    const store = useSplitViewStore.getState();
    store.split(ref("1"), "row", ref("2"));
    store.followRoute(ref("1"));
    expect(shown()).toEqual({ threads: ["1", "2"], focused: "1" });
    store.followRoute(ref("9"));
    expect(shown()).toEqual({ threads: ["9", "2"], focused: "9" });
  });

  it("ends the split when one pane is left and returns the thread to show", () => {
    const store = useSplitViewStore.getState();
    store.split(ref("1"), "row", ref("2"));
    store.split(ref("2"), "column", ref("3"));
    const focusedId = useSplitViewStore.getState().focusedPaneId!;
    expect(store.close(focusedId)).toEqual(ref("2"));
    expect(shown()).toEqual({ threads: ["1", "2"], focused: "2" });
    expect(store.close(useSplitViewStore.getState().focusedPaneId!)).toEqual(ref("1"));
    expect(useSplitViewStore.getState().root).toBeNull();
  });

  it("drops malformed or over-deep layouts saved by earlier versions", async () => {
    const { storage, name } = useSplitViewStore.persist.getOptions();
    const leaf = (id: string) => ({ kind: "leaf", id, threadRef: ref(id) });
    const split = (id: string, first: unknown, second: unknown) => ({
      kind: "split",
      id,
      direction: "row",
      ratio: 0.5,
      first,
      second,
    });
    for (const root of [
      { kind: "leaf", id: "a" },
      split("s1", leaf("a"), null),
      split("s1", split("s2", split("s3", leaf("a"), leaf("b")), leaf("c")), leaf("d")),
      leaf("a"),
    ]) {
      await storage!.setItem(name!, { state: { root, focusedPaneId: "a" }, version: 0 });
      await useSplitViewStore.persist.rehydrate();
      expect(useSplitViewStore.getState().root).toBeNull();
    }
    await storage!.setItem(name!, {
      state: { root: split("s1", leaf("a"), leaf("b")), focusedPaneId: "gone" },
      version: 0,
    });
    await useSplitViewStore.persist.rehydrate();
    expect(shown()).toEqual({ threads: ["a", "b"], focused: "a" });
  });
});
