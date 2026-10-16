import type { IssueState } from "@t3tools/contracts";
import type { AppSymbolName } from "../../components/ui/AppSymbol";

const STATES = {
  open: {
    label: "Open",
    icon: "circle.inset.filled",
    tint: "accent-adaptive-emerald-600-400",
    text: "text-adaptive-emerald-600-400",
  },
  closed: {
    label: "Closed",
    icon: "checkmark.circle",
    tint: "accent-adaptive-violet-600-400",
    text: "text-adaptive-violet-600-400",
  },
} satisfies Record<IssueState, { label: string; icon: AppSymbolName; tint: string; text: string }>;

export function issueStatus(state: IssueState) {
  return STATES[state];
}
