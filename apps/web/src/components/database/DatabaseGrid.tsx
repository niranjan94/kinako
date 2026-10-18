import { writeTextToClipboard } from "../../hooks/useCopyToClipboard";
import type { DatabaseCell, DatabaseColumnInfo, DatabaseResultColumn } from "@t3tools/contracts";
import { DataGrid, type Column, type SortColumn } from "react-data-grid";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import {
  CopyIcon,
  DownloadIcon,
  KeyRoundIcon,
  LinkIcon,
  ChevronRightIcon,
  Table2Icon,
} from "lucide-react";
import { Menu, MenuTrigger, MenuPopup, MenuItem } from "../ui/menu";
import { Button } from "../ui/button";
import { DatabaseToolbarButton } from "./DatabaseToolbarButton";
import { Dialog, DialogHeader, DialogTitle, DialogPanel, DialogPopup } from "../ui/dialog";
import "react-data-grid/lib/styles.css";
import "./database.css";

const EMPTY_COLUMN_INFO: readonly DatabaseColumnInfo[] = [];

type Row = { id: number; cells: readonly DatabaseCell[] };
type Position = { row: number; column: number };
const text = (cell: DatabaseCell | undefined) =>
  cell === null
    ? "NULL"
    : cell === undefined
      ? ""
      : typeof cell === "object"
        ? cell.truncated
        : String(cell);

