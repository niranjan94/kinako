import { useAtomValue } from "@effect/atom-react";
import {
  closestCenter,
  DndContext,
  type DragEndEvent,
  PointerSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { restrictToFirstScrollableAncestor, restrictToHorizontalAxis } from "@dnd-kit/modifiers";
import { horizontalListSortingStrategy, SortableContext, useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { MessageSquare } from "lucide-react";
import { useEffect, useEffectEvent } from "react";

import { useClosedViewStore } from "~/closedViewStore";
import { isCommandPaletteOpen } from "~/commandPaletteBus";
import { environmentCatalog } from "~/connection/catalog";
import { isElectron } from "~/env";
import { resolveShortcutCommand } from "~/keybindings";
import { isTerminalFocused } from "~/lib/terminalFocus";
import { cn } from "~/lib/utils";
import { isModelPickerOpen } from "~/modelPickerVisibility";
import { adjacentTab, threadTabState } from "~/openThreadTabs.logic";
import { useOpenThreadTabsStore } from "~/openThreadTabsStore";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { readThreadShell, useQuietThreadShell } from "~/state/entities";
import { primaryServerKeybindingsAtom } from "~/state/server";
import { environmentShell } from "~/state/shell";
import { buildThreadRouteParams } from "~/threadRoutes";
import { PanelTabCloseButton } from "../ui/panel-tab-close-button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

const DRAG_MODIFIERS = [restrictToHorizontalAxis, restrictToFirstScrollableAncestor];

type Navigate = ReturnType<typeof useNavigate>;

const openThread = (navigate: Navigate, ref: ScopedThreadRef) =>
  void navigate({ to: "/$environmentId/$threadId", params: buildThreadRouteParams(ref) });

/** Closes a tab so `view.reopenClosed` can bring it back; leaving the visible one shows its successor. */
export function closeThreadTab(navigate: Navigate, ref: ScopedThreadRef, visible: boolean) {
  useClosedViewStore.getState().remember({ kind: "thread-tab", threadRef: ref });
  const successor = useOpenThreadTabsStore.getState().close(ref);
  if (!visible) return;
  if (successor) openThread(navigate, successor);
  else void navigate({ to: "/" });
}

const shellLive = (ref: ScopedThreadRef) =>
  appAtomRegistry.get(environmentShell.stateValueAtom(ref.environmentId)).status === "live";

/** Browser-style strip of open threads. Reads thread shells only, so tabs open no extra streams. */
export function ThreadTabStrip({ activeThreadRef }: { activeThreadRef: ScopedThreadRef | null }) {
  const tabs = useOpenThreadTabsStore((state) => state.tabs);
  const navigate = useNavigate();
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const activeKey = activeThreadRef ? scopedThreadKey(activeThreadRef) : null;
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  const select = (ref: ScopedThreadRef) => openThread(navigate, ref);
  const close = (ref: ScopedThreadRef) =>
    closeThreadTab(navigate, ref, scopedThreadKey(ref) === activeKey);

  const environmentId = activeThreadRef?.environmentId;
  const threadId = activeThreadRef?.threadId;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- any navigation path can open a thread, so the route is the source of truth for adding its tab
  useEffect(() => {
    if (!environmentId || !threadId) return;
    const store = useOpenThreadTabsStore.getState();
    store.open(scopeThreadRef(environmentId, threadId));
    const catalog = appAtomRegistry.get(environmentCatalog.catalogValueAtom);
    store.prune((ref) => ({
      environmentKnown: catalog.entries.has(ref.environmentId),
      catalogReady: catalog.isReady,
      shellLive: shellLive(ref),
      threadExists: readThreadShell(ref) !== null,
    }));
  }, [environmentId, threadId]);

  const onKeyDown = useEffectEvent((event: KeyboardEvent) => {
    if (event.defaultPrevented || event.repeat || isCommandPaletteOpen() || isModelPickerOpen())
      return;
    const command = resolveShortcutCommand(event, keybindings, {
      context: {
        terminalFocus: isTerminalFocused(),
        modelPickerOpen: isModelPickerOpen(),
        isWeb: !isElectron,
        isDesktop: isElectron,
      },
    });
    if (
      command !== "threadTab.next" &&
      command !== "threadTab.previous" &&
      command !== "threadTab.close"
    )
      return;
    const current = activeThreadRef;
    const visible = useOpenThreadTabsStore.getState().tabs;
    const target =
      command === "threadTab.close"
        ? current
        : adjacentTab(visible, current, command === "threadTab.next" ? "next" : "previous");
    if (!target) return;
    event.preventDefault();
    event.stopPropagation();
    if (command === "threadTab.close") close(target);
    else select(target);
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- subscribes to window keydown for the thread tab shortcuts
  useEffect(() => {
    const listener = (event: KeyboardEvent) => onKeyDown(event);
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, []);

  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    const keys = tabs.map(scopedThreadKey);
    useOpenThreadTabsStore
      .getState()
      .move(keys.indexOf(String(active.id)), keys.indexOf(String(over.id)));
  };

  if (tabs.length === 0) return null;
  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      modifiers={DRAG_MODIFIERS}
      onDragEnd={onDragEnd}
    >
      <SortableContext items={tabs.map(scopedThreadKey)} strategy={horizontalListSortingStrategy}>
        <div
          role="tablist"
          aria-label="Open threads"
          className="flex h-8 shrink-0 items-end gap-0.5 overflow-x-auto border-b border-border px-2 [scrollbar-width:none]"
        >
          {tabs.map((ref) => (
            <ThreadTab
              key={scopedThreadKey(ref)}
              threadRef={ref}
              active={scopedThreadKey(ref) === activeKey}
              onSelect={select}
              onClose={close}
            />
          ))}
        </div>
      </SortableContext>
    </DndContext>
  );
}

function ThreadTab(props: {
  threadRef: ScopedThreadRef;
  active: boolean;
  onSelect: (ref: ScopedThreadRef) => void;
  onClose: (ref: ScopedThreadRef) => void;
}) {
  const { threadRef, active } = props;
  const shell = useQuietThreadShell(threadRef);
  const live =
    useAtomValue(environmentShell.stateValueAtom(threadRef.environmentId)).status === "live";
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: scopedThreadKey(threadRef),
  });
  // A thread deleted from a live shell is pruned on the next navigation; hide it until then.
  if (shell === null && live) return null;
  const unavailable = shell === null;
  const title = shell?.title ?? "Unavailable";
  const state = threadTabState(shell);
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      {...attributes}
      {...listeners}
      role="tab"
      aria-selected={active}
      aria-disabled={unavailable || undefined}
      tabIndex={active ? 0 : -1}
      aria-label={state ? `${title} (${state})` : title}
      className={cn(
        "group/tab flex h-7 max-w-56 min-w-28 shrink-0 cursor-pointer items-center gap-1.5 rounded-t-md px-2 text-xs select-none",
        active ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted/50",
        unavailable && "cursor-default italic",
        isDragging && "z-10",
      )}
      onClick={(event) => {
        // The close button sits inside the tab.
        if ((event.target as HTMLElement).closest("button")) return;
        if (!unavailable && !active) props.onSelect(threadRef);
      }}
      onKeyDown={(event) => {
        if ((event.key === "Enter" || event.key === " ") && !unavailable) props.onSelect(threadRef);
      }}
      onAuxClick={(event) => {
        if (event.button !== 1) return;
        event.preventDefault();
        props.onClose(threadRef);
      }}
    >
      <PanelTabCloseButton label={`Close ${title}`} onClick={() => props.onClose(threadRef)}>
        <MessageSquare className="size-3 shrink-0" />
        {state === null ? null : (
          <span
            className={cn(
              "absolute -top-0.5 -right-0.5 size-1.5 rounded-full",
              state === "running" ? "bg-muted-foreground" : "bg-info",
            )}
            aria-hidden
          />
        )}
      </PanelTabCloseButton>
      <Tooltip>
        <TooltipTrigger render={<span className="min-w-0 flex-1 truncate" />}>
          {title}
        </TooltipTrigger>
        <TooltipPopup side="bottom">{state ? `${title} (${state})` : title}</TooltipPopup>
      </Tooltip>
    </div>
  );
}
