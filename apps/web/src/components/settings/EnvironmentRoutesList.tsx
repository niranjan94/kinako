import {
  DndContext,
  type DragEndEvent,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { restrictToParentElement, restrictToVerticalAxis } from "@dnd-kit/modifiers";
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  type ConnectionRoute,
  connectionRouteAddress,
  connectionRouteId,
  connectionRouteLabel,
  connectionRoutes,
  isLearned,
  pendingRouteOrder,
  routeHttpBaseUrl,
} from "@t3tools/client-runtime/connection";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  AuthAccessWriteScope,
  type AuthEnvironmentScope,
  type EnvironmentId,
} from "@t3tools/contracts";
import { GripVerticalIcon, PlusIcon, XIcon } from "lucide-react";
import { useState } from "react";

import { requestConfirmDialog } from "~/confirmDialog";
import { environmentCatalog } from "~/connection/catalog";
import { addRouteOverConnection } from "~/connection/onboarding";
import { cn } from "~/lib/utils";
import type { EnvironmentPresentation } from "~/state/environments";
import { useEnvironmentSessionScopes, usePreparedConnection } from "~/state/session";
import { useAtomCommand } from "~/state/use-atom-command";
import { Button } from "../ui/button";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { usePublicRouteStatus } from "./PublicRouteSettings";

export function EnvironmentRoutesList({
  environment,
  onAddRoute,
}: {
  readonly environment: EnvironmentPresentation;
  readonly onAddRoute: () => void;
}) {
  const saved = connectionRoutes(environment.entry);
  const savedIds = saved.map((route) => connectionRouteId(route.target));
  const [pending, setPending] = useState<ReadonlyArray<string> | null>(null);
  const shownPending = pendingRouteOrder(pending, savedIds);
  // Dropped during render so a stale order never outlives the save it was for.
  if (pending !== null && shownPending === null) setPending(null);
  const order: Array<string> = shownPending === null ? savedIds : [...shownPending];
  const byId = new Map(saved.map((route) => [connectionRouteId(route.target), route]));
  const routes = order.flatMap((id) => byId.get(id) ?? []);

  const prepared = usePreparedConnection(environment.environmentId);
  const activeRouteId =
    prepared._tag === "Some" && environment.connection.phase === "connected"
      ? connectionRouteId(prepared.value.target)
      : null;
  const reorder = useAtomCommand(environmentCatalog.reorderRoutes, "Reorder routes");
  const removeRoute = useAtomCommand(environmentCatalog.removeRoute, "Remove route");
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const confirmRemove = async (route: ConnectionRoute) => {
    const address = connectionRouteAddress(route);
    const confirmed = await requestConfirmDialog(
      `Remove ${connectionRouteLabel(route)} route?${address === null ? "" : `\n${address}`}`,
      { variant: "destructive" },
    );
    if (confirmed !== true) return;
    await removeRoute({
      environmentId: environment.environmentId,
      routeId: connectionRouteId(route.target),
    });
  };

  const handleDragEnd = (event: DragEndEvent) => {
    if (event.over === null || event.active.id === event.over.id) return;
    const next = arrayMove(
      order,
      order.indexOf(String(event.active.id)),
      order.indexOf(String(event.over.id)),
    );
    setPending(next);
    void reorder({ environmentId: environment.environmentId, routeIds: next }).then((result) => {
      if (result._tag === "Failure") setPending(null);
    });
  };

  return (
    <div className="mt-2 border-t border-border/50 py-2">
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        modifiers={[restrictToVerticalAxis, restrictToParentElement]}
        onDragEnd={handleDragEnd}
      >
        <SortableContext items={order} strategy={verticalListSortingStrategy}>
          <ol aria-label={`Routes to ${environment.label}, preferred first`}>
            {routes.map((route, index) => (
              <SortableRouteRow
                key={connectionRouteId(route.target)}
                route={route}
                position={index + 1}
                inUse={connectionRouteId(route.target) === activeRouteId}
                removable={routes.length > 1 && !isLearned(route)}
                onRemove={() => void confirmRemove(route)}
              />
            ))}
          </ol>
        </SortableContext>
      </DndContext>
      {environment.connection.phase === "connected" ? (
        <PublicRouteSuggestion
          environmentId={environment.environmentId}
          label={environment.label}
          savedBaseUrls={saved.flatMap((route) => routeHttpBaseUrl(route) ?? [])}
        />
      ) : null}
      <div className="-ml-1.5 pt-1">
        <Button size="xs" variant="ghost-muted" onClick={onAddRoute}>
          <PlusIcon className="size-3" />
          Add route
        </Button>
      </div>
    </div>
  );
}

