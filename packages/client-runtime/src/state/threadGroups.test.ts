import { describe, expect, it } from "vite-plus/test";

import { collectThreadGroups, partitionThreadsByGroup } from "./threadGroups.ts";

describe("partitionThreadsByGroup", () => {
  it("keeps sort order within each bucket and orders groups by name", () => {
    const threads = [
      { id: "a", group: "Infra" },
      { id: "b", group: null },
      { id: "c", group: "Billing" },
      { id: "d", group: "Infra" },
      { id: "e" },
    ];
    const { ungrouped, groups } = partitionThreadsByGroup(threads);
    expect(ungrouped.map((thread) => thread.id)).toEqual(["b", "e"]);
    expect(groups.map(({ group, threads }) => [group, threads.map((thread) => thread.id)])).toEqual(
      [
        ["Billing", ["c"]],
        ["Infra", ["a", "d"]],
      ],
    );
  });
});

describe("collectThreadGroups", () => {
  it("lists each group once in display order", () => {
    expect(
      collectThreadGroups([
        { group: "Infra" },
        { group: null },
        { group: "Billing" },
        { group: "Infra" },
      ]),
    ).toEqual(["Billing", "Infra"]);
  });
});
