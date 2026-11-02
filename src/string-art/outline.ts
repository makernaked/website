import * as ClipperLib from "clipper-lib";
import { buildGraph, edgeKey, type Graph, nearestChain } from "./graph";
import type { Artwork, Contour, Pt } from "./types";

/**
 * Prepares an artwork's drawing for display, regions and nails: loose line
 * ends are joined up to nearby lines, layers left out are dropped, and single
 * lines with a width are thickened into merged bands. Widths can differ along
 * a line: each piece between junctions takes its layer's width unless one has
 * been painted onto it. All in the artwork's local coordinates.
 */

export interface Line {
  pts: Pt[];
  closed: boolean;
  /** Band width for an open line (0 = thin), while preparing. */
  width?: number;
  /** On a layer that's left out: only used as something for other lines to reach. */
  skip?: boolean;
  /** Index of the contour it came from (also its drawing order). */
  src?: number;
  /** In the prepared drawing: a closed shape, a band made from single lines, or a thin line. */
  kind?: "shape" | "band" | "thin";
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

export function layerIncluded(a: Artwork, layer: string | undefined): boolean {
  return layer === undefined || a.layers?.[layer]?.include !== false;
}

/** Distance (artwork units) within which saved picks (fills, cut lines, painted widths) find their spot again. */
export function matchTolerance(a: Artwork): number {
  return Math.max(artGap(a) * 0.5, 0.002 * Math.max(a.w0, a.h0));
}

/** Width of a contour's band (local units): its layer's width or the artwork's, scaled by its file weight if asked. */
export function contourWidth(a: Artwork, c: Contour, maxWeight: number): number {
  if (c.closed) return 0;
  const base = (c.layer !== undefined ? a.layers?.[c.layer]?.lineWidth : undefined) ?? artLineWidth(a);
  return a.lineWeights && c.weight && maxWeight > 0 ? (base * c.weight) / maxWeight : base;
}

export function maxLineWeight(a: Artwork): number {
  return a.contours.reduce((m, c) => (!c.closed && c.weight ? Math.max(m, c.weight) : m), 0);
}

function cached<T>(store: WeakMap<Contour[], Map<string, T>>, a: Artwork, key: string, make: () => T): T {
  let byKey = store.get(a.contours);
  if (!byKey) {
    byKey = new Map();
    store.set(a.contours, byKey);
  }
  let v = byKey.get(key);
  if (v === undefined) {
    v = make();
    byKey.set(key, v);
  }
  return v;
}

/** What shapes the thin drawing: gap closing and which layers are in. */
function thinKey(a: Artwork): string {
  const out = Object.entries(a.layers ?? {}).filter(([, l]) => l.include === false).map(([name]) => name);
  return JSON.stringify([artGap(a), out.sort()]);
}

/** Everything that shapes the prepared lines, for caching and spotting stale patterns. */
export function artLineKey(a: Artwork): string {
  const widths = Object.fromEntries(Object.entries(a.layers ?? {}).map(([name, l]) => [name, l.lineWidth]));
  return JSON.stringify([thinKey(a), artLineWidth(a), !!a.lineWeights, widths, a.widths ?? []]);
}

const thinLineCache = new WeakMap<Contour[], Map<string, Line[]>>();
const thinGraphCache = new WeakMap<Contour[], Map<string, Graph>>();
const lineCache = new WeakMap<Contour[], Map<string, Line[]>>();

/**
 * The drawing as thin lines, with loose ends joined. Lines on left-out layers
 * still count when joining gaps (so lines that ran up to them keep reaching
 * them), then are dropped. Each line remembers the contour it came from.
 */
export function thinLines(a: Artwork): Line[] {
  return cached(thinLineCache, a, thinKey(a), () =>
    extendLooseEnds(cleanLines(a.contours, (c) => !layerIncluded(a, c.layer)), artGap(a)).filter((l) => !l.skip),
  );
}

/** The thin drawing split into pieces between junctions: what line widths are painted onto. */
export function thinGraph(a: Artwork): Graph {
  return cached(thinGraphCache, a, thinKey(a), () => buildGraph(thinLines(a), artGap(a) * 0.25));
}

/** Width of each thin-graph piece: a painted width, or its line's layer width. */
export function pieceWidths(a: Artwork): number[] {
  const lines = thinLines(a);
  const g = thinGraph(a);
  const maxWeight = maxLineWeight(a);
  const painted = new Map<number, number>();
  const tol = matchTolerance(a);
  for (const w of a.widths ?? []) {
    const ci = nearestChain(g.verts, g.chains, w.at, tol);
    if (ci >= 0) painted.set(ci, w.width);
  }
  const lineOfChain = chainLines(g);
  return g.chains.map((_, ci) => {
    if (painted.has(ci)) return painted.get(ci)!;
    const line = lines[lineOfChain[ci]];
    return line && !line.closed ? contourWidth(a, a.contours[line.src!], maxWeight) : 0;
  });
}

/** The source line of each chain (from its first edge). */
export function chainLines(g: Graph): number[] {
  const edgeIndex = new Map(g.edges.map(([u, v], e) => [edgeKey(u, v), e]));
  return g.chains.map((c) => g.src[edgeIndex.get(edgeKey(c.verts[0], c.verts[1])) ?? 0]?.line ?? -1);
}

/**
 * The prepared drawing: closed shapes as they are, single lines thickened into
 * bands where they have a width (merged where they overlap), thin elsewhere.
 */
export function artLines(a: Artwork): Line[] {
  return cached(lineCache, a, artLineKey(a), () => {
    const lines = thinLines(a);
    const g = thinGraph(a);
    const widths = pieceWidths(a);
    const strip = (l: Line): Line => ({ pts: l.pts, closed: l.closed, src: l.src, kind: l.closed ? "shape" : "thin" });
    if (widths.every((w) => w <= 0)) return lines.map(strip);

    // Width along each open line, from the pieces its edges belong to.
    const chainOfEdge = new Map<string, number>();
    g.chains.forEach((c, ci) => {
      const n = c.verts.length;
      for (let k = 0; k < (c.closed ? n : n - 1); k++) chainOfEdge.set(edgeKey(c.verts[k], c.verts[(k + 1) % n]), ci);
    });
    const spans: { from: number; to: number; width: number }[][] = lines.map(() => []);
    g.edges.forEach(([u, v], e) => {
      const { line, from, to } = g.src[e];
      if (lines[line].closed) return;
      const ci = chainOfEdge.get(edgeKey(u, v));
      spans[line].push({ from: Math.min(from, to), to: Math.max(from, to), width: ci === undefined ? 0 : widths[ci] });
    });

    // A band that ends at or inside a filled shape drawn over it carries on a little
    // into the shape, so both its edges meet the shape's outline (the rest is hidden).
    const over = occluders(a).filter((s) => s.coversBands);
    const underShape = ([x, y]: Pt) =>
      over.some((s) => x >= s.minX && x <= s.maxX && y >= s.minY && y <= s.maxY && insidePolygon(x, y, s.pts));

    const out: Line[] = [];
    const banded: Line[] = [];
    lines.forEach((l, li) => {
      if (l.closed) {
        out.push(strip(l));
        return;
      }
      for (const run of widthRuns(l, spans[li])) {
        if (run.width > 0) banded.push({ pts: over.length ? extendIntoShapes(run.pts, run.width, underShape) : run.pts, closed: false, width: run.width });
        else out.push({ pts: run.pts, closed: false, src: l.src, kind: "thin" });
      }
    });
    if (banded.length) out.push(...strokeLines(banded).map((b): Line => ({ ...b, kind: "band" })));
    return out;
  });
}

export interface Occluder {
  pts: Pt[];
  /** Drawing order (contour index): it hides lines drawn before it. */
  order: number;
  /** No single line drawn after it crosses its box, so bands under it can be hidden too. */
  coversBands: boolean;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

const occluderCache = new WeakMap<Contour[], Map<string, Occluder[]>>();

/**
 * Filled shapes that hide what was drawn before them, as in the source file:
 * where a line runs under one, that part of the line is dropped. Shapes over a
 * quarter of the artwork's area are left out so a big frame can't hide
 * everything.
 */
export function occluders(a: Artwork): Occluder[] {
  return cached(occluderCache, a, thinKey(a), () => {
    const box = (c: Contour) => {
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (let i = 0; i + 1 < c.pts.length; i += 2) {
        minX = Math.min(minX, c.pts[i]);
        maxX = Math.max(maxX, c.pts[i]);
        minY = Math.min(minY, c.pts[i + 1]);
        maxY = Math.max(maxY, c.pts[i + 1]);
      }
      return { minX, minY, maxX, maxY };
    };
    const area = (c: Contour) => {
      let s = 0;
      const n = c.pts.length / 2;
      for (let i = 0, j = n - 1; i < n; j = i++) s += (c.pts[j * 2] - c.pts[i * 2]) * (c.pts[j * 2 + 1] + c.pts[i * 2 + 1]);
      return Math.abs(s / 2);
    };
    const limit = 0.25 * a.w0 * a.h0;
    const boxes = a.contours.map(box);
    const out: Occluder[] = [];
    a.contours.forEach((c, i) => {
      if (!c.closed || !c.filled || !layerIncluded(a, c.layer) || area(c) > limit) return;
      const b = boxes[i];
      const crossedLater = a.contours.some(
        (o, j) =>
          j > i &&
          !o.closed &&
          layerIncluded(a, o.layer) &&
          boxes[j].minX <= b.maxX &&
          boxes[j].maxX >= b.minX &&
          boxes[j].minY <= b.maxY &&
          boxes[j].maxY >= b.minY,
      );
      const pts: Pt[] = [];
      for (let k = 0; k + 1 < c.pts.length; k += 2) pts.push([c.pts[k], c.pts[k + 1]]);
      out.push({ pts, order: i, coversBands: !crossedLater, ...b });
    });
    return out;
  });
}

function insidePolygon(x: number, y: number, pts: Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i];
    const [xj, yj] = pts[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Extends a band's centre line straight on by its width at each end that runs into a shape. */
function extendIntoShapes(pts: Pt[], width: number, underShape: (p: Pt) => boolean): Pt[] {
  const n = pts.length;
  const reach = (end: Pt, from: (i: number) => Pt): Pt | null => {
    // Direction over a short stretch, ignoring tiny segments.
    let k = 1;
    let back = from(k);
    while (k < n - 1 && Math.hypot(end[0] - back[0], end[1] - back[1]) < width * 0.25) back = from(++k);
    const d = Math.hypot(end[0] - back[0], end[1] - back[1]);
    if (d === 0) return null;
    const ux = (end[0] - back[0]) / d;
    const uy = (end[1] - back[1]) / d;
    const probe: Pt = [end[0] + ux * width * 0.5, end[1] + uy * width * 0.5];
    return underShape(probe) ? [end[0] + ux * width, end[1] + uy * width] : null;
  };
  const start = reach(pts[0], (i) => pts[i]);
  const end = reach(pts[n - 1], (i) => pts[n - 1 - i]);
  return [...(start ? [start] : []), ...pts, ...(end ? [end] : [])];
}

/** Cuts an open line into stretches of equal width (uncovered bits take the width before them). */
function widthRuns(l: Line, spans: { from: number; to: number; width: number }[]): { pts: Pt[]; width: number }[] {
  const end = l.pts.length - 1;
  spans.sort((p, q) => p.from - q.from);
  const runs: { from: number; to: number; width: number }[] = [];
  let at = 0;
  let width = spans[0]?.width ?? 0;
  for (const s of spans) {
    if (s.width !== width) {
      if (s.from > at) runs.push({ from: at, to: s.from, width });
      at = s.from;
      width = s.width;
    }
  }
  if (end > at) runs.push({ from: at, to: end, width });
  const point = (p: number): Pt => {
    const i = Math.min(Math.floor(p), end - 1);
    const t = p - i;
    const a = l.pts[i];
    const b = l.pts[i + 1];
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  };
  return runs.map((r) => {
    const pts: Pt[] = [point(r.from)];
    for (let k = Math.floor(r.from) + 1; k < r.to; k++) pts.push(l.pts[k]);
    pts.push(point(r.to));
    return { pts, width: r.width };
  });
}

function cleanLines(contours: Contour[], skipped: (c: Contour) => boolean): Line[] {
  const lines: Line[] = [];
  contours.forEach((c, ci) => {
    const pts: Pt[] = [];
    for (let i = 0; i + 1 < c.pts.length; i += 2) {
      const p: Pt = [c.pts[i], c.pts[i + 1]];
      const last = pts[pts.length - 1];
      if (!last || last[0] !== p[0] || last[1] !== p[1]) pts.push(p);
    }
    if (c.closed && pts.length > 1 && pts[0][0] === pts[pts.length - 1][0] && pts[0][1] === pts[pts.length - 1][1]) pts.pop();
    if (pts.length >= (c.closed ? 3 : 2)) lines.push({ pts, closed: c.closed, skip: skipped(c), src: ci });
  });
  return lines;
}

/**
 * Extends each loose end that stops short of another line. It carries on in its
 * own direction if that reaches a line within three times `gap` (and not much
 * further than the nearest line), so the join doesn't kink; otherwise it goes
 * to the nearest line within `gap`. Extensions overshoot by a hair so the
 * crossing is found reliably later.
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
      if (rayD < Infinity && (!near || rayD <= 3 * nearD)) return [P[0] + dir[0] * (rayD + overshoot), P[1] + dir[1] * (rayD + overshoot)];
      if (near) {
        const d = Math.hypot(near[0] - P[0], near[1] - P[1]);
        const ux = d > overshoot ? (near[0] - P[0]) / d : dir[0];
        const uy = d > overshoot ? (near[1] - P[1]) / d : dir[1];
        return [near[0] + ux * overshoot, near[1] + uy * overshoot];
      }
      return null;
    });
    const pts = [...(ends[0] ? [ends[0]] : []), ...l.pts, ...(ends[1] ? [ends[1]] : [])];
    return { ...l, pts };
  });
}

/** Thickens open lines into bands of their widths, merged where they overlap. */
function strokeLines(open: Line[]): Line[] {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxWidth = 0;
  for (const l of open) {
    maxWidth = Math.max(maxWidth, l.width ?? 0);
    for (const [x, y] of l.pts) {
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }
  // Clipper works in integers: map the drawing onto roughly a million units.
  const scale = 1e6 / (Math.hypot(maxX - minX, maxY - minY) + maxWidth || 1);
  const byWidth = new Map<number, ClipperLib.Paths>();
  for (const l of open) {
    const path = l.pts.map(([x, y]) => ({ X: Math.round(x * scale), Y: Math.round(y * scale) }));
    const list = byWidth.get(l.width!);
    if (list) list.push(path);
    else byWidth.set(l.width!, [path]);
  }
  let bands: ClipperLib.Paths = [];
  for (const [width, paths] of byWidth) {
    const co = new ClipperLib.ClipperOffset(2, 0.25);
    co.AddPaths(paths, ClipperLib.JoinType.jtMiter, ClipperLib.EndType.etOpenButt);
    const out: ClipperLib.Paths = [];
    co.Execute(out, (width / 2) * scale);
    bands.push(...out);
  }
  // Bands of different widths are offset separately, so merge them where they overlap.
  if (byWidth.size > 1) {
    const c = new ClipperLib.Clipper();
    c.AddPaths(bands, ClipperLib.PolyType.ptSubject, true);
    const merged: ClipperLib.Paths = [];
    c.Execute(ClipperLib.ClipType.ctUnion, merged, ClipperLib.PolyFillType.pftNonZero, ClipperLib.PolyFillType.pftNonZero);
    bands = merged;
  }
  return ClipperLib.Clipper.CleanPolygons(bands, 2)
    .filter((p) => p.length >= 3)
    .map((p) => ({ closed: true, pts: p.map((q): Pt => [q.X / scale, q.Y / scale]) }));
}
