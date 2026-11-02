import { artToWorld, pointInPolygon, polygonArea, toLocal, toWorld } from "./geometry";
import { buildGraph, chainMidpoint, edgeKey, type Graph, nearestChain } from "./graph";
import { artGap, artLineKey, artLines, layerIncluded, matchTolerance, occluders, thinGraph } from "./outline";
import type { Artwork, Contour, Pt } from "./types";

/**
 * Turns a line drawing into regions, like Live Paint: lines are split where
 * they cross and every enclosed area becomes a region. Works on the prepared
 * lines (see outline.ts) in the artwork's local coordinates, so the result
 * survives moving, scaling and rotating.
 *
 * The user's choices are saved as positions on the artwork: a region's fill as
 * a point inside it, a removed line as a point on it. They find their region
 * or line again after the drawing changes (gap, widths, layers).
 */

export interface Region {
  /** Vertex ids; rings[0] is the outer boundary, the rest are holes. */
  rings: number[][];
  /** The same rings as points, for hit testing and drawing. */
  pts: Pt[][];
  area: number;
  /** Filled unless the user says otherwise: inside an odd number of the drawing's closed outlines. */
  defaultFill: boolean;
  /** A point well inside the region. */
  sample: Pt;
}

export interface Arrangement {
  verts: Pt[];
  /** Line pieces that get nails, including loose ends and gap extensions. */
  edges: [number, number][];
  regions: Region[];
}

interface Base extends Arrangement {
  /** Every line piece before any are removed. */
  graph: Graph;
  /** Closed outlines that decide default fills: shapes from the file, and band outlines. */
  outlines: { shapes: Pt[][]; bands: Pt[][] };
  diag: number;
  bboxArea: number;
}

const baseCache = new WeakMap<Contour[], Map<string, Base>>();
const effectiveCache = new WeakMap<Contour[], Map<string, Arrangement>>();

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

function base(a: Artwork): Base {
  return cached(baseCache, a, artLineKey(a), () => {
    const lines = artLines(a);
    // Parts of lines and bands that run under a filled shape drawn after them are hidden.
    const over = occluders(a);
    const hidden = (line: (typeof lines)[number], [x, y]: Pt) => {
      if (line.kind === "shape") return false;
      for (const s of over) {
        if (x < s.minX || x > s.maxX || y < s.minY || y > s.maxY) continue;
        if (line.kind === "thin" ? (line.src ?? -1) >= s.order : !s.coversBands) continue;
        if (pointInPolygon(x, y, s.pts)) return true;
      }
      return false;
    };
    const keep = over.length
      ? ([u, v]: [number, number], src: Graph["src"][number], verts: Pt[]) =>
          !hidden(lines[src.line], [(verts[u][0] + verts[v][0]) / 2, (verts[u][1] + verts[v][1]) / 2])
      : undefined;
    const graph = buildGraph(lines, artGap(a) * 0.25, keep);
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const [x, y] of graph.verts) {
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
    const diag = Math.hypot(maxX - minX, maxY - minY) || 1;
    const bboxArea = (maxX - minX) * (maxY - minY) || 1;
    const outlines = {
      shapes: lines.filter((l) => l.closed && l.kind !== "band").map((l) => l.pts),
      bands: lines.filter((l) => l.kind === "band").map((l) => l.pts),
    };
    const regions = findRegions(graph.verts, graph.edges, outlines, diag, bboxArea);
    return { verts: graph.verts, edges: graph.edges, regions, graph, outlines, diag, bboxArea };
  });
}

/** Line pieces the user has removed (indices into the line pieces). */
export function cutChains(a: Artwork): Set<number> {
  const g = base(a).graph;
  const tol = matchTolerance(a);
  const out = new Set<number>();
  for (const p of a.cuts ?? []) {
    const ci = nearestChain(g.verts, g.chains, p, tol);
    if (ci >= 0) out.add(ci);
  }
  return out;
}

/** The line piece a saved point sits on, or -1. */
export function chainIndexAt(a: Artwork, p: Pt): number {
  const g = base(a).graph;
  return nearestChain(g.verts, g.chains, p, matchTolerance(a));
}

