import { pointInPolygon, polygonArea, toLocal, toWorld } from "./geometry";
import { artGap, artLines, artLineWidth, type Line } from "./outline";
import type { Artwork, Contour, Pt } from "./types";

/**
 * Turns a line drawing into regions, like Live Paint: lines are split where
 * they cross and every enclosed area becomes a region. Works on the prepared
 * lines (see outline.ts) in the artwork's local coordinates, so the result
 * survives moving, scaling and rotating.
 */

export interface Region {
  /** Vertex ids; rings[0] is the outer boundary, the rest are holes. */
  rings: number[][];
  /** The same rings as points, for hit testing and drawing. */
  pts: Pt[][];
  area: number;
  /** Filled unless the user says otherwise: inside an odd number of the drawing's closed outlines. */
  defaultFill: boolean;
}

export interface Arrangement {
  verts: Pt[];
  /** Every line piece, including loose ends and gap extensions (nails go on all of them). */
  edges: [number, number][];
  regions: Region[];
}

const cache = new WeakMap<Contour[], Map<string, Arrangement>>();

export function arrangement(a: Artwork): Arrangement {
  const gap = artGap(a);
  const key = `${gap}|${artLineWidth(a)}`;
  let byKey = cache.get(a.contours);
  if (!byKey) {
    byKey = new Map();
    cache.set(a.contours, byKey);
  }
  let r = byKey.get(key);
  if (!r) {
    r = buildArrangement(artLines(a), gap * 0.25);
    byKey.set(key, r);
  }
  return r;
}

export function isFilled(a: Artwork, index: number): boolean {
  return a.fill?.[index] ?? arrangement(a).regions[index]?.defaultFill ?? false;
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
  const px = lx / sx;
  const py = ly / sy;
  return arrangement(a).regions.findIndex(
    (r) => pointInPolygon(px, py, r.pts[0]) && !r.pts.slice(1).some((h) => pointInPolygon(px, py, h)),
  );
}

// ---------------------------------------------------------------------------

