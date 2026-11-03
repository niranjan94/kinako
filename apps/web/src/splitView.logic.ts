import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";

export type SplitDirection = "row" | "column";

export type PaneNode =
  | { readonly kind: "leaf"; readonly id: string; readonly threadRef: ScopedThreadRef }
  | {
      readonly kind: "split";
      readonly id: string;
      readonly direction: SplitDirection;
      /** Share of the space the first child takes. */
      readonly ratio: number;
      readonly first: PaneNode;
      readonly second: PaneNode;
    };

/** Two levels of splits: at most a 2x2 grid. */
export const MAX_SPLIT_DEPTH = 2;
const MIN_RATIO = 0.25;
const MAX_RATIO = 0.75;

export const clampRatio = (ratio: number) =>
  Number.isFinite(ratio) ? Math.min(MAX_RATIO, Math.max(MIN_RATIO, ratio)) : 0.5;

export function leaves(node: PaneNode): Extract<PaneNode, { kind: "leaf" }>[] {
  return node.kind === "leaf" ? [node] : [...leaves(node.first), ...leaves(node.second)];
}

export function findLeafByThread(node: PaneNode, ref: ScopedThreadRef) {
  const key = scopedThreadKey(ref);
  return leaves(node).find((leaf) => scopedThreadKey(leaf.threadRef) === key) ?? null;
}

function depthOf(node: PaneNode, id: string, depth = 0): number | null {
  if (node.id === id) return depth;
  if (node.kind === "leaf") return null;
  return depthOf(node.first, id, depth + 1) ?? depthOf(node.second, id, depth + 1);
}

function mapNode(node: PaneNode, id: string, update: (node: PaneNode) => PaneNode): PaneNode {
  if (node.id === id) return update(node);
  if (node.kind === "leaf") return node;
  const first = mapNode(node.first, id, update);
  const second = mapNode(node.second, id, update);
  return first === node.first && second === node.second ? node : { ...node, first, second };
}

/**
 * Splits a leaf, putting `threadRef` in the new second half. Returns the tree unchanged when the
 * leaf is already at the depth cap, is missing, or the thread already has a pane.
 */
export function splitPane(
  root: PaneNode,
  paneId: string,
  direction: SplitDirection,
  threadRef: ScopedThreadRef,
  ids: { split: string; leaf: string },
): PaneNode {
  const depth = depthOf(root, paneId);
  if (depth === null || depth >= MAX_SPLIT_DEPTH || findLeafByThread(root, threadRef)) return root;
  return mapNode(root, paneId, (leaf) =>
    leaf.kind !== "leaf"
      ? leaf
      : {
          kind: "split",
          id: ids.split,
          direction,
          ratio: 0.5,
          first: leaf,
          second: { kind: "leaf", id: ids.leaf, threadRef },
        },
  );
}

/** Removes a leaf; its sibling takes the parent's place. Removing the last leaf returns null. */
export function removePane(root: PaneNode, paneId: string): PaneNode | null {
  if (root.id === paneId) return null;
  if (root.kind === "leaf") return root;
  if (root.first.id === paneId) return root.second;
  if (root.second.id === paneId) return root.first;
  const first = removePane(root.first, paneId)!;
  const second = removePane(root.second, paneId)!;
  return first === root.first && second === root.second ? root : { ...root, first, second };
}

export function resizeSplit(root: PaneNode, splitId: string, ratio: number): PaneNode {
  return mapNode(root, splitId, (node) =>
    node.kind === "split" ? { ...node, ratio: clampRatio(ratio) } : node,
  );
}

export function replacePaneThread(
  root: PaneNode,
  paneId: string,
  threadRef: ScopedThreadRef,
): PaneNode {
  const existing = findLeafByThread(root, threadRef);
  if (existing && existing.id !== paneId) return root;
  return mapNode(root, paneId, (node) => (node.kind === "leaf" ? { ...node, threadRef } : node));
}

/**
 * The pane to focus after `removedId` goes: the nearest leaf of its sibling, so focus stays where
 * the eye was. Null when the removed pane was the last one or was not focused.
 */
export function focusAfterRemove(
  root: PaneNode,
  removedId: string,
  focusedId: string | null,
): string | null {
  if (focusedId !== removedId) return focusedId;
  const sibling = (node: PaneNode): PaneNode | null => {
    if (node.kind === "leaf") return null;
    if (node.first.id === removedId) return node.second;
    if (node.second.id === removedId) return node.first;
    return sibling(node.first) ?? sibling(node.second);
  };
  const next = sibling(root);
  return next ? leaves(next)[0]!.id : null;
}
