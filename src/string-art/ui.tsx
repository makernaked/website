"use client";

import { type ReactNode, useRef, useState } from "react";
import type { Units } from "./types";
import { formatLength, MM_PER_IN, parseLength } from "./units";

const inputClass =
  "w-full min-w-0 rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-sm text-neutral-100 outline-none placeholder:text-neutral-600 focus:border-amber-500";

type BtnProps = {
  children: ReactNode;
  onClick?: () => void;
  title?: string;
  variant?: "default" | "primary" | "ghost";
  active?: boolean;
  disabled?: boolean;
  className?: string;
};

/** Doesn't take focus on mouse click, so canvas keyboard shortcuts keep working. */
export function Btn({ children, onClick, title, variant = "default", active, disabled, className = "" }: BtnProps) {
  const base = "inline-flex items-center justify-center gap-1.5 rounded text-sm transition-colors disabled:opacity-40 disabled:pointer-events-none";
  const styles = {
    default: "border border-neutral-700 bg-neutral-800 px-2.5 py-1 hover:bg-neutral-700",
    primary: "bg-amber-500 px-3 py-1.5 font-medium text-neutral-950 hover:bg-amber-400",
    ghost: "p-1.5 text-neutral-300 hover:bg-neutral-800 hover:text-white",
  }[variant];
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      disabled={disabled}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      className={`${base} ${styles} ${active ? "bg-neutral-700 text-amber-300" : ""} ${className}`}
    >
      {children}
    </button>
  );
}

export function Section({ title, children, right }: { title: string; children: ReactNode; right?: ReactNode }) {
  return (
    <section className="border-b border-neutral-800 px-4 py-3">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-[11px] font-semibold tracking-wider text-neutral-500 uppercase">{title}</h3>
        {right}
      </div>
      <div className="space-y-2">{children}</div>
    </section>
  );
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="block">
      <span className="mb-0.5 block text-xs text-neutral-400">{label}</span>
      {children}
      {hint && <span className="mt-0.5 block text-[11px] text-neutral-500">{hint}</span>}
    </label>
  );
}

export function Row({ children }: { children: ReactNode }) {
  return <div className="grid grid-cols-2 gap-2">{children}</div>;
}

/** Text input that edits a draft and commits on Enter/blur. Escape reverts. */
function DraftInput({
  shown,
  parse,
  onCommit,
  step,
  placeholder,
}: {
  shown: string;
  parse: (s: string) => number | null;
  onCommit: (v: number) => void;
  step?: (shift: boolean) => number;
  placeholder?: string;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const cancelled = useRef(false);
  const commit = (text: string | null) => {
    if (text !== null && !cancelled.current) {
      const v = parse(text);
      if (v !== null && Number.isFinite(v)) onCommit(v);
    }
    cancelled.current = false;
    setDraft(null);
  };
  return (
    <input
      className={inputClass}
      value={draft ?? shown}
      placeholder={placeholder}
      inputMode="decimal"
      onFocus={(e) => {
        setDraft(shown);
        e.target.select();
      }}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => commit(draft)}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        else if (e.key === "Escape") {
          cancelled.current = true;
          (e.target as HTMLInputElement).blur();
        } else if (step && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
          e.preventDefault();
          const cur = parse(draft ?? shown);
          if (cur === null) return;
          const next = cur + (e.key === "ArrowUp" ? 1 : -1) * step(e.shiftKey);
          onCommit(next);
          setDraft(null);
        }
      }}
    />
  );
}

/** Length in millimetres, shown and typed in the current units (fractions like 3 1/2 are fine). */
export function LengthInput({
  value,
  units,
  onCommit,
  min,
  placeholder,
}: {
  value: number | null;
  units: Units;
  onCommit: (mm: number) => void;
  min?: number;
  placeholder?: string;
}) {
  return (
    <DraftInput
      key={units}
      shown={value === null ? "" : formatLength(value, units)}
      placeholder={placeholder}
      parse={(s) => {
        const v = parseLength(s, units);
        return v === null || (min !== undefined && v < min) ? null : v;
      }}
      onCommit={(v) => onCommit(min !== undefined ? Math.max(min, v) : v)}
      step={(shift) => (units === "in" ? (shift ? 0.5 : 1 / 16) * MM_PER_IN : shift ? 10 : 1)}
    />
  );
}

export function NumberInput({
  value,
  onCommit,
  min,
  max,
  step = 1,
  digits = 2,
}: {
  value: number;
  onCommit: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
  digits?: number;
}) {
  const clamp = (v: number) => Math.min(max ?? Infinity, Math.max(min ?? -Infinity, v));
  return (
    <DraftInput
      shown={String(Math.round(value * 10 ** digits) / 10 ** digits)}
      parse={(s) => {
        const v = parseFloat(s);
        return Number.isFinite(v) ? v : null;
      }}
      onCommit={(v) => onCommit(clamp(v))}
      step={(shift) => step * (shift ? 10 : 1)}
    />
  );
}

