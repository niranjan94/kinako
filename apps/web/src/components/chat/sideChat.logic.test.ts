import {
  EnvironmentId,
  MessageId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2ProjectedTurnItem,
} from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";
import { findSideChatThreadId, sideChatMessages } from "./sideChat.logic";

const parent = scopeThreadRef(EnvironmentId.make("local"), ThreadId.make("parent"));
const sideId = ThreadId.make("side");
const side = {
  id: sideId,
  environmentId: parent.environmentId,
  isSideChat: true,
  archivedAt: null,
  deletedAt: null,
  createdAt: "2026-10-19T00:00:00Z",
  lineage: {
    rootThreadId: parent.threadId,
    parentThreadId: parent.threadId,
    relationshipToParent: "fork" as const,
  },
};

describe("side chat selection", () => {
  it("reopens the most recent side chat for the exact conversation and environment", () => {
    const newer = { ...side, id: ThreadId.make("newer"), createdAt: "2026-10-20T00:00:00Z" };
    expect(
      findSideChatThreadId(
        [
          side,
          newer,
          { ...newer, id: ThreadId.make("remote"), environmentId: EnvironmentId.make("remote") },
          {
            ...newer,
            id: ThreadId.make("other-parent"),
            lineage: { ...side.lineage, parentThreadId: ThreadId.make("other") },
          },
        ],
        parent,
      ),
    ).toBe(newer.id);
  });

  it("does not reopen promoted, archived, or deleted chats", () => {
    expect(
      findSideChatThreadId(
        [
          { ...side, isSideChat: false },
          { ...side, archivedAt: "2026-10-20T00:00:00Z" },
          { ...side, deletedAt: "2026-10-20T00:00:00Z" },
        ],
        parent,
      ),
    ).toBeNull();
  });
});

it("shows only side-chat messages, keeping inherited history out of the compact panel", () => {
  const itemId = TurnItemId.make("answer");
  const answer: OrchestrationV2ProjectedTurnItem = {
    position: 1,
    visibility: "local",
    sourceThreadId: sideId,
    sourceItemId: itemId,
    item: {
      id: itemId,
      threadId: sideId,
      runId: null,
      nodeId: null,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 1,
      status: "running",
      title: null,
      startedAt: null,
      completedAt: null,
      updatedAt: DateTime.makeUnsafe("2026-10-19T00:00:00Z"),
      type: "assistant_message",
      messageId: MessageId.make("answer"),
      text: "An answer in progress",
      streaming: true,
    },
  };
  const inherited = {
    ...answer,
    position: 0,
    sourceThreadId: parent.threadId,
    visibility: "inherited" as const,
  };
  expect(sideChatMessages([inherited, answer], sideId)).toEqual([answer.item]);
  expect(sideChatMessages([inherited, answer], null)).toEqual([]);
});