/** Regions and nail lines with the user's removed lines taken out. */
export function arrangement(a: Artwork): Arrangement {
  const b = base(a);
  if (!a.cuts?.length) return b;
  return cached(effectiveCache, a, `${artLineKey(a)}|${JSON.stringify(a.cuts)}`, () => {
    const cut = new Set<string>();
    for (const ci of cutChains(a)) {
      const c = b.graph.chains[ci];
      const n = c.verts.length;
      for (let k = 0; k < (c.closed ? n : n - 1); k++) cut.add(edgeKey(c.verts[k], c.verts[(k + 1) % n]));
    }
    const edges = b.edges.filter(([u, v]) => !cut.has(edgeKey(u, v)));
    return { verts: b.verts, edges, regions: findRegions(b.verts, edges, b.outlines, b.diag, b.bboxArea) };
  });
}

/** Whether a local point lies in a region (and not in one of its holes). */
export function regionContains(r: Region, p: Pt): boolean {
  return pointInPolygon(p[0], p[1], r.pts[0]) && !r.pts.slice(1).some((h) => pointInPolygon(p[0], p[1], h));
}

/** A saved fill choice inside the region wins (the latest); otherwise the default. */
export function isFilled(a: Artwork, index: number): boolean {
  const r = arrangement(a).regions[index];
  if (!r) return false;
  const fills = a.fills ?? [];
  for (let i = fills.length - 1; i >= 0; i--) if (regionContains(r, fills[i].at)) return fills[i].on;
  return r.defaultFill;
}

const worldCache = new WeakMap<Artwork, Pt[][][]>();

/** Region rings in world coordinates. */
export function worldRegions(a: Artwork): Pt[][][] {
  let w = worldCache.get(a);
  if (!w) {
    const sx = a.w0 > 0 ? a.w / a.w0 : 1;
    const sy = a.h0 > 0 ? a.h / a.h0 : 1;
    w = arrangement(a).regions.map((r) => r.pts.map((ring) => ring.map(([x, y]) => toWorld(a, x * sx, y * sy))));
    worldCache.set(a, w);
  }
  return w;
}

/** Index of the region under a world point, or -1. */
export function regionAt(a: Artwork, x: number, y: number): number {
  const sx = a.w0 > 0 ? a.w / a.w0 : 1;
  const sy = a.h0 > 0 ? a.h / a.h0 : 1;
  const [lx, ly] = toLocal(a, x, y);
  const p: Pt = [lx / sx, ly / sy];
  return arrangement(a).regions.findIndex((r) => regionContains(r, p));
}

const edgeWorldCache = new WeakMap<Artwork, Float64Array>();

/** The line pieces in use, as world segments [x1, y1, x2, y2, ...]; removed lines are left out. */
export function worldEdges(a: Artwork): Float64Array {
  let w = edgeWorldCache.get(a);
  if (!w) {
    const { verts, edges } = arrangement(a);
    const world = verts.map(([x, y]) => artToWorld(a, x, y));
    w = new Float64Array(edges.length * 4);
    edges.forEach(([u, v], i) => w!.set([world[u][0], world[u][1], world[v][0], world[v][1]], i * 4));
    edgeWorldCache.set(a, w);
  }
  return w;
}

const guideCache = new WeakMap<Artwork, { pts: Pt[]; closed: boolean }[]>();

/** Paths on layers that are left out, in world coordinates, to show as guides. */
export function worldLeftOut(a: Artwork): { pts: Pt[]; closed: boolean }[] {
  let w = guideCache.get(a);
  if (!w) {
    w = a.contours
      .filter((c) => !layerIncluded(a, c.layer))
      .map((c) => {
        const pts: Pt[] = [];
        for (let i = 0; i + 1 < c.pts.length; i += 2) pts.push(artToWorld(a, c.pts[i], c.pts[i + 1]));
        return { pts, closed: c.closed };
      });
    guideCache.set(a, w);
  }
  return w;
}

export interface WorldChain {
  pts: Pt[];
  closed: boolean;
  /** Where the piece is saved from (its midpoint, in artwork units). */
  mid: Pt;
}

