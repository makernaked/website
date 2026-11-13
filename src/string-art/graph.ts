import type { Pt } from "./types";

/**
 * A line drawing as a graph: lines are split wherever they cross or meet, giving
 * vertices, edges, and chains (runs of edges between junctions, or closed loops).
 */

export interface GraphLine {
  pts: Pt[];
  closed: boolean;
}

export interface Graph {
  verts: Pt[];
  edges: [number, number][];
  /** Where each edge came from: its source line, and its span along it (segment index + fraction). */
  src: { line: number; from: number; to: number }[];
  chains: { verts: number[]; closed: boolean }[];
}

export const edgeKey = (u: number, v: number) => (u < v ? `${u},${v}` : `${v},${u}`);

/**
 * `stub`: loose bits shorter than this, left where a line overshoots another, are dropped.
 * `keep`: optionally drops edges (after splitting, so a line can be dropped part-way).
 */
export function buildGraph(
  lines: GraphLine[],
  stub: number,
  keep?: (edge: [number, number], src: Graph["src"][number], verts: Pt[]) => boolean,
): Graph {
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
  if (!lines.length) return { verts: [], edges: [], src: [], chains: [] };
  const diag = Math.hypot(maxX - minX, maxY - minY) || 1;

  // Segments, each collecting the points where it must be split.
  const sa: Pt[] = [];
  const sb: Pt[] = [];
  const sLine: number[] = [];
  const sIdx: number[] = [];
  const splits: { t: number; p: Pt }[][] = [];
  const lineSegs: number[][] = lines.map((l, li) => {
    const ids: number[] = [];
    const n = l.pts.length;
    for (let i = 0; i < (l.closed ? n : n - 1); i++) {
      sa.push(l.pts[i]);
      sb.push(l.pts[(i + 1) % n]);
      sLine.push(li);
      sIdx.push(i);
      splits.push([]);
      ids.push(sa.length - 1);
    }
    return ids;
  });

  // Uniform grid over segments.
  const cell = diag / 160;
  const gx = Math.ceil((maxX - minX) / cell) + 3;
  const gy = Math.ceil((maxY - minY) / cell) + 3;
  const grid = new Map<number, number[]>();
  const ci = (x: number) => Math.max(0, Math.min(gx - 1, Math.floor((x - minX) / cell) + 1));
  const cj = (y: number) => Math.max(0, Math.min(gy - 1, Math.floor((y - minY) / cell) + 1));
  for (let s = 0; s < sa.length; s++) {
    const a = sa[s];
    const b = sb[s];
    for (let j = cj(Math.min(a[1], b[1])); j <= cj(Math.max(a[1], b[1])); j++)
      for (let i = ci(Math.min(a[0], b[0])); i <= ci(Math.max(a[0], b[0])); i++) {
        const k = j * gx + i;
        const list = grid.get(k);
        if (list) list.push(s);
        else grid.set(k, [s]);
      }
  }

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

  // Vertices and unique edges, remembering which line and stretch each edge came from.
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
  let edges: [number, number][] = [];
  let src: Graph["src"] = [];
  for (let s = 0; s < sa.length; s++) {
    const cuts = [{ t: 0, p: sa[s] }, ...splits[s].sort((x, y) => x.t - y.t), { t: 1, p: sb[s] }];
    const chain = cuts.map((c) => vid(c.p));
    for (let k = 1; k < chain.length; k++) {
      const u = chain[k - 1];
      const v = chain[k];
      if (u === v) continue;
      const key = edgeKey(u, v);
      if (edgeSet.has(key)) continue;
      edgeSet.add(key);
      edges.push(u < v ? [u, v] : [v, u]);
      src.push({ line: sLine[s], from: sIdx[s] + Math.max(0, cuts[k - 1].t), to: sIdx[s] + Math.min(1, cuts[k].t) });
    }
  }

  if (keep) {
    const kept = edges.map((e, i) => keep(e, src[i], verts));
    edges = edges.filter((_, i) => kept[i]);
    src = src.filter((_, i) => kept[i]);
  }

  // Drop tiny stubs where a line overshoots the one it ends on, so they don't get nails.
  const nv = verts.length;
  const adj: number[][] = Array.from({ length: nv }, () => []);
  edges.forEach(([u, v], e) => {
    adj[u].push(e);
    adj[v].push(e);
  });
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
  src = src.filter((_, e) => !removed[e]);
  edges = edges.filter((_, e) => !removed[e]);

  return { verts, edges, src, chains: graphChains(nv, edges) };
}

/** Splits a line graph into chains: runs of edges between junctions, or closed loops. */
export function graphChains(nv: number, edges: [number, number][]): { verts: number[]; closed: boolean }[] {
  const adj: number[][] = Array.from({ length: nv }, () => []);
  edges.forEach(([u, v], e) => {
    adj[u].push(e);
    adj[v].push(e);
  });
  const used = new Uint8Array(edges.length);
  const walk = (start: number, first: number) => {
    const verts = [start];
    let v = start;
    let e = first;
    for (;;) {
      used[e] = 1;
      const [a, b] = edges[e];
      const w = a === v ? b : a;
      verts.push(w);
      if (w === start || adj[w].length !== 2) break;
      const next = adj[w].find((x) => !used[x]);
      if (next === undefined) break;
      v = w;
      e = next;
    }
    return verts;
  };
  const out: { verts: number[]; closed: boolean }[] = [];
  for (let v = 0; v < nv; v++) {
    if (!adj[v].length || adj[v].length === 2) continue;
    for (const e of adj[v]) if (!used[e]) out.push({ verts: walk(v, e), closed: false });
  }
  for (let e = 0; e < edges.length; e++) {
    if (used[e]) continue;
    const verts = walk(edges[e][0], e);
    verts.pop();
    out.push({ verts, closed: true });
  }
  return out;
}

function distToSegment(p: Pt, a: Pt, b: Pt): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  const t = len2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2)) : 0;
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

/** Index of the chain closest to `p`, if within `tol`; otherwise -1. */
export function nearestChain(verts: Pt[], chains: Graph["chains"], p: Pt, tol: number): number {
  let best = -1;
  let bestD = tol;
  chains.forEach((c, ci) => {
    const n = c.verts.length;
    for (let i = 0; i < (c.closed ? n : n - 1); i++) {
      const a = verts[c.verts[i]];
      const b = verts[c.verts[(i + 1) % n]];
      if (Math.min(a[0], b[0]) - bestD > p[0] || Math.max(a[0], b[0]) + bestD < p[0]) continue;
      if (Math.min(a[1], b[1]) - bestD > p[1] || Math.max(a[1], b[1]) + bestD < p[1]) continue;
      const d = distToSegment(p, a, b);
      if (d < bestD) {
        bestD = d;
        best = ci;
      }
    }
  });
  return best;
}

/** The point halfway along a chain: what gets saved to find it again later. */
export function chainMidpoint(verts: Pt[], c: Graph["chains"][number]): Pt {
  const n = c.verts.length;
  const segs = c.closed ? n : n - 1;
  let total = 0;
  for (let i = 0; i < segs; i++) {
    const a = verts[c.verts[i]];
    const b = verts[c.verts[(i + 1) % n]];
    total += Math.hypot(b[0] - a[0], b[1] - a[1]);
  }
  let left = total / 2;
  for (let i = 0; i < segs; i++) {
    const a = verts[c.verts[i]];
    const b = verts[c.verts[(i + 1) % n]];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (left <= len) {
      const t = len > 0 ? left / len : 0;
      return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
    }
    left -= len;
  }
  return verts[c.verts[0]];
}
