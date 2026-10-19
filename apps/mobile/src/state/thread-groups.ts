import { collectThreadGroups } from "@t3tools/client-runtime/state/thread-groups";
import * as Option from "effect/Option";
import { Atom } from "effect/reactivity";

import { environmentThreadShells } from "./threads";

// Rows read the names from here, so the array must keep its identity while
// shells stream in; otherwise every row would re-render on each event.
export const threadGroupNamesAtom = Atom.make((get) => {
  const next = collectThreadGroups(get(environmentThreadShells.threadShellsAtom));
  const previous = Option.getOrNull(get.self<readonly string[]>());
  return previous !== null &&
    previous.length === next.length &&
    previous.every((group, index) => group === next[index])
    ? previous
    : next;
});
