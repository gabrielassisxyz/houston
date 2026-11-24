export interface CapacityFigures {
  committed: number;
  capacity: number;
  unsized: number;
  /** Points of the closed members; shown only once the sprint has started. */
  done: number | null;
}

export function CapacityBar({ committed, capacity, unsized, done }: CapacityFigures) {
  const pct = capacity > 0 ? Math.min(100, Math.round((committed / capacity) * 100)) : 0;
  const over = committed - capacity;
  return (
    <div data-testid="capacity-bar" className="flex flex-col gap-[6px]">
      <div className="flex items-center gap-[9px]">
        <div className="h-[6px] flex-1 overflow-hidden rounded-full bg-[var(--surface-3)]">
          <div
            className="h-full rounded-full transition-[width]"
            style={{ width: `${pct}%`, background: over > 0 ? "var(--danger,#ef4444)" : "var(--brand)" }}
          />
        </div>
        <span className="flex-shrink-0 font-mono text-[11px] text-[var(--text-3)]">
          {committed} / {capacity} points
        </span>
      </div>
      <div className="flex gap-3 text-[12px] text-[var(--text-3)]">
        {unsized > 0 && <span>{unsized} unsized</span>}
        {over > 0 && <span className="text-destructive">{over} over capacity</span>}
        {done !== null && <span>{done} done</span>}
      </div>
    </div>
  );
}