function toWorldChains(a: Artwork, g: Graph): WorldChain[] {
  return g.chains.map((c) => ({
    closed: c.closed,
    pts: c.verts.map((v) => artToWorld(a, g.verts[v][0], g.verts[v][1])),
    mid: chainMidpoint(g.verts, c),
  }));
}

const chainWorldCache = new WeakMap<Artwork, WorldChain[]>();
const thinWorldCache = new WeakMap<Artwork, WorldChain[]>();

/** Removable line pieces (of the prepared drawing, so band edges too), in world coordinates. */
export function worldChains(a: Artwork): WorldChain[] {
  let w = chainWorldCache.get(a);
  if (!w) {
    w = toWorldChains(a, base(a).graph);
    chainWorldCache.set(a, w);
  }
  return w;
}

/** Pieces of the thin drawing (what widths are painted onto), in world coordinates. */
export function worldThinChains(a: Artwork): WorldChain[] {
  let w = thinWorldCache.get(a);
  if (!w) {
    w = toWorldChains(a, thinGraph(a));
    thinWorldCache.set(a, w);
  }
  return w;
}

/** Index of the chain within `tol` of a world point (closest first), or -1. */
export function worldChainAt(chains: WorldChain[], x: number, y: number, tol: number): number {
  let best = -1;
  let bestD = tol;
  chains.forEach((c, ci) => {
    const n = c.pts.length;
    for (let i = 0; i < (c.closed ? n : n - 1); i++) {
      const p = c.pts[i];
      const q = c.pts[(i + 1) % n];
      if (Math.min(p[0], q[0]) - bestD > x || Math.max(p[0], q[0]) + bestD < x) continue;
      if (Math.min(p[1], q[1]) - bestD > y || Math.max(p[1], q[1]) + bestD < y) continue;
      const dx = q[0] - p[0];
      const dy = q[1] - p[1];
      const len2 = dx * dx + dy * dy;
      const t = len2 ? Math.max(0, Math.min(1, ((x - p[0]) * dx + (y - p[1]) * dy) / len2)) : 0;
      const d = Math.hypot(x - (p[0] + t * dx), y - (p[1] + t * dy));
      if (d < bestD) {
        bestD = d;
        best = ci;
      }
    }
  });
  return best;
}

// ---------------------------------------------------------------------------

/**
 * Enclosed areas of a line graph, with drawings nested inside an area as its holes.
 * Default fill: inside an odd number of the file's shapes; away from shapes,
 * inside an odd number of band outlines (bands passing under a shape don't count).
 */
