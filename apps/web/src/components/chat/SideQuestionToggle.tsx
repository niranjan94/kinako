import { useAtomValue } from "@effect/atom-react";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { MessageSquareDashedIcon } from "lucide-react";
import { sideChatThreadIdAtom } from "../../state/sideChats";
import { useRightPanelStore } from "../../rightPanelStore";
import { Toggle } from "../ui/toggle";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export function SideQuestionToggle({
  threadRef,
  open,
}: {
  threadRef: ScopedThreadRef;
  open: boolean;
}) {
  const hasConversation = useAtomValue(sideChatThreadIdAtom(scopedThreadKey(threadRef))) !== null;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Toggle
            variant="ghost"
            size="sm"
            pressed={open}
            aria-label="Ask a side question"
            onPressedChange={() => useRightPanelStore.getState().toggle(threadRef, "side-chat")}
          >
            <MessageSquareDashedIcon className="size-4" />
            {hasConversation && !open ? (
              <span
                aria-hidden
                className="absolute top-1 right-1 size-1 rounded-full bg-muted-foreground"
              />
            ) : null}
          </Toggle>
        }
      />
      <TooltipPopup side="bottom">Ask a side question</TooltipPopup>
    </Tooltip>
  );
}