/** Offers the environment's live public route as a route when none points at it yet. */
function PublicRouteSuggestion(props: {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly savedBaseUrls: ReadonlyArray<string>;
}) {
  const grantedScopes = useEnvironmentSessionScopes(props.environmentId);
  if (grantedScopes?.includes(AuthAccessWriteScope) !== true) return null;
  return <LivePublicRouteSuggestion {...props} grantedScopes={grantedScopes} />;
}

function LivePublicRouteSuggestion({
  environmentId,
  label,
  savedBaseUrls,
  grantedScopes,
}: {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly savedBaseUrls: ReadonlyArray<string>;
  readonly grantedScopes: ReadonlyArray<AuthEnvironmentScope>;
}) {
  const status = usePublicRouteStatus(environmentId);
  const addRoute = useAtomCommand(addRouteOverConnection, { reportFailure: false });
  const [adding, setAdding] = useState(false);
  if (status?.state !== "live" || !status.hostname) return null;
  const url = `https://${status.hostname}`;
  if (savedBaseUrls.some((saved) => saved.replace(/\/+$/, "") === url)) return null;

  const add = async () => {
    setAdding(true);
    const result = await addRoute({ environmentId, host: url, grantedScopes });
    setAdding(false);
    if (result._tag === "Success" || isAtomCommandInterrupted(result)) return;
    const error = squashAtomCommandFailure(result);
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title: "Could not add the public route",
        description: error instanceof Error ? error.message : `${url} did not pair with ${label}.`,
      }),
    );
  };

  return (
    <div className="flex items-center gap-2 py-2">
      <div className="min-w-0 flex-1">
        <p className="text-xs font-medium text-foreground">Public route</p>
        <p className="truncate text-2xs text-muted-foreground">{url} · not saved as a route</p>
      </div>
      <Button size="xs" variant="outline" disabled={adding} onClick={() => void add()}>
        {adding ? "Adding…" : "Add"}
      </Button>
    </div>
  );
}

function SortableRouteRow({
  route,
  position,
  inUse,
  removable,
  onRemove,
}: {
  readonly route: ConnectionRoute;
  readonly position: number;
  readonly inUse: boolean;
  readonly removable: boolean;
  readonly onRemove: () => void;
}) {
  const id = connectionRouteId(route.target);
  const label = connectionRouteLabel(route);
  const address = connectionRouteAddress(route);
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id });

  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cn(
        "flex items-center gap-2 py-2",
        isDragging && "relative z-10 rounded-md bg-background shadow-md",
      )}
    >
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-1.5 text-xs font-medium text-foreground">
          {label}
          {inUse ? (
            <span className="rounded-sm bg-success/12 px-1 text-2xs font-normal text-success-foreground">
              In use
            </span>
          ) : null}
        </p>
        {address !== null ? (
          <p className="truncate text-2xs text-muted-foreground">
            {address}
            {isLearned(route) ? " · found automatically" : ""}
          </p>
        ) : null}
      </div>
      <button
        type="button"
        ref={setActivatorNodeRef}
        {...attributes}
        {...listeners}
        aria-label={`Reorder ${label}, position ${position}`}
        className="flex size-6 shrink-0 cursor-grab touch-none items-center justify-center rounded text-muted-foreground/70 outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring active:cursor-grabbing"
      >
        <GripVerticalIcon className="size-3.5" />
      </button>
      {removable ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                type="button"
                variant="ghost-muted"
                size="icon-xs"
                aria-label={`Remove ${label} route`}
                onClick={onRemove}
              />
            }
          >
            <XIcon className="size-3" />
          </TooltipTrigger>
          <TooltipPopup side="top">Remove route</TooltipPopup>
        </Tooltip>
      ) : null}
    </li>
  );
}
