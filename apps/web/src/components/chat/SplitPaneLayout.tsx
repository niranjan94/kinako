import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { XIcon } from "lucide-react";
import { use, useRef, type PointerEvent as ReactPointerEvent } from "react";

import { ComposerHandleContext, useComposerHandleContext } from "../../composerHandleContext";
import { useDiffPanelStore } from "../../diffPanelStore";
import { cn } from "../../lib/utils";
import { useThreadOnScreen } from "../../onScreenThreads";
import { useRightPanelStore } from "../../rightPanelStore";
import { type PaneNode, replacePaneThread } from "../../splitView.logic";
import { useSplitViewStore } from "../../splitViewStore";
import { useQuietThreadShell } from "../../state/entities";
import { buildThreadRouteParams } from "../../threadRoutes";
import ChatView from "../ChatView";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import { BackgroundThreadContext } from "./backgroundThread";

type Leaf = Extract<PaneNode, { kind: "leaf" }>;

/**
 * Renders the split view. The routed thread is the focused pane: it runs as the foreground
 * ChatView with its header and right panel, and the others run embedded in the background.
 */
export function SplitPaneLayout({ root, routeRef }: { root: PaneNode; routeRef: ScopedThreadRef }) {
  const focusedPaneId = useSplitViewStore((state) => state.focusedPaneId);
  // Navigation decides focus; until the store follows it, show what it will hold.
  const shown = focusedPaneId ? replacePaneThread(root, focusedPaneId, routeRef) : root;
  return <PaneBranch node={shown} routeKey={scopedThreadKey(routeRef)} />;
}

function PaneBranch({ node, routeKey }: { node: PaneNode; routeKey: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  if (node.kind === "leaf") {
    return <PaneChat leaf={node} focused={scopedThreadKey(node.threadRef) === routeKey} />;
  }
  const row = node.direction === "row";
  const onDividerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    const container = containerRef.current;
    if (!container) return;
    event.preventDefault();
    const divider = event.currentTarget;
    divider.setPointerCapture(event.pointerId);
    const bounds = container.getBoundingClientRect();
    const onMove = (move: PointerEvent) => {
      const ratio = row
        ? (move.clientX - bounds.left) / bounds.width
        : (move.clientY - bounds.top) / bounds.height;
      useSplitViewStore.getState().resize(node.id, ratio);
    };
    const onUp = () => {
      divider.removeEventListener("pointermove", onMove);
      divider.removeEventListener("pointerup", onUp);
      divider.removeEventListener("pointercancel", onUp);
    };
    divider.addEventListener("pointermove", onMove);
    divider.addEventListener("pointerup", onUp);
    divider.addEventListener("pointercancel", onUp);
  };
  return (
    <div
      ref={containerRef}
      className={cn("flex min-h-0 min-w-0 flex-1", row ? "flex-row" : "flex-col")}
    >
      <div className="flex min-h-0 min-w-0" style={{ flex: `${node.ratio} 1 0` }}>
        <PaneBranch node={node.first} routeKey={routeKey} />
      </div>
      <div
        role="separator"
        aria-orientation={row ? "vertical" : "horizontal"}
        aria-label="Resize panes"
        className={cn(
          "shrink-0 bg-border hover:bg-primary/40",
          row ? "w-px cursor-col-resize px-px" : "h-px cursor-row-resize py-px",
        )}
        onPointerDown={onDividerDown}
      />
      <div className="flex min-h-0 min-w-0" style={{ flex: `${1 - node.ratio} 1 0` }}>
        <PaneBranch node={node.second} routeKey={routeKey} />
      </div>
    </div>
  );
}

function PaneChat({ leaf, focused }: { leaf: Leaf; focused: boolean }) {
  const navigate = useNavigate();
  const background = use(BackgroundThreadContext);
  const composerHandle = useComposerHandleContext();
  const shell = useQuietThreadShell(leaf.threadRef);
  const { threadRef } = leaf;
  // The routed pane is registered by ThreadRouteView.
  useThreadOnScreen(focused || background ? null : threadRef);

  const focus = () => {
    if (!focused)
      void navigate({ to: "/$environmentId/$threadId", params: buildThreadRouteParams(threadRef) });
  };
  const close = () => {
    const next = useSplitViewStore.getState().close(leaf.id);
    if (focused && next) {
      void navigate({ to: "/$environmentId/$threadId", params: buildThreadRouteParams(next) });
    }
  };
  return (
    <section
      data-split-pane
      aria-label={shell?.title ?? "Thread"}
      className={cn("relative flex min-h-0 min-w-0 flex-1 flex-col", focused ? "" : "bg-muted/20")}
      onPointerDownCapture={focused ? undefined : focus}
    >
      {focused ? null : (
        <div className="flex h-9 shrink-0 items-center gap-1 border-b border-border pr-1 pl-3">
          <span className="min-w-0 flex-1 truncate text-xs font-medium text-muted-foreground">
            {shell?.title ?? "Thread"}
          </span>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={`Close pane ${shell?.title ?? ""}`.trim()}
            onPointerDownCapture={(event) => event.stopPropagation()}
            onClick={close}
          >
            <XIcon />
          </Button>
        </div>
      )}
      <BackgroundThreadContext value={background || !focused}>
        <ComposerHandleContext value={focused ? composerHandle : null}>
          <ChatView
            environmentId={threadRef.environmentId}
            threadId={threadRef.threadId}
            routeKind="server"
            // A background pane has no panel or terminal: diffs open once it is focused.
            {...(focused
              ? {}
              : {
                  embedded: {
                    openToolDiff: (target) => {
                      useDiffPanelStore.getState().selectToolCall(threadRef, target);
                      useRightPanelStore.getState().open(threadRef, "diff");
                      focus();
                    },
                    runShellCommand: (command) => {
                      void navigator.clipboard.writeText(command);
                      toastManager.add({
                        type: "info",
                        title: "Command copied",
                        description: "Focus this pane to run commands in its terminal.",
                      });
                    },
                  },
                })}
          />
        </ComposerHandleContext>
      </BackgroundThreadContext>
    </section>
  );
}