function findRegions(
  verts: Pt[],
  edges: [number, number][],
  outlines: { shapes: Pt[][]; bands: Pt[][] },
  diag: number,
  bboxArea: number,
): Region[] {
  const nv = verts.length;
  const adj: number[][] = Array.from({ length: nv }, () => []);
  edges.forEach(([u, v], e) => {
    adj[u].push(e);
    adj[v].push(e);
  });

  // Regions only come from cycles, so peel off loose ends first.
  const alive = new Uint8Array(edges.length).fill(1);
  const deg = adj.map((l) => l.length);
  const queue = deg.flatMap((d, v) => (d === 1 ? [v] : []));
  while (queue.length) {
    const v = queue.pop()!;
    for (const e of adj[v]) {
      if (!alive[e]) continue;
      alive[e] = 0;
      const [a, b] = edges[e];
      const o = a === v ? b : a;
      deg[v]--;
      if (--deg[o] === 1) queue.push(o);
    }
  }

  // Trace faces: at each vertex take the next edge clockwise, keeping the face on the left.
  const outs: number[][] = Array.from({ length: nv }, () => []);
  edges.forEach(([u, v], e) => {
    if (!alive[e]) return;
    outs[u].push(v);
    outs[v].push(u);
  });
  const pos = new Map<string, number>();
  outs.forEach((list, v) => {
    list.sort((p, q) => Math.atan2(verts[p][1] - verts[v][1], verts[p][0] - verts[v][0]) - Math.atan2(verts[q][1] - verts[v][1], verts[q][0] - verts[v][0]));
    list.forEach((w, i) => pos.set(`${v},${w}`, i));
  });
  const visited = new Set<string>();
  const faces: number[][] = [];
  for (let v = 0; v < nv; v++) {
    for (let k = 0; k < outs[v].length; k++) {
      if (visited.has(`${v},${k}`)) continue;
      const cycle: number[] = [];
      let u = v;
      let i = k;
      for (let guard = 0; guard <= edges.length * 2; guard++) {
        visited.add(`${u},${i}`);
        cycle.push(u);
        const w = outs[u][i];
        const j = pos.get(`${w},${u}`)!;
        i = (j - 1 + outs[w].length) % outs[w].length;
        u = w;
        if (u === v && i === k) break;
      }
      faces.push(cycle);
    }
  }

  // Connected components, so drawings nested inside a face become its holes.
  const parent = Array.from({ length: nv }, (_, i) => i);
  const find = (x: number): number => {
    while (parent[x] !== x) x = parent[x] = parent[parent[x]];
    return x;
  };
  edges.forEach(([u, v], e) => {
    if (alive[e]) parent[find(u)] = find(v);
  });

  const ringPts = (ring: number[]) => ring.map((v) => verts[v]);
  const minArea = Math.max(bboxArea * 1e-6, 1e-12);
  const bounded: { ring: number[]; pts: Pt[]; area: number; comp: number; holes: number[][] }[] = [];
  const outer: { ring: number[]; comp: number }[] = [];
  for (const f of faces) {
    const pts = ringPts(f);
    const area = polygonArea(pts);
    if (area > minArea) bounded.push({ ring: f, pts, area, comp: find(f[0]), holes: [] });
    else if (area < 0) outer.push({ ring: f, comp: find(f[0]) });
  }
  for (const o of outer) {
    const [px, py] = verts[o.ring[0]];
    let host: (typeof bounded)[number] | null = null;
    for (const b of bounded) {
      if (b.comp === o.comp || (host && b.area >= host.area)) continue;
      if (pointInPolygon(px, py, b.pts)) host = b;
    }
    host?.holes.push(o.ring);
  }

  const regions = bounded.map((b) => {
    const rings = [b.ring, ...b.holes];
    const pts = rings.map(ringPts);
    const sample = interiorPoint(pts);
    const count = (list: Pt[][]) => list.reduce((n, l) => n + (pointInPolygon(sample[0], sample[1], l) ? 1 : 0), 0);
    const inShapes = count(outlines.shapes);
    const inside = inShapes > 0 ? inShapes : count(outlines.bands);
    let top = -Infinity;
    let left = Infinity;
    for (const [x, y] of pts[0]) {
      top = Math.max(top, y);
      left = Math.min(left, x);
    }
    return { rings, pts, area: b.area, defaultFill: inside % 2 === 1, sample, top, left };
  });
  // Stable order (top to bottom, left to right).
  regions.sort((a, b) => (Math.abs(a.top - b.top) > diag * 1e-4 ? b.top - a.top : a.left - b.left));
  return regions.map(({ rings, pts, area, defaultFill, sample }) => ({ rings, pts, area, defaultFill, sample }));
}

/** A point well inside a polygon with holes: the middle of the widest horizontal span. */
function interiorPoint(rings: Pt[][]): Pt {
  let minY = Infinity;
  let maxY = -Infinity;
  for (const [, y] of rings[0]) {
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  }
  let best: Pt = rings[0][0];
  let bestW = -1;
  for (const f of [0.5, 0.3, 0.7, 0.15, 0.85, 0.4, 0.6]) {
    const y = minY + (maxY - minY) * f;
    const xs: number[] = [];
    for (const r of rings)
      for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
        const [x1, y1] = r[j];
        const [x2, y2] = r[i];
        if (y1 > y !== y2 > y) xs.push(x1 + ((y - y1) * (x2 - x1)) / (y2 - y1));
      }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      if (xs[k + 1] - xs[k] > bestW) {
        bestW = xs[k + 1] - xs[k];
        best = [(xs[k] + xs[k + 1]) / 2, y];
      }
    }
  }
  return best;
}