export function Select<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <select className={inputClass} value={value} onChange={(e) => onChange(e.target.value as T)}>
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

export function Check({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex cursor-pointer items-center gap-2 text-sm text-neutral-300">
      <input type="checkbox" className="accent-amber-500" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  );
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <div className="inline-flex rounded border border-neutral-700 p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => onChange(o.value)}
          className={`rounded px-2 py-0.5 text-xs ${value === o.value ? "bg-neutral-700 text-amber-300" : "text-neutral-400 hover:text-neutral-200"}`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

const ICONS: Record<string, ReactNode> = {
  file: <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6" />,
  open: <path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.7-.9l-.8-1.2A2 2 0 0 0 7.9 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />,
  save: <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3" />,
  import: <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12" />,
  undo: <path d="M9 14 4 9l5-5M4 9h10.5a5.5 5.5 0 0 1 0 11H11" />,
  redo: <path d="m15 14 5-5-5-5M20 9H9.5a5.5 5.5 0 0 0 0 11H13" />,
  copy: (
    <>
      <rect x="8" y="8" width="13" height="13" rx="2" />
      <path d="M4 16a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2" />
    </>
  ),
  trash: <path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />,
  plus: <path d="M12 5v14M5 12h14" />,
  minus: <path d="M5 12h14" />,
  home: <path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM9 22V12h6v10" />,
  fit: <path d="M8 3H5a2 2 0 0 0-2 2v3M21 8V5a2 2 0 0 0-2-2h-3M3 16v3a2 2 0 0 0 2 2h3M16 21h3a2 2 0 0 0 2-2v-3" />,
  shapes: (
    <>
      <rect x="3" y="3" width="8" height="8" rx="1" />
      <circle cx="17" cy="17" r="4" />
      <path d="M17 3l4 7h-8z" />
    </>
  ),
  magnet: <path d="m6 15-4-4 6.75-6.77a7.79 7.79 0 0 1 11 11L13 22l-4-4 6.39-6.36a2.14 2.14 0 0 0-3-3L6 15M5 8l4 4M12 15l4 4" />,
};

export function Icon({ name, size = 16 }: { name: keyof typeof ICONS; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {ICONS[name]}
    </svg>
  );
}

/** 16px alignment glyphs drawn as filled bars. */
export function AlignIcon({ mode }: { mode: string }) {
  const bars: Record<string, ReactNode> = {
    left: (
      <>
        <rect x="1" y="1" width="1.5" height="14" />
        <rect x="4" y="3" width="10" height="4" />
        <rect x="4" y="9" width="6" height="4" />
      </>
    ),
    hcenter: (
      <>
        <rect x="7.25" y="1" width="1.5" height="14" />
        <rect x="2" y="3" width="12" height="4" />
        <rect x="4" y="9" width="8" height="4" />
      </>
    ),
    right: (
      <>
        <rect x="13.5" y="1" width="1.5" height="14" />
        <rect x="2" y="3" width="10" height="4" />
        <rect x="6" y="9" width="6" height="4" />
      </>
    ),
    top: (
      <>
        <rect x="1" y="1" width="14" height="1.5" />
        <rect x="3" y="4" width="4" height="10" />
        <rect x="9" y="4" width="4" height="6" />
      </>
    ),
    vcenter: (
      <>
        <rect x="1" y="7.25" width="14" height="1.5" />
        <rect x="3" y="2" width="4" height="12" />
        <rect x="9" y="4" width="4" height="8" />
      </>
    ),
    bottom: (
      <>
        <rect x="1" y="13.5" width="14" height="1.5" />
        <rect x="3" y="2" width="4" height="10" />
        <rect x="9" y="6" width="4" height="6" />
      </>
    ),
    "dist-x": (
      <>
        <rect x="1" y="1" width="1.5" height="14" />
        <rect x="13.5" y="1" width="1.5" height="14" />
        <rect x="6" y="4" width="4" height="8" />
      </>
    ),
    "dist-y": (
      <>
        <rect x="1" y="1" width="14" height="1.5" />
        <rect x="1" y="13.5" width="14" height="1.5" />
        <rect x="4" y="6" width="8" height="4" />
      </>
    ),
    center: (
      <>
        <rect x="7.25" y="0" width="1.5" height="16" />
        <rect x="0" y="7.25" width="16" height="1.5" />
        <rect x="4" y="4" width="8" height="8" fillOpacity="0.5" />
      </>
    ),
  };
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
      {bars[mode]}
    </svg>
  );
}
