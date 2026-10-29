import { useEffect, useRef, useState } from "react";

/** A volume slider that saves once you stop moving it (one edit per change, not one per step). */
export function Level({ label, valueDb, min = -40, max = 6, disabled, onCommit }: { label: string; valueDb: number; min?: number; max?: number; disabled?: boolean; onCommit(db: number): void }) {
  const [value, setValue] = useState(valueDb);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const latest = useRef(valueDb);
  useEffect(() => { setValue(valueDb); latest.current = valueDb; }, [valueDb]);
  useEffect(() => () => clearTimeout(timer.current), []);
  const commit = () => { clearTimeout(timer.current); if (latest.current !== valueDb) onCommit(latest.current); };
  const change = (db: number) => { setValue(db); latest.current = db; clearTimeout(timer.current); timer.current = setTimeout(commit, 700); };
  const describe = (db: number) => (db <= -36 ? "almost silent" : db <= -24 ? "quiet" : db <= -14 ? "soft" : db <= -6 ? "medium" : "loud");
  return <label className="level">
    <span className="level-head"><span>{label}</span><span className="muted small">{describe(value)} · {value > 0 ? "+" : ""}{value} dB</span></span>
    <input type="range" min={min} max={max} step={1} value={value} disabled={disabled} aria-label={label + " volume"}
      onChange={(event) => change(Number(event.target.value))} onPointerUp={commit} onTouchEnd={commit} />
  </label>;
}
