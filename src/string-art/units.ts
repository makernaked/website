import type { Units } from "./types";

export const MM_PER_IN = 25.4;

export function toUnits(mm: number, units: Units): number {
  return units === "in" ? mm / MM_PER_IN : mm;
}

export function fromUnits(value: number, units: Units): number {
  return units === "in" ? value * MM_PER_IN : value;
}

export function unitLabel(units: Units): string {
  return units === "in" ? "in" : "mm";
}

/** Formats a length for an input field, without a unit suffix. */
export function formatLength(mm: number, units: Units, digits = units === "in" ? 3 : 2): string {
  const v = toUnits(mm, units);
  const s = v.toFixed(digits);
  if (parseFloat(s) === 0) return "0";
  return s.includes(".") ? s.replace(/0+$/, "").replace(/\.$/, "") : s;
}

/** Formats a length with its unit, e.g. for stats and status text. */
export function formatLengthWithUnit(mm: number, units: Units, digits?: number): string {
  return `${formatLength(mm, units, digits)} ${unitLabel(units)}`;
}

/** Long lengths such as total string: feet or metres. */
export function formatLongLength(mm: number, units: Units): string {
  if (units === "in") return `${(mm / MM_PER_IN / 12).toFixed(1)} ft`;
  return `${(mm / 1000).toFixed(1)} m`;
}

const SUFFIX_MM: Record<string, number> = {
  mm: 1,
  cm: 10,
  m: 1000,
  in: MM_PER_IN,
  '"': MM_PER_IN,
  ft: MM_PER_IN * 12,
  "'": MM_PER_IN * 12,
};

/**
 * Parses "12", "12.5", "3/8", "3 3/8", "1-1/2", optionally with a unit suffix
 * (mm, cm, m, in, ", ft, '). Returns millimetres, or null if unparseable.
 */
export function parseLength(input: string, units: Units): number | null {
  let s = input.trim().toLowerCase();
  if (!s) return null;
  let factor = units === "in" ? MM_PER_IN : 1;
  const suffix = s.match(/(mm|cm|m|in|ft|"|')$/);
  if (suffix) {
    factor = SUFFIX_MM[suffix[1]];
    s = s.slice(0, -suffix[1].length).trim();
  }
  const neg = s.startsWith("-");
  if (neg) s = s.slice(1).trim();
  const m = s.match(/^(\d+(?:\.\d*)?|\.\d+)?(?:[\s-]+)?(?:(\d+)\/(\d+))?$/);
  if (!m || (m[1] === undefined && m[2] === undefined)) return null;
  let v = m[1] !== undefined ? parseFloat(m[1]) : 0;
  if (m[2] !== undefined) {
    const den = parseFloat(m[3]);
    if (!den) return null;
    v += parseFloat(m[2]) / den;
  }
  if (!Number.isFinite(v)) return null;
  return (neg ? -v : v) * factor;
}

/** Ruler label for an inch value, using fractions where they are tidy. */
export function formatInchLabel(inches: number): string {
  const sign = inches < 0 ? "-" : "";
  const a = Math.abs(inches);
  const whole = Math.floor(a + 1e-9);
  const frac = a - whole;
  if (frac < 1e-6) return `${sign}${whole}`;
  for (const den of [2, 4, 8, 16, 32]) {
    const num = Math.round(frac * den);
    if (Math.abs(num / den - frac) < 1e-6) {
      return `${sign}${whole ? whole + " " : ""}${num}/${den}`;
    }
  }
  return `${sign}${a.toFixed(3)}`;
}
