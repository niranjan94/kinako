import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  clampRatio,
  focusAfterRemove,
  leaves,
  nextPaneThread,
  type PaneNode,
  removePane,
  replacePaneThread,
  resizeSplit,
  splitPane,
} from "./splitView.logic";

const ref = (thread: string) => scopeThreadRef(EnvironmentId.make("local"), ThreadId.make(thread));
const leaf = (id: string, thread: string): PaneNode => ({
  kind: "leaf",
  id,
  threadRef: ref(thread),
});
const threads = (node: PaneNode | null) =>
  node ? leaves(node).map((l) => l.threadRef.threadId) : [];

describe("split view panes", () => {
  it("splits a leaf, caps the tree at a 2x2 grid, and keeps one pane per thread", () => {
    let root = splitPane(leaf("a", "1"), "a", "row", ref("2"), { split: "s1", leaf: "b" });
    root = splitPane(root, "a", "column", ref("3"), { split: "s2", leaf: "c" });
    root = splitPane(root, "b", "column", ref("4"), { split: "s3", leaf: "d" });
    expect(threads(root)).toEqual(["1", "3", "2", "4"]);
    expect(splitPane(root, "c", "row", ref("5"), { split: "s4", leaf: "e" })).toBe(root);
    const two = splitPane(leaf("a", "1"), "a", "row", ref("2"), { split: "s1", leaf: "b" });
    expect(splitPane(two, "a", "row", ref("2"), { split: "s2", leaf: "c" })).toBe(two);
    expect(splitPane(two, "missing", "row", ref("3"), { split: "s2", leaf: "c" })).toBe(two);
  });

  it("collapses a split into the sibling when a pane is removed", () => {
    let root = splitPane(leaf("a", "1"), "a", "row", ref("2"), { split: "s1", leaf: "b" });
    root = splitPane(root, "b", "column", ref("3"), { split: "s2", leaf: "c" });
    const removed = removePane(root, "c")!;
    expect(removed).toEqual(
      splitPane(leaf("a", "1"), "a", "row", ref("2"), { split: "s1", leaf: "b" }),
    );
    expect(threads(removePane(removed, "a"))).toEqual(["2"]);
    expect(removePane(leaf("a", "1"), "a")).toBeNull();
  });

  it("moves focus to the removed pane's sibling only when it held focus", () => {
    let root = splitPane(leaf("a", "1"), "a", "row", ref("2"), { split: "s1", leaf: "b" });
    root = splitPane(root, "b", "column", ref("3"), { split: "s2", leaf: "c" });
    expect(focusAfterRemove(root, "a", "a")).toBe("b");
    expect(focusAfterRemove(root, "c", "c")).toBe("b");
    expect(focusAfterRemove(root, "c", "a")).toBe("a");
    expect(focusAfterRemove(leaf("a", "1"), "a", "a")).toBeNull();
  });

  it("clamps divider ratios", () => {
    const root = splitPane(leaf("a", "1"), "a", "row", ref("2"), { split: "s1", leaf: "b" });
    const ratio = (node: PaneNode) => (node.kind === "split" ? node.ratio : null);
    expect(ratio(resizeSplit(root, "s1", 0.1))).toBe(0.25);
    expect(ratio(resizeSplit(root, "s1", 0.9))).toBe(0.75);
    expect(ratio(resizeSplit(root, "s1", 0.4))).toBe(0.4);
    expect(clampRatio(Number.NaN)).toBe(0.5);
  });

  it("cycles focus through panes in reading order", () => {
    let root = splitPane(leaf("a", "1"), "a", "row", ref("2"), { split: "s1", leaf: "b" });
    root = splitPane(root, "b", "column", ref("3"), { split: "s2", leaf: "c" });
    expect(nextPaneThread(root, ref("1"))).toEqual(ref("2"));
    expect(nextPaneThread(root, ref("3"))).toEqual(ref("1"));
    expect(nextPaneThread(leaf("a", "1"), ref("1"))).toBeNull();
  });

  it("swaps a pane's thread unless another pane already shows it", () => {
    const root = splitPane(leaf("a", "1"), "a", "row", ref("2"), { split: "s1", leaf: "b" });
    expect(threads(replacePaneThread(root, "a", ref("3")))).toEqual(["3", "2"]);
    expect(replacePaneThread(root, "a", ref("2"))).toBe(root);
  });
});
