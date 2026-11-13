import { emptyBounds, extendBounds, worldContours } from "./geometry";
import type { State } from "./store";
import type { Bounds, PaperId, PrintSettings, Units } from "./types";
import { MM_PER_IN } from "./units";

export const PAPERS: Record<PaperId, { label: string; size: [number, number] }> = {
  letter: { label: "Letter", size: [215.9, 279.4] },
  legal: { label: "Legal", size: [215.9, 355.6] },
  tabloid: { label: "Tabloid", size: [279.4, 431.8] },
  a4: { label: "A4", size: [210, 297] },
  a3: { label: "A3", size: [297, 420] },
};

export interface TilePlan {
  pw: number;
  ph: number;
  /** Printable area per page. */
  aw: number;
  ah: number;
  cols: number;
  rows: number;
  /** Distance between the left/top edges of neighbouring tiles. */
  sx: number;
  sy: number;
  /** World X of the first column's left edge and world Y of the first row's top edge. */
  x0: number;
  top: number;
}

/** Everything that will be printed, padded slightly. */
export function printBounds(s: State): Bounds | null {
  const p = s.pattern;
  if (!p || !p.nails.length) return null;
  const b = emptyBounds();
  for (const n of p.nails) extendBounds(b, n.x, n.y);
  for (const o of s.objects) {
    if ((o.type === "art" && s.print.outline) || (o.type === "ref" && s.print.refs)) {
      for (const c of worldContours(o)) for (const [x, y] of c.pts) extendBounds(b, x, y);
    }
  }
  const pad = s.settings.nailDiameter + 6;
  return { minX: b.minX - pad, minY: b.minY - pad, maxX: b.maxX + pad, maxY: b.maxY + pad };
}

export function planTiles(content: Bounds, ps: PrintSettings): TilePlan {
  const [a, b] = PAPERS[ps.paper].size;
  const W = content.maxX - content.minX;
  const H = content.maxY - content.minY;
  const plan = (pw: number, ph: number): TilePlan => {
    const aw = Math.max(pw - 2 * ps.margin, 20);
    const ah = Math.max(ph - 2 * ps.margin, 20);
    const overlap = Math.min(ps.overlap, aw / 2, ah / 2);
    const sx = aw - overlap;
    const sy = ah - overlap;
    const cols = W <= aw ? 1 : Math.ceil((W - aw) / sx) + 1;
    const rows = H <= ah ? 1 : Math.ceil((H - ah) / sy) + 1;
    const totalW = aw + (cols - 1) * sx;
    const totalH = ah + (rows - 1) * sy;
    return {
      pw,
      ph,
      aw,
      ah,
      cols,
      rows,
      sx,
      sy,
      x0: content.minX - (totalW - W) / 2,
      top: content.maxY + (totalH - H) / 2,
    };
  };
  const portrait = plan(Math.min(a, b), Math.max(a, b));
  const landscape = plan(Math.max(a, b), Math.min(a, b));
  if (ps.orientation === "portrait") return portrait;
  if (ps.orientation === "landscape") return landscape;
  return landscape.cols * landscape.rows < portrait.cols * portrait.rows ? landscape : portrait;
}

/** Page names are row-column numbers so they can't be confused with nail labels like "A12". */
export const tileLabel = (r: number, c: number) => `${r + 1}-${c + 1}`;

/** The scale check bar on the cover: 6 in or 150 mm. */
export const coverBar = (units: Units) => (units === "in" ? 6 * MM_PER_IN : 150);
