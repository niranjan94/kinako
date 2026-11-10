import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import {
  threadRuntimeIsActive,
  type EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import type { ScopedThreadRef } from "@t3tools/contracts";

const indexOf = (tabs: readonly ScopedThreadRef[], ref: ScopedThreadRef) => {
  const key = scopedThreadKey(ref);
  return tabs.findIndex((tab) => scopedThreadKey(tab) === key);
};

export function addTab(tabs: readonly ScopedThreadRef[], ref: ScopedThreadRef) {
  return indexOf(tabs, ref) === -1 ? [...tabs, ref] : tabs;
}

/** Browser-style successor: the right neighbor, else the new last tab. */
export function closeTab(
  tabs: readonly ScopedThreadRef[],
  ref: ScopedThreadRef,
): { tabs: readonly ScopedThreadRef[]; successor: ScopedThreadRef | null } {
  const index = indexOf(tabs, ref);
  if (index === -1) return { tabs, successor: null };
  const next = tabs.filter((_, i) => i !== index);
  return { tabs: next, successor: next[index] ?? next.at(-1) ?? null };
}

export function moveTab(tabs: readonly ScopedThreadRef[], from: number, to: number) {
  if (from === to || !tabs[from] || to < 0 || to >= tabs.length) return tabs;
  const next = [...tabs];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved!);
  return next;
}

export function adjacentTab(
  tabs: readonly ScopedThreadRef[],
  current: ScopedThreadRef | null,
  direction: "previous" | "next",
): ScopedThreadRef | null {
  if (tabs.length === 0) return null;
  const index = current ? indexOf(tabs, current) : -1;
  if (index === -1) return direction === "next" ? tabs[0]! : tabs.at(-1)!;
  const step = direction === "next" ? 1 : -1;
  return tabs[(index + step + tabs.length) % tabs.length]!;
}

export interface TabOwnerState {
  environmentKnown: boolean;
  catalogReady: boolean;
  /** The environment's shell snapshot is live, so a missing thread is really gone. */
  shellLive: boolean;
  threadExists: boolean;
}

/** Drops only tabs known to be gone; an offline or still-loading environment keeps its tabs. */
export function pruneTabs(
  tabs: readonly ScopedThreadRef[],
  ownerState: (ref: ScopedThreadRef) => TabOwnerState,
) {
  const next = tabs.filter((ref) => {
    const owner = ownerState(ref);
    if (!owner.environmentKnown) return !owner.catalogReady;
    return owner.threadExists || !owner.shellLive;
  });
  return next.length === tabs.length ? tabs : next;
}

/** What a thread tab's dot shows and its title's accessible name says. */
export function threadTabState(shell: EnvironmentThreadShell | null) {
  if (shell === null) return null;
  if (shell.hasPendingApprovals || shell.pendingSubagentRequest === "approval") {
    return "needs approval";
  }
  if (shell.hasPendingUserInput || shell.pendingSubagentRequest === "user_input") {
    return "needs input";
  }
  return threadRuntimeIsActive(shell.runtime) ? "running" : null;
}
