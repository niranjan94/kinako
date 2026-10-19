import { parseScopedThreadKey } from "@t3tools/client-runtime/environment";
import { Atom } from "effect/reactivity";
import { environmentThreadShells } from "./threads";
import { findSideChatThreadId } from "../components/chat/sideChat.logic";

export const sideChatThreadIdAtom = Atom.family((parentKey: string) =>
  Atom.make((get) => {
    const parent = parseScopedThreadKey(parentKey);
    return parent === null
      ? null
      : findSideChatThreadId(get(environmentThreadShells.threadShellsAtom), parent);
  }),
);
