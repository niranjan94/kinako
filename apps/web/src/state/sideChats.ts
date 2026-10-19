import { parseScopedThreadKey } from "@t3tools/client-runtime/environment";
import { findLatestSideChat } from "@t3tools/client-runtime/state/side-chats";
import { Atom } from "effect/reactivity";
import { environmentThreadShells } from "./threads";

export const latestSideChatAtom = Atom.family((parentKey: string) =>
  Atom.make((get) => {
    const parent = parseScopedThreadKey(parentKey);
    return parent === null
      ? null
      : findLatestSideChat(get(environmentThreadShells.threadShellsAtom), parent);
  }),
);
