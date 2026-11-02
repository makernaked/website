import { distToSegment, rng, segmentsTouch } from "./geometry";
import type { Pt } from "./types";

export interface FillOptions {
  /** Total length of string to lay inside the shape. */
  targetLength: number;
  seed: number;
  /** First take the string around each edge, nail to neighbouring nail. */
  outline?: boolean;
  /** Then around each edge from every nail to the one two along. */
  edges?: boolean;
}

/**
 * Filled-silhouette stringing. The string goes nail to nail across the inside
 * of the shape; each next nail is picked greedily to cover the least-covered
 * part of the shape, so the fill comes out even. Lines never leave the shape
 * or cross a hole.
 *
 * `rings[0]` is the outer boundary and any further rings are holes. Returns
 * the stringing order as indices into the rings concatenated in order.
 */
export function fillIsland(rings: Pt[][], opts: FillOptions): number[] {
  const nodes: Pt[] = [];
  const ringOf: number[] = [];
  const posInRing: number[] = [];
  const ringStart: number[] = [];
  rings.forEach((r, ri) => {
    ringStart.push(nodes.length);
    r.forEach((p, k) => {
      nodes.push(p);
      ringOf.push(ri);
      posInRing.push(k);
    });
  });
  const n = nodes.length;
  if (n < 4) return [];

  const ringNext = (i: number) => {
    const r = ringOf[i];
    return ringStart[r] + ((posInRing[i] + 1) % rings[r].length);
  };

  // Boundary edges as node index pairs.
  const ea: number[] = [];
  const eb: number[] = [];
  rings.forEach((r, ri) => {
    for (let k = 0; k < r.length; k++) {
      ea.push(ringStart[ri] + k);
      eb.push(ringStart[ri] + ((k + 1) % r.length));
    }
  });
  const E = ea.length;

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let edgeSum = 0;
  for (const [x, y] of nodes) {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  for (let e = 0; e < E; e++) {
    const a = nodes[ea[e]];
    const b = nodes[eb[e]];
    edgeSum += Math.hypot(b[0] - a[0], b[1] - a[1]);
  }
  const avgEdge = edgeSum / E;
  const W = Math.max(maxX - minX, 1e-6);
  const H = Math.max(maxY - minY, 1e-6);

  // Uniform grid over boundary edges, for fast intersection queries.
  const cell = Math.max(avgEdge * 2, Math.max(W, H) / 128);
  const gx = Math.ceil(W / cell) + 1;
  const gy = Math.ceil(H / cell) + 1;
  const grid: number[][] = Array.from({ length: gx * gy }, () => []);
  const rowEdges: number[][] = Array.from({ length: gy }, () => []);
  const cx = (x: number) => Math.min(gx - 1, Math.max(0, Math.floor((x - minX) / cell)));
  const cy = (y: number) => Math.min(gy - 1, Math.max(0, Math.floor((y - minY) / cell)));
  for (let e = 0; e < E; e++) {
    const a = nodes[ea[e]];
    const b = nodes[eb[e]];
    const x0 = cx(Math.min(a[0], b[0]));
    const x1 = cx(Math.max(a[0], b[0]));
    const y0 = cy(Math.min(a[1], b[1]));
    const y1 = cy(Math.max(a[1], b[1]));
    for (let y = y0; y <= y1; y++) {
      rowEdges[y].push(e);
      for (let x = x0; x <= x1; x++) grid[y * gx + x].push(e);
    }
  }

  const edgeStamp = new Int32Array(E);
  let stamp = 0;

  const inside = (px: number, py: number) => {
    let c = false;
    for (const e of rowEdges[cy(py)]) {
      const [xi, yi] = nodes[ea[e]];
      const [xj, yj] = nodes[eb[e]];
      if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) c = !c;
    }
    return c;
  };

  const nearBoundary = (p: Pt, eps: number) => {
    const x0 = cx(p[0] - eps);
    const x1 = cx(p[0] + eps);
    const y0 = cy(p[1] - eps);
    const y1 = cy(p[1] + eps);
    for (let y = y0; y <= y1; y++)
      for (let x = x0; x <= x1; x++)
        for (const e of grid[y * gx + x]) if (distToSegment(p, nodes[ea[e]], nodes[eb[e]]) < eps) return true;
    return false;
  };

  const crossesBoundary = (a: number, b: number) => {
    const A = nodes[a];
    const B = nodes[b];
    stamp++;
    // Walk the grid cells along the segment (Amanatides & Woo).
    let x = cx(A[0]);
    let y = cy(A[1]);
    const xEnd = cx(B[0]);
    const yEnd = cy(B[1]);
    const dx = B[0] - A[0];
    const dy = B[1] - A[1];
    const stepX = dx > 0 ? 1 : -1;
    const stepY = dy > 0 ? 1 : -1;
    const tDeltaX = dx !== 0 ? Math.abs(cell / dx) : Infinity;
    const tDeltaY = dy !== 0 ? Math.abs(cell / dy) : Infinity;
    let tMaxX = dx !== 0 ? (minX + (x + (dx > 0 ? 1 : 0)) * cell - A[0]) / dx : Infinity;
    let tMaxY = dy !== 0 ? (minY + (y + (dy > 0 ? 1 : 0)) * cell - A[1]) / dy : Infinity;
    for (let guard = 0; guard < gx + gy + 4; guard++) {
      for (const e of grid[y * gx + x]) {
        if (edgeStamp[e] === stamp) continue;
        edgeStamp[e] = stamp;
        const p = ea[e];
        const q = eb[e];
        if (p === a || p === b || q === a || q === b) continue;
        if (segmentsTouch(A, B, nodes[p], nodes[q])) return true;
      }
      if (x === xEnd && y === yEnd) break;
      if (tMaxX < tMaxY) {
        tMaxX += tDeltaX;
        x += stepX;
      } else {
        tMaxY += tDeltaY;
        y += stepY;
      }
      if (x < 0 || y < 0 || x >= gx || y >= gy) break;
    }
    return false;
  };

  const cacheable = n <= 3000;
  const visCache = cacheable ? new Int8Array(n * n) : null;
  const visMap = cacheable ? null : new Map<number, boolean>();
  const boundaryEps = avgEdge * 0.05;

  const computeVisible = (a: number, b: number) => {
    if (ringOf[a] === ringOf[b]) {
      const len = rings[ringOf[a]].length;
      const d = Math.abs(posInRing[a] - posInRing[b]);
      if (Math.min(d, len - d) < 2) return false;
    }
    const A = nodes[a];
    const B = nodes[b];
    const mid: Pt = [(A[0] + B[0]) / 2, (A[1] + B[1]) / 2];
    if (!inside(mid[0], mid[1])) return false;
    if (nearBoundary(mid, boundaryEps)) return false;
    return !crossesBoundary(a, b);
  };

  const visible = (a: number, b: number) => {
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    const key = lo * n + hi;
    if (visCache) {
      const v = visCache[key];
      if (v) return v === 1;
      const r = computeVisible(lo, hi);
      visCache[key] = r ? 1 : 2;
      return r;
    }
    let r = visMap!.get(key);
    if (r === undefined) {
      r = computeVisible(lo, hi);
      visMap!.set(key, r);
    }
    return r;
  };

  // Coverage raster limited to the inside of the shape.
  const g = Math.max(W, H) / 160;
  const rw = Math.ceil(W / g) + 1;
  const rh = Math.ceil(H / g) + 1;
  const mask = new Uint8Array(rw * rh);
  const cov = new Float32Array(rw * rh);
  const xs: number[] = [];
  for (let j = 0; j < rh; j++) {
    const py = minY + (j + 0.5) * g;
    xs.length = 0;
    for (let e = 0; e < E; e++) {
      const [x1, y1] = nodes[ea[e]];
      const [x2, y2] = nodes[eb[e]];
      if (y1 > py !== y2 > py) xs.push(x1 + ((py - y1) * (x2 - x1)) / (y2 - y1));
    }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const i0 = Math.max(0, Math.ceil((xs[k] - minX) / g - 0.5));
      const i1 = Math.min(rw - 1, Math.floor((xs[k + 1] - minX) / g - 0.5));
      for (let i = i0; i <= i1; i++) mask[j * rw + i] = 1;
    }
  }

  const lineCells = (a: number, b: number, visit: (cell: number) => void) => {
    const A = nodes[a];
    const B = nodes[b];
    const len = Math.hypot(B[0] - A[0], B[1] - A[1]);
    const steps = Math.max(1, Math.ceil(len / g));
    let last = -1;
    for (let k = 0; k < steps; k++) {
      const t = (k + 0.5) / steps;
      const i = Math.floor((A[0] + (B[0] - A[0]) * t - minX) / g);
      const j = Math.floor((A[1] + (B[1] - A[1]) * t - minY) / g);
      if (i < 0 || j < 0 || i >= rw || j >= rh) continue;
      const c = j * rw + i;
      if (c !== last && mask[c]) visit(c);
      last = c;
    }
  };

  const score = (a: number, b: number) => {
    let s = 0;
    lineCells(a, b, (c) => {
      const w = 1 / (1 + cov[c]);
      s += w * w;
    });
    return s;
  };

  const random = rng(opts.seed);
  // Rough line count for the target, to cap how often any one nail is wrapped.
  let cells = 0;
  for (let c = 0; c < mask.length; c++) cells += mask[c];
  const estLines = opts.targetLength / Math.max(Math.sqrt(cells) * g * 0.7, 1e-9);
  const maxUse = Math.max(6, Math.ceil((4 * estLines) / n));
  const maxLines = n * 40;
  const use = new Uint16Array(n);
  const used = new Set<number>();
  const all = Array.from({ length: n }, (_, i) => i);
  const sampleSize = 300;

  // Nearest nails to each nail, found by searching outward through a grid.
  const nodeGrid: number[][] = Array.from({ length: gx * gy }, () => []);
  nodes.forEach(([x, y], i) => nodeGrid[cy(y) * gx + cx(x)].push(i));
  const nearCache = new Map<number, number[]>();
  const nearby = (a: number) => {
    const cached = nearCache.get(a);
    if (cached) return cached;
    const out: number[] = [];
    const x0 = cx(nodes[a][0]);
    const y0 = cy(nodes[a][1]);
    const take = (i: number, j: number) => {
      if (i < 0 || j < 0 || i >= gx || j >= gy) return;
      for (const k of nodeGrid[j * gx + i]) if (k !== a) out.push(k);
    };
    for (let r = 0; out.length < sampleSize / 2 && r <= Math.max(gx, gy); r++) {
      if (r === 0) take(x0, y0);
      for (let i = x0 - r; r > 0 && i <= x0 + r; i++) {
        take(i, y0 - r);
        take(i, y0 + r);
      }
      for (let j = y0 - r + 1; r > 0 && j <= y0 + r - 1; j++) {
        take(x0 - r, j);
        take(x0 + r, j);
      }
    }
    nearCache.set(a, out);
    return out;
  };

  let cur = 0;
  const seq = [cur];
  let hops = 0;
  let lines = 0;
  let laid = 0;
  const lay = (b: number) => {
    lineCells(cur, b, (c) => {
      cov[c] += 1;
    });
    used.add(Math.min(b, cur) * n + Math.max(b, cur));
    laid += Math.hypot(nodes[b][0] - nodes[cur][0], nodes[b][1] - nodes[cur][1]);
    use[cur]++;
    use[b]++;
    lines++;
    seq.push(b);
    cur = b;
  };
  /** Along the boundary to the next nail (follows the drawn edge). */
  const step = (b: number) => {
    seq.push(b);
    cur = b;
  };

  // Edge passes, before the fill: an outline lap (nail to neighbouring nail), then
  // every nail to the one two along. They define the edge and fill the corners
  // and curves between neighbouring nails that long lines miss.
  if (opts.outline || opts.edges) {
    rings.forEach((ring, r) => {
      const len = ring.length;
      if (len < 3) return;
      const at = (k: number) => ringStart[r] + (((k % len) + len) % len);
      let k0: number;
      if (ringOf[cur] === r) k0 = posInRing[cur];
      else {
        // Get onto this ring (a hole) with a line from where the string is.
        const onto = ring.findIndex((_, k) => visible(cur, at(k)));
        if (onto < 0) return;
        lay(at(onto));
        k0 = onto;
      }
      if (opts.outline) for (let k = 1; k <= len; k++) lay(at(k0 + k));
      if (!opts.edges || len < 5) return;
      // With an odd number of nails one lap covers every pair; with an even number, two.
      for (let lap = 0; lap < (len % 2 ? 1 : 2); lap++) {
        if (lap === 1) step(at(++k0));
        for (let s = 0; s < (len % 2 ? len : len / 2); s++) {
          const b = at(k0 + 2 * s + 2);
          if (visible(cur, b)) lay(b);
          else {
            // Inside a concave corner the shortcut would leave the shape: follow the edge.
            step(at(k0 + 2 * s + 1));
            step(b);
          }
        }
      }
    });
  }

  // Where the shape is narrow (a nail on another part of the edge within 1.5
  // nail spacings), strings go straight across: the fill takes that line whenever
  // it reaches the nail. Long lines alone leave thin bands with only diagonals.
  const across = new Int32Array(n).fill(-1);
  for (let i = 0; i < n; i++) {
    let bestD = avgEdge * 1.5;
    for (const j of nearby(i)) {
      if (ringOf[j] === ringOf[i]) {
        const len = rings[ringOf[i]].length;
        const d = Math.abs(posInRing[i] - posInRing[j]);
        if (Math.min(d, len - d) < 3) continue;
      }
      const d = Math.hypot(nodes[j][0] - nodes[i][0], nodes[j][1] - nodes[i][1]);
      if (d < bestD && visible(i, j)) {
        bestD = d;
        across[i] = j;
      }
    }
  }

  for (let guard = 0; laid < opts.targetLength && lines < maxLines && guard < maxLines * 4; guard++) {
    const p = across[cur];
    if (p >= 0 && !used.has(Math.min(p, cur) * n + Math.max(p, cur))) {
      hops = 0;
      lay(p);
      continue;
    }
    let cands = all;
    if (n > sampleSize) {
      // The nearest nails plus a random spread for long lines. In thin shapes
      // (such as lines given a width) the near ones are often all that's in view.
      cands = [...nearby(cur)];
      for (let k = 0; k < sampleSize / 2; k++) cands.push(Math.floor(random() * n));
    }
    let best = -1;
    let bestScore = 0;
    for (const c of cands) {
      if (c === cur || use[c] >= maxUse) continue;
      const key = Math.min(c, cur) * n + Math.max(c, cur);
      if (used.has(key) || !visible(cur, c)) continue;
      const sc = score(cur, c) * (0.7 + 0.6 * random());
      if (sc > bestScore) {
        bestScore = sc;
        best = c;
      }
    }
    if (best < 0 || bestScore < 0.05) {
      // Nowhere useful to go from here: step along the boundary to the next nail.
      cur = ringNext(cur);
      seq.push(cur);
      if (++hops > n) break;
      continue;
    }
    hops = 0;
    lay(best);
  }
  if (hops) seq.length -= hops;
  return seq.length > 1 ? seq : [];
}
