interface GroupedThread {
  readonly group?: string | null | undefined;
  readonly archivedAt?: string | null | undefined;
}

export interface ThreadGroupBucket<T> {
  readonly group: string;
  readonly threads: readonly T[];
}

const compareGroups = (left: string, right: string) => left.localeCompare(right);

/** Distinct group names of unarchived threads, in display order. */
export function collectThreadGroups(threads: Iterable<GroupedThread>): string[] {
  const groups = new Set<string>();
  for (const thread of threads) {
    if (thread.group != null && thread.archivedAt == null) groups.add(thread.group);
  }
  return [...groups].sort(compareGroups);
}

/**
 * Splits an already sorted list into ungrouped threads and named groups. Groups
 * exist only through their threads, so same-named groups from different
 * environments merge into one bucket.
 */
export function partitionThreadsByGroup<T extends GroupedThread>(
  threads: readonly T[],
): { readonly ungrouped: readonly T[]; readonly groups: ReadonlyArray<ThreadGroupBucket<T>> } {
  const ungrouped: T[] = [];
  const byGroup = new Map<string, T[]>();
  for (const thread of threads) {
    if (thread.group == null) {
      ungrouped.push(thread);
      continue;
    }
    const bucket = byGroup.get(thread.group);
    if (bucket === undefined) byGroup.set(thread.group, [thread]);
    else bucket.push(thread);
  }
  return {
    ungrouped,
    groups: [...byGroup.keys()]
      .sort(compareGroups)
      .map((group) => ({ group, threads: byGroup.get(group)! })),
  };
}
