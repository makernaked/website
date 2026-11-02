import * as ClipperLib from "clipper-lib";
import type { Artwork, Contour, Pt } from "./types";

/**
 * Prepares an artwork's drawing for display, regions and nails: loose line
 * ends are joined up to nearby lines, and when a line width is set, single
 * lines are thickened into merged bands. All in the artwork's local coordinates.
 */

export interface Line {
  pts: Pt[];
  closed: boolean;
}

/** Default gap closing distance: 1.5% of the artwork's size. */
export function defaultGap(a: Artwork): number {
  return 0.015 * Math.max(a.w0, a.h0);
}

export function artGap(a: Artwork): number {
  return a.gap ?? defaultGap(a);
}

export function artLineWidth(a: Artwork): number {
  return a.lineWidth ?? 0;
}

export function openLineCount(a: Artwork): number {
  return a.contours.filter((c) => !c.closed).length;
}

const cache = new WeakMap<Contour[], Map<string, Line[]>>();

export function artLines(a: Artwork): Line[] {
  const gap = artGap(a);
  const width = artLineWidth(a);
  const key = `${gap}|${width}`;
  let byKey = cache.get(a.contours);
  if (!byKey) {
    byKey = new Map();
    cache.set(a.contours, byKey);
  }
  let lines = byKey.get(key);
  if (!lines) {
    lines = prepareLines(a.contours, gap, width);
    byKey.set(key, lines);
  }
  return lines;
}

export function prepareLines(contours: Contour[], gap: number, width: number): Line[] {
  const lines = extendLooseEnds(cleanLines(contours), gap);
  const open = lines.filter((l) => !l.closed);
  if (width <= 0 || !open.length) return lines;
  return [...lines.filter((l) => l.closed), ...strokeLines(open, width)];
}

function cleanLines(contours: Contour[]): Line[] {
  const lines: Line[] = [];
  for (const c of contours) {
    const pts: Pt[] = [];
    for (let i = 0; i + 1 < c.pts.length; i += 2) {
      const p: Pt = [c.pts[i], c.pts[i + 1]];
      const last = pts[pts.length - 1];
      if (!last || last[0] !== p[0] || last[1] !== p[1]) pts.push(p);
    }
    if (c.closed && pts.length > 1 && pts[0][0] === pts[pts.length - 1][0] && pts[0][1] === pts[pts.length - 1][1]) pts.pop();
    if (pts.length >= (c.closed ? 3 : 2)) lines.push({ pts, closed: c.closed });
  }
  return lines;
}

/**
 * Extends each loose end to the nearest line within `gap`, or failing that,
 * carries it on in its own direction for up to three times that (a border
 * drawn with a deliberate break where something crosses it). Extensions
 * overshoot by a hair so the crossing is found reliably later.
 */
