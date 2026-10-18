import { useRef, useState, type ReactNode } from "react";

export function DatabaseSplit({
  direction,
  label,
  first,
  second,
  initial = 55,
  collapsed = false,
}: {
  direction: "horizontal" | "vertical";
  label: string;
  first: ReactNode;
  second: ReactNode;
  initial?: number;
  collapsed?: boolean;
}) {
  const container = useRef<HTMLDivElement>(null);
  const [percent, setPercent] = useState(initial);
  const vertical = direction === "vertical";
  const clamp = (value: number) => Math.min(80, Math.max(20, value));
  return (
    <div ref={container} className={`flex min-h-0 min-w-0 flex-1 ${vertical ? "flex-col" : ""}`}>
      <div
        className="flex min-h-0 min-w-0 overflow-hidden"
        style={{ flexBasis: collapsed ? "100%" : `${percent}%` }}
      >
        {first}
      </div>
      <div
        hidden={collapsed}
        role="separator"
        aria-label={label}
        aria-orientation={vertical ? "horizontal" : "vertical"}
        aria-valuenow={Math.round(percent)}
        aria-valuemin={20}
        aria-valuemax={80}
        tabIndex={0}
        className={`relative z-10 shrink-0 touch-none bg-border outline-none hover:bg-ring focus-visible:bg-ring focus-visible:before:bg-ring/40 ${vertical ? "h-px cursor-row-resize before:absolute before:-inset-y-1 before:inset-x-0" : "w-px cursor-col-resize before:absolute before:-inset-x-1 before:inset-y-0"}`}
        onDoubleClick={() => setPercent(initial)}
        onKeyDown={(event) => {
          if (["ArrowLeft", "ArrowUp", "ArrowRight", "ArrowDown"].includes(event.key)) {
            event.preventDefault();
            setPercent((value) =>
              clamp(value + (["ArrowLeft", "ArrowUp"].includes(event.key) ? -5 : 5)),
            );
          }
        }}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          event.preventDefault();
          event.currentTarget.focus();
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
          const rect = container.current?.getBoundingClientRect();
          if (rect)
            setPercent(
              clamp(
                100 *
                  (vertical
                    ? (event.clientY - rect.top) / rect.height
                    : (event.clientX - rect.left) / rect.width),
              ),
            );
        }}
        onPointerUp={(event) => {
          if (event.currentTarget.hasPointerCapture(event.pointerId))
            event.currentTarget.releasePointerCapture(event.pointerId);
        }}
      />
      <div className={collapsed ? "hidden" : "flex min-h-0 min-w-0 flex-1 overflow-hidden"}>
        {second}
      </div>
    </div>
  );
}