/** `stub`: loose bits shorter than this, left where a line overshoots another, are dropped. */
export function buildArrangement(lines: Line[], stub: number): Arrangement {
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
  if (!lines.length) return { verts: [], edges: [], regions: [] };
  const diag = Math.hypot(maxX - minX, maxY - minY) || 1;

  // Segments, each collecting the points where it must be split.
  const sa: Pt[] = [];
  const sb: Pt[] = [];
  const sLine: number[] = [];
  const sIdx: number[] = [];
  const splits: { t: number; p: Pt }[][] = [];
  const addSeg = (a: Pt, b: Pt, line: number, idx: number) => {
    sa.push(a);
    sb.push(b);
    sLine.push(line);
    sIdx.push(idx);
    splits.push([]);
    return sa.length - 1;
  };
  const lineSegs: number[][] = lines.map((l, li) => {
    const ids: number[] = [];
    const n = l.pts.length;
    for (let i = 0; i < (l.closed ? n : n - 1); i++) ids.push(addSeg(l.pts[i], l.pts[(i + 1) % n], li, i));
    return ids;
  });

  // Uniform grid over segments.
  const cell = diag / 160;
  const gx = Math.ceil((maxX - minX) / cell) + 3;
  const gy = Math.ceil((maxY - minY) / cell) + 3;
  const grid = new Map<number, number[]>();
  const ci = (x: number) => Math.max(0, Math.min(gx - 1, Math.floor((x - minX) / cell) + 1));
  const cj = (y: number) => Math.max(0, Math.min(gy - 1, Math.floor((y - minY) / cell) + 1));
  const insert = (s: number) => {
    const a = sa[s];
    const b = sb[s];
    for (let j = cj(Math.min(a[1], b[1])); j <= cj(Math.max(a[1], b[1])); j++)
      for (let i = ci(Math.min(a[0], b[0])); i <= ci(Math.max(a[0], b[0])); i++) {
        const k = j * gx + i;
        const list = grid.get(k);
        if (list) list.push(s);
        else grid.set(k, [s]);
      }
  };
  for (let s = 0; s < sa.length; s++) insert(s);

  // Split every pair of crossing segments at the crossing point.
  const snap = diag * 1e-7;
  const near = (p: Pt, q: Pt) => Math.abs(p[0] - q[0]) <= snap * 10 && Math.abs(p[1] - q[1]) <= snap * 10;
  const stamp = new Int32Array(sa.length).fill(-1);
  for (let s = 0; s < sa.length; s++) {
    const a = sa[s];
    const b = sb[s];
    for (let j = cj(Math.min(a[1], b[1])); j <= cj(Math.max(a[1], b[1])); j++)
      for (let i = ci(Math.min(a[0], b[0])); i <= ci(Math.max(a[0], b[0])); i++)
        for (const o of grid.get(j * gx + i) ?? []) {
          if (o <= s || stamp[o] === s) continue;
          stamp[o] = s;
          if (sLine[o] === sLine[s]) {
            const n = lineSegs[sLine[s]].length;
            const d = Math.abs(sIdx[o] - sIdx[s]);
            if (d === 1 || (lines[sLine[s]].closed && d === n - 1)) continue;
          }
          const c = sa[o];
          const d = sb[o];
          const rx = b[0] - a[0];
          const ry = b[1] - a[1];
          const qx = d[0] - c[0];
          const qy = d[1] - c[1];
          const den = rx * qy - ry * qx;
          if (Math.abs(den) <= 1e-12 * Math.hypot(rx, ry) * Math.hypot(qx, qy)) continue;
          const t = ((c[0] - a[0]) * qy - (c[1] - a[1]) * qx) / den;
          const u = ((c[0] - a[0]) * ry - (c[1] - a[1]) * rx) / den;
          const e = 1e-9;
          if (t < -e || t > 1 + e || u < -e || u > 1 + e) continue;
          let p: Pt = [a[0] + t * rx, a[1] + t * ry];
          // Reuse an existing end point if the crossing is on one, so both segments agree.
          for (const q of [a, b, c, d]) if (near(p, q)) p = q;
          splits[s].push({ t, p });
          splits[o].push({ t: u, p });
        }
  }

  // Vertices and unique edges.
  const verts: Pt[] = [];
  const ids = new Map<string, number>();
  const vid = (p: Pt) => {
    const k = `${Math.round(p[0] / snap)},${Math.round(p[1] / snap)}`;
    let v = ids.get(k);
    if (v === undefined) {
      v = verts.length;
      verts.push(p);
      ids.set(k, v);
    }
    return v;
  };
  const edgeSet = new Set<string>();
  const edges: [number, number][] = [];
  for (let s = 0; s < sa.length; s++) {
    const chain = [sa[s], ...splits[s].sort((x, y) => x.t - y.t).map((x) => x.p), sb[s]].map(vid);
    for (let k = 1; k < chain.length; k++) {
      const u = chain[k - 1];
      const v = chain[k];
      if (u === v) continue;
      const key = u < v ? `${u},${v}` : `${v},${u}`;
      if (edgeSet.has(key)) continue;
      edgeSet.add(key);
      edges.push(u < v ? [u, v] : [v, u]);
    }
  }

  const nv = verts.length;
  const adj: number[][] = Array.from({ length: nv }, () => []);
  edges.forEach(([u, v], e) => {
    adj[u].push(e);
    adj[v].push(e);
  });

  // Drop tiny stubs where a line overshoots the one it ends on, so they don't get nails.
  const removed = new Uint8Array(edges.length);
  for (let v0 = 0; v0 < nv; v0++) {
    if (adj[v0].length !== 1) continue;
    const path: number[] = [];
    let v = v0;
    let len = 0;
    let prev = -1;
    while (len < stub) {
      const e = adj[v].find((x) => x !== prev);
      if (e === undefined) break;
      const [a, b] = edges[e];
      const w = a === v ? b : a;
      len += Math.hypot(verts[w][0] - verts[v][0], verts[w][1] - verts[v][1]);
      path.push(e);
      prev = e;
      v = w;
      if (adj[v].length !== 2) break;
    }
    if (len < stub && adj[v].length > 2) for (const e of path) removed[e] = 1;
  }
  if (removed.some((x) => x)) {
    const kept = edges.filter((_, e) => !removed[e]);
    edges.length = 0;
    edges.push(...kept);
    adj.forEach((l) => (l.length = 0));
    edges.forEach(([u, v], e) => {
      adj[u].push(e);
      adj[v].push(e);
    });
  }

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
  const bboxArea = (maxX - minX) * (maxY - minY);
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

  const closedLines = lines.filter((l) => l.closed).map((l) => l.pts);
  const regions: (Region & { top: number; left: number })[] = bounded.map((b) => {
    const rings = [b.ring, ...b.holes];
    const pts = rings.map(ringPts);
    const [sx, sy] = interiorPoint(pts);
    const inside = closedLines.reduce((n, l) => n + (pointInPolygon(sx, sy, l) ? 1 : 0), 0);
    let top = -Infinity;
    let left = Infinity;
    for (const [x, y] of pts[0]) {
      top = Math.max(top, y);
      left = Math.min(left, x);
    }
    return { rings, pts, area: b.area, defaultFill: inside % 2 === 1, top, left };
  });
  // Stable order (top to bottom, left to right) so saved fill choices keep pointing at the same regions.
  regions.sort((a, b) => (Math.abs(a.top - b.top) > diag * 1e-4 ? b.top - a.top : a.left - b.left));
  return { verts, edges, regions: regions.map(({ rings, pts, area, defaultFill }) => ({ rings, pts, area, defaultFill })) };
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
