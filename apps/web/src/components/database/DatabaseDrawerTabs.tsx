import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { Table2Icon, TerminalSquareIcon, XIcon } from "lucide-react";
import { useContext, useEffect, type ReactNode } from "react";
import { databaseState } from "../../state/database";
import { persistDatabaseWorkspace } from "./databaseConsoleStorage";
import { showDatabaseDrawerTable } from "./databaseDrawerStore";
import { isDatabaseTableTab } from "./DatabaseTableView";
import { DatabaseToolbarButton } from "./DatabaseToolbarButton";

function DrawerTab({
  active,
  icon,
  label,
  onSelect,
  children,
}: {
  active: boolean;
  icon: ReactNode;
  label: string;
  onSelect: () => void;
  children?: ReactNode;
}) {
  return (
    <div
      className={`relative flex shrink-0 items-center border-r pl-2 pr-1 ${active ? "bg-background after:absolute after:inset-x-0 after:bottom-0 after:h-px after:bg-primary" : "text-muted-foreground"}`}
    >
      <button
        type="button"
        role="tab"
        aria-selected={active}
        className="flex h-full max-w-48 items-center gap-1.5 px-1.5 text-xs outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
        onClick={onSelect}
      >
        {icon}
        <span className="truncate">{label}</span>
      </button>
      {children}
    </div>
  );
}

export function DatabaseDrawerTabs({
  threadKey,
  shownId,
}: {
  threadKey: string;
  shownId: string | null;
}) {
  const registry = useContext(RegistryContext);
  const workspaceAtom = databaseState.workspaces(threadKey);
  const tables = useAtomValue(workspaceAtom).tabs.filter(isDatabaseTableTab);
  useEffect(
    () => registry.subscribe(workspaceAtom, (next) => persistDatabaseWorkspace(threadKey, next)),
    [registry, threadKey, workspaceAtom],
  );
  const close = (id: string) => {
    const workspace = registry.get(workspaceAtom);
    registry.set(workspaceAtom, {
      ...workspace,
      tabs: workspace.tabs.filter((item) => item.id !== id),
    });
    if (id !== shownId) return;
    const index = tables.findIndex((item) => item.id === id);
    showDatabaseDrawerTable(threadKey, (tables[index + 1] ?? tables[index - 1])?.id ?? null);
  };
  return (
    <div
      role="tablist"
      aria-label="Bottom panel"
      className="relative flex h-8 shrink-0 overflow-x-auto bg-muted/20 before:absolute before:inset-x-0 before:bottom-0 before:h-px before:bg-border"
    >
      <DrawerTab
        active={shownId === null}
        icon={<TerminalSquareIcon className="size-3.5 shrink-0" />}
        label="Terminal"
        onSelect={() => showDatabaseDrawerTable(threadKey, null)}
      />
      {tables.map((tab) => (
        <DrawerTab
          key={tab.id}
          active={tab.id === shownId}
          icon={<Table2Icon className="size-3.5 shrink-0" />}
          label={tab.title}
          onSelect={() => showDatabaseDrawerTable(threadKey, tab.id)}
        >
          <DatabaseToolbarButton label={`Close ${tab.title}`} onClick={() => close(tab.id)}>
            <XIcon />
          </DatabaseToolbarButton>
        </DrawerTab>
      ))}
    </div>
  );
}