export const DatabaseGrid = memo(function DatabaseGrid({
  columns,
  rows,
  columnInfo = EMPTY_COLUMN_INFO,
  hasMore,
  expires = false,
  loading,
  onLoadMore,
  orderBy,
  onOrderBy,
}: {
  columns: readonly DatabaseResultColumn[];
  rows: readonly (readonly DatabaseCell[])[];
  columnInfo?: readonly DatabaseColumnInfo[];
  hasMore: boolean;
  /** Unread query rows are discarded by the server after a minute idle. */
  expires?: boolean;
  loading: boolean;
  onLoadMore: () => void;
  orderBy?: string;
  onOrderBy?: (orderBy: string) => void;
}) {
  const [range, setRange] = useState<{ anchor: Position; end: Position } | null>(null);
  const [viewer, setViewer] = useState<{ name: string; value: DatabaseCell } | null>(null);
  const dragging = useRef(false);
  const extending = useRef(false);
  useEffect(() => {
    const stop = () => {
      dragging.current = false;
    };
    window.addEventListener("pointerup", stop);
    return () => window.removeEventListener("pointerup", stop);
  }, []);
  const bounds = useMemo(
    () =>
      range
        ? {
            top: Math.min(range.anchor.row, range.end.row),
            bottom: Math.max(range.anchor.row, range.end.row),
            left: Math.min(range.anchor.column, range.end.column),
            right: Math.max(range.anchor.column, range.end.column),
          }
        : null,
    [range],
  );
  const sortColumns = columns.flatMap<SortColumn>((column, index) => {
    const name = `"${column.name.replaceAll('"', '""')}"`;
    if (orderBy === `${name} ASC`) return [{ columnKey: String(index), direction: "ASC" as const }];
    if (orderBy === `${name} DESC`)
      return [{ columnKey: String(index), direction: "DESC" as const }];
    return [];
  });
  const gridRows = useMemo(() => rows.map((cells, id) => ({ cells, id })), [rows]);
  const gridColumns = useMemo<Column<Row>[]>(
    () => [
      {
        key: "row-number",
        name: "",
        width: 44,
        minWidth: 44,
        maxWidth: 44,
        frozen: true,
        resizable: false,
        cellClass: "database-row-number",
        renderCell: ({ row }) => row.id + 1,
      },
      ...columns.map<Column<Row>>((column, index) => ({
        key: String(index),
        name: column.name,
        renderHeaderCell: ({ sortDirection }) => {
          const info = columnInfo.find((info) => info.name === column.name);
          return (
            <div
              className="flex min-w-0 items-center gap-1.5"
              aria-description={`${column.name}${column.dataType ? ` · ${column.dataType}` : ""}`}
            >
              {info?.primaryKey ? (
                <KeyRoundIcon className="size-3 shrink-0 text-warning-foreground" />
              ) : info?.references ? (
                <LinkIcon className="size-3 shrink-0 text-primary" />
              ) : null}
              <span className="truncate">{column.name}</span>
              {sortDirection && (
                <span className="text-muted-foreground">{sortDirection === "ASC" ? "↑" : "↓"}</span>
              )}
              <span className="ml-auto truncate text-3xs font-normal text-muted-foreground">
                {column.dataType}
              </span>
            </div>
          );
        },
        resizable: true,
        sortable: !!onOrderBy,
        width: Math.min(
          360,
          Math.max(
            120,
            column.name.length * 8 + 50,
            ...rows.slice(0, 30).map((row) => Math.min(text(row[index]).length, 40) * 7 + 24),
          ),
        ),
        cellClass: (row) =>
          bounds &&
          row.id >= bounds.top &&
          row.id <= bounds.bottom &&
          index >= bounds.left &&
          index <= bounds.right
            ? "database-range-cell"
            : undefined,
        renderCell: ({ row }) => {
          const cell = row.cells[index];
          const foreignKey = columnInfo.find((info) => info.name === column.name)?.references;
          return (
            <span
              className={`block truncate ${cell === null ? "italic text-muted-foreground" : ""}`}
              onPointerEnter={() => {
                if (dragging.current)
                  setRange((previous) =>
                    previous ? { ...previous, end: { row: row.id, column: index } } : null,
                  );
              }}
              aria-label={
                foreignKey
                  ? `References ${foreignKey.schema}.${foreignKey.object}.${foreignKey.column}`
                  : undefined
              }
            >
              {foreignKey ? "↗ " : ""}
              {text(cell)}
              {typeof cell === "object" && cell !== null ? "…" : ""}
            </span>
          );
        },
      })),
    ],
    [columns, columnInfo, bounds, rows, onOrderBy],
  );
  const selectedText = () =>
    bounds
      ? rows
          .slice(bounds.top, bounds.bottom + 1)
          .map((row) =>
            row
              .slice(bounds.left, bounds.right + 1)
              .map(text)
              .join("\t"),
          )
          .join("\n")
      : "";
  const download = (format: "csv" | "json") => {
    const csv = (value: string) => '"' + value.replaceAll('"', '""') + '"';
    const contents =
      format === "json"
        ? JSON.stringify({ columns, rows }, null, 2)
        : [
            columns.map((column) => csv(column.name)).join(","),
            ...rows.map((row) => row.map((cell) => csv(text(cell))).join(",")),
          ].join("\r\n");
    const url = URL.createObjectURL(
      new Blob([contents], { type: format === "json" ? "application/json" : "text/csv" }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = `database-results.${format}`;
    link.click();
    URL.revokeObjectURL(url);
  };
  return (
    <div
      data-database-results
      className="flex min-h-0 flex-1 flex-col"
      onCopyCapture={(event) => {
        if (!range) return;
        event.preventDefault();
        event.clipboardData.setData("text/plain", selectedText());
      }}
    >
      <DataGrid
        aria-label="Database results"
        rowHeight={28}
        headerRowHeight={30}
        columns={gridColumns}
        rows={gridRows}
        sortColumns={sortColumns}
        onSortColumnsChange={(next) => {
          const sort = next.at(-1);
          const column = sort && columns[Number(sort.columnKey)];
          onOrderBy?.(column ? `"${column.name.replaceAll('"', '""')}" ${sort.direction}` : "");
        }}
        rowKeyGetter={(row) => row.id}
        onCellMouseDown={({ rowIdx, column }, event) => {
          if (event.button !== 0 || column.idx === 0) return;
          dragging.current = true;
          extending.current = event.shiftKey;
          const end = { row: rowIdx, column: column.idx - 1 };
          setRange((previous) =>
            event.shiftKey && previous ? { ...previous, end } : { anchor: end, end },
          );
        }}
        onCellKeyDown={(args, event) => {
          if (!args.column || args.rowIdx < 0 || args.column.idx === 0) return;
          if (event.key === "Enter" && args.row) {
            const value = args.row.cells[args.column.idx - 1];
            if (value !== undefined) setViewer({ name: args.column.name as string, value });
          }
          extending.current = event.shiftKey;
        }}
        onActivePositionChange={({ rowIdx, column }) => {
          if (rowIdx < 0 || !column || column.idx === 0) return;
          const end = { row: rowIdx, column: column.idx - 1 };
          setRange((previous) =>
            extending.current && previous ? { ...previous, end } : { anchor: end, end },
          );
        }}
        onCellDoubleClick={({ row, column }) => {
          if (column.idx === 0) return;
          const value = row.cells[column.idx - 1];
          if (value !== undefined)
            setViewer({ name: columns[column.idx - 1]?.name ?? "Value", value });
        }}
        onScroll={(event) => {
          const element = event.currentTarget;
          if (
            hasMore &&
            !loading &&
            element.scrollHeight - element.scrollTop - element.clientHeight < 200
          )
            onLoadMore();
        }}
      />
      <div className="flex h-8 shrink-0 items-center gap-1 border-t bg-muted/20 px-2 text-2xs text-muted-foreground">
        <Table2Icon className="mr-1 size-3.5" />
        <span role="status">
          {rows.length.toLocaleString()} rows{hasMore ? "+" : ""}
        </span>
        {hasMore && expires && (
          <span className="ml-2 truncate">· Unread rows expire after 60 seconds idle</span>
        )}
        {bounds && (
          <span className="ml-2">
            {bounds.bottom - bounds.top + 1} × {bounds.right - bounds.left + 1} selected
          </span>
        )}
        <div className="ml-auto flex items-center gap-1">
          <DatabaseToolbarButton
            label="Copy selection"
            disabled={!range}
            onClick={() => void writeTextToClipboard(selectedText(), "database selection")}
          >
            <CopyIcon />
          </DatabaseToolbarButton>
          <Menu>
            <MenuTrigger
              render={<Button size="icon-xs" variant="ghost" aria-label="Export results" />}
            >
              <DownloadIcon />
            </MenuTrigger>
            <MenuPopup align="end">
              <MenuItem onClick={() => download("csv")}>Export loaded rows as CSV</MenuItem>
              <MenuItem onClick={() => download("json")}>Export loaded rows as JSON</MenuItem>
            </MenuPopup>
          </Menu>
          {hasMore && (
            <Button variant="ghost" size="xs" disabled={loading} onClick={onLoadMore}>
              {loading ? "Loading…" : "Next 200"}
              <ChevronRightIcon />
            </Button>
          )}
        </div>
      </div>
      {viewer && (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open) setViewer(null);
          }}
        >
          <DialogPopup>
            <DialogHeader>
              <DialogTitle>{viewer.name}</DialogTitle>
            </DialogHeader>
            <DialogPanel>
              <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-all text-xs">
                {text(viewer.value)}
              </pre>
              {typeof viewer.value === "object" && viewer.value !== null && (
                <p className="text-sm">
                  Showing the first {viewer.value.truncated.length.toLocaleString()} of{" "}
                  {viewer.value.length.toLocaleString()} characters.
                </p>
              )}
            </DialogPanel>
          </DialogPopup>
        </Dialog>
      )}
    </div>
  );
});