function extendLooseEnds(lines: Line[], gap: number): Line[] {
  if (gap <= 0 || !lines.some((l) => !l.closed)) return lines;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const l of lines)
    for (const [x, y] of l.pts) {
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  const diag = Math.hypot(maxX - minX, maxY - minY) || 1;
  const overshoot = diag * 1e-5;
  const reach = gap * 3;

  // Segment grid.
  const segs: { a: Pt; b: Pt; line: number; idx: number }[] = [];
  lines.forEach((l, li) => {
    const n = l.pts.length;
    for (let i = 0; i < (l.closed ? n : n - 1); i++) segs.push({ a: l.pts[i], b: l.pts[(i + 1) % n], line: li, idx: i });
  });
  const cell = Math.max(diag / 160, gap);
  const gx = Math.ceil((maxX - minX) / cell) + 3;
  const ci = (x: number) => Math.max(0, Math.min(gx - 1, Math.floor((x - minX) / cell) + 1));
  const cj = (y: number) => Math.max(0, Math.floor((y - minY) / cell) + 1);
  const grid = new Map<number, number[]>();
  segs.forEach((s, k) => {
    for (let j = cj(Math.min(s.a[1], s.b[1])); j <= cj(Math.max(s.a[1], s.b[1])); j++)
      for (let i = ci(Math.min(s.a[0], s.b[0])); i <= ci(Math.max(s.a[0], s.b[0])); i++) {
        const list = grid.get(j * gx + i);
        if (list) list.push(k);
        else grid.set(j * gx + i, [k]);
      }
  });

  return lines.map((l, li) => {
    if (l.closed) return l;
    const n = l.pts.length;
    const cum = [0];
    for (let i = 0; i < n - 1; i++) cum.push(cum[i] + Math.hypot(l.pts[i + 1][0] - l.pts[i][0], l.pts[i + 1][1] - l.pts[i][1]));
    const L = cum[n - 1];
    const ends: (Pt | null)[] = [true, false].map((atStart) => {
      const P = atStart ? l.pts[0] : l.pts[n - 1];
      // Direction the line is heading as it ends, measured over a short stretch.
      let k = atStart ? 1 : n - 2;
      while (k > 0 && k < n - 1 && Math.hypot(l.pts[k][0] - P[0], l.pts[k][1] - P[1]) < gap * 0.5) k += atStart ? 1 : -1;
      const back = l.pts[k];
      const dl = Math.hypot(P[0] - back[0], P[1] - back[1]) || 1;
      const dir: Pt = [(P[0] - back[0]) / dl, (P[1] - back[1]) / dl];
      const R: Pt = [P[0] + dir[0] * reach, P[1] + dir[1] * reach];

      let near: Pt | null = null;
      let nearD = gap;
      let rayD = Infinity;
      const seen = new Set<number>();
      for (let j = cj(Math.min(P[1], R[1]) - gap); j <= cj(Math.max(P[1], R[1]) + gap); j++)
        for (let i = ci(Math.min(P[0], R[0]) - gap); i <= ci(Math.max(P[0], R[0]) + gap); i++)
          for (const s of grid.get(j * gx + i) ?? []) {
            if (seen.has(s)) continue;
            seen.add(s);
            const { a, b, line, idx } = segs[s];
            // Ignore this line's own segments near the end being extended.
            if (line === li && (atStart ? cum[idx] : L - cum[idx + 1]) < 2 * gap) continue;
            const dx = b[0] - a[0];
            const dy = b[1] - a[1];
            const len2 = dx * dx + dy * dy;
            const t = len2 ? Math.max(0, Math.min(1, ((P[0] - a[0]) * dx + (P[1] - a[1]) * dy) / len2)) : 0;
            const Q: Pt = [a[0] + t * dx, a[1] + t * dy];
            const d = Math.hypot(P[0] - Q[0], P[1] - Q[1]);
            if (d <= nearD) {
              nearD = d;
              near = Q;
            }
            const den = dir[0] * dy - dir[1] * dx;
            if (Math.abs(den) < 1e-12) continue;
            const along = ((a[0] - P[0]) * dy - (a[1] - P[1]) * dx) / den;
            const u = ((a[0] - P[0]) * dir[1] - (a[1] - P[1]) * dir[0]) / den;
            if (along > 0 && along <= reach && u >= 0 && u <= 1) rayD = Math.min(rayD, along);
          }
      if (near) {
        const d = Math.hypot(near[0] - P[0], near[1] - P[1]);
        const ux = d > overshoot ? (near[0] - P[0]) / d : dir[0];
        const uy = d > overshoot ? (near[1] - P[1]) / d : dir[1];
        return [near[0] + ux * overshoot, near[1] + uy * overshoot];
      }
      if (rayD < Infinity) return [P[0] + dir[0] * (rayD + overshoot), P[1] + dir[1] * (rayD + overshoot)];
      return null;
    });
    const pts = [...(ends[0] ? [ends[0]] : []), ...l.pts, ...(ends[1] ? [ends[1]] : [])];
    return { pts, closed: false };
  });
}

/** Thickens open lines into bands of the given width, merged where they overlap. */
function strokeLines(open: Line[], width: number): Line[] {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const l of open)
    for (const [x, y] of l.pts) {
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  // Clipper works in integers: map the drawing onto roughly a million units.
  const scale = 1e6 / (Math.hypot(maxX - minX, maxY - minY) + width || 1);
  const paths: ClipperLib.Paths = open.map((l) => l.pts.map(([x, y]) => ({ X: Math.round(x * scale), Y: Math.round(y * scale) })));
  const co = new ClipperLib.ClipperOffset(2, 0.25);
  co.AddPaths(paths, ClipperLib.JoinType.jtMiter, ClipperLib.EndType.etOpenButt);
  const out: ClipperLib.Paths = [];
  co.Execute(out, (width / 2) * scale);
  return ClipperLib.Clipper.CleanPolygons(out, 2)
    .filter((p) => p.length >= 3)
    .map((p) => ({ closed: true, pts: p.map((q): Pt => [q.X / scale, q.Y / scale]) }));
}
