import { distToSegment, rng, segmentsTouch } from "./geometry";
import type { Pt } from "./types";

export interface FillOptions {
  /** How dark it should be at a point: millimetres of string per square millimetre. */
  densityAt: (x: number, y: number) => number;
  seed: number;
  /** First take the string around each edge, nail to neighbouring nail. */
  outline?: boolean;
  /** Tie off and start a new string rather than make long trips across the shape. */
  restarts?: boolean;
}

export interface FillResult {
  /** Stringing order, one list per string (just one unless restarts are allowed), as indices into the rings concatenated in order. */
  strings: number[][];
  /** Centres of patches left well short of their target: where closer nails would help. */
  thin: Pt[];
  /** Outlines (convex) around sizeable areas left well short of their target. */
  light: Pt[][];
}

/**
 * Filled-silhouette stringing to an even darkness. The shape is divided into
 * small patches, each with a target amount of string. The string goes nail to
 * nail across the inside; each next line is the one that does the most for
 * patches still short of their target, so long lines through patches that are
 * already dark aren't favoured and every part of the shape ends up equally
 * dark. Lines never leave the shape or cross a hole.
 *
 * `rings[0]` is the outer boundary and any further rings are holes.
 */
export function fillIsland(rings: Pt[][], opts: FillOptions): FillResult {
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
  if (n < 4) return { strings: [], thin: [], light: [] };

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

  // Patches limited to the inside of the shape, each with a target number of
  // string passes (a string crossing a patch lays about one patch-width of string).
  // Patches are small enough to judge narrow parts, but no smaller than a target
  // of about three passes: much smaller and a single string overshoots them, so
  // the fill can't judge evenness.
  const densities: number[] = [];
  for (let i = 0; i < 5; i++) for (let j = 0; j < 5; j++) densities.push(opts.densityAt(minX + ((i + 0.5) * W) / 5, minY + ((j + 0.5) * H) / 5));
  const density = Math.max(...densities, 1e-6);
  const g = Math.max(Math.max(W, H) / 240, 3 / density);
  const rw = Math.ceil(W / g) + 1;
  const rh = Math.ceil(H / g) + 1;
  const mask = new Uint8Array(rw * rh);
  const cov = new Float32Array(rw * rh);
  const target = new Float32Array(rw * rh);
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
      for (let i = i0; i <= i1; i++) {
        mask[j * rw + i] = 1;
        target[j * rw + i] = opts.densityAt(minX + (i + 0.5) * g, py) * g;
      }
    }
  }
  // Patches the edge runs through: next to the edge between two nails only the
  // outline reaches, so they aren't hunted down or reported when light.
  const edge = new Uint8Array(rw * rh);
  for (let c = 0; c < mask.length; c++)
    if (mask[c]) edge[c] = nearBoundary([minX + ((c % rw) + 0.5) * g, minY + (Math.floor(c / rw) + 0.5) * g], g / 2) ? 1 : 0;
  // Darkness is judged over about 12 mm: single patches hold only a few strings,
  // so on their own they're light or dark by chance.
  const reach = Math.max(1, Math.round(6 / g));
  /** How close a patch's neighbourhood (away from the edge) is to its target, 0–1. */
  const darkness = (c: number) => {
    const i = c % rw;
    const j = (c - i) / rw;
    let sum = 0;
    let count = 0;
    for (let jj = Math.max(0, j - reach); jj <= Math.min(rh - 1, j + reach); jj++)
      for (let ii = Math.max(0, i - reach); ii <= Math.min(rw - 1, i + reach); ii++) {
        const k = jj * rw + ii;
        if (!mask[k] || edge[k]) continue;
        sum += Math.min(1, cov[k] / target[k]);
        count++;
      }
    return count ? sum / count : 1;
  };

  /** Visits the patches a line crosses, with how far each is from the line's nearer end. */
  const lineCells = (a: number, b: number, visit: (cell: number, fromEnd: number) => void) => {
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
      if (c !== last && mask[c]) visit(c, Math.min(t, 1 - t) * len);
      last = c;
    }
  };

  /**
   * What a line is worth: how much closer it brings the patches it crosses to
   * their targets (by squared shortfall, relative to each target). Emptier
   * patches pull harder, and patches already dark push back harder the darker
   * they get, so long lines through dark patches lose out to short ones into
   * light patches.
   */
  const gain = (c: number) => (2 * (target[c] - cov[c]) - 1) / target[c];
  // Every line at a nail crowds in right beside it: that's no reason to avoid
  // one more there, so patches that close only count when they're short.
  const crowded = g;
  const worth = (a: number, b: number) => {
    let net = 0;
    lineCells(a, b, (c, fromEnd) => {
      const v = gain(c);
      if (v > 0 || fromEnd > crowded) net += v;
    });
    return net;
  };

  const random = rng(opts.seed);
  const maxUse = 40;
  const maxLines = n * 60;
  const use = new Uint16Array(n);
  const used = new Set<number>();
  const all = Array.from({ length: n }, (_, i) => i);
  // Every nail is tried as the next one up to this many; beyond it, the nearest plus a random spread.
  const sampleSize = 800;

  // Nearest nails to a point, found by searching outward through a grid.
  const nodeGrid: number[][] = Array.from({ length: gx * gy }, () => []);
  nodes.forEach(([x, y], i) => nodeGrid[cy(y) * gx + cx(x)].push(i));
  const around = (x: number, y: number, count: number) => {
    const out: number[] = [];
    const x0 = cx(x);
    const y0 = cy(y);
    const take = (i: number, j: number) => {
      if (i < 0 || j < 0 || i >= gx || j >= gy) return;
      for (const k of nodeGrid[j * gx + i]) out.push(k);
    };
    for (let r = 0; out.length < count && r <= Math.max(gx, gy); r++) {
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
    return out;
  };
  const nearCache = new Map<number, number[]>();
  const nearby = (a: number) => {
    let out = nearCache.get(a);
    if (!out) {
      out = around(nodes[a][0], nodes[a][1], sampleSize / 2 + 1).filter((k) => k !== a);
      nearCache.set(a, out);
    }
    return out;
  };
  /** The nearest nails plus a random spread for long lines. */
  const candidates = (from: number, count = sampleSize) => {
    if (n <= count) return all;
    const out = nearby(from).slice(0, count / 2);
    for (let k = 0; k < count / 2; k++) out.push(Math.floor(random() * n));
    return out;
  };
  const open = (a: number, b: number) =>
    a !== b && use[b] < maxUse && !used.has(Math.min(a, b) * n + Math.max(a, b)) && visible(a, b);

  let cur = 0;
  let seq = [cur];
  const strings = [seq];
  const lay = (b: number) => {
    lineCells(cur, b, (c) => (cov[c] += 1));
    used.add(Math.min(b, cur) * n + Math.max(b, cur));
    use[cur]++;
    use[b]++;
    seq.push(b);
    cur = b;
  };


  // Optional outline first: around each ring, nail to neighbouring nail.
  if (opts.outline) {
    rings.forEach((ring, r) => {
      const len = ring.length;
      if (len < 3) return;
      const at = (k: number) => ringStart[r] + (((k % len) + len) % len);
      let k0 = posInRing[cur];
      if (ringOf[cur] !== r) {
        // Get onto this ring (a hole) with a line from where the string is.
        const onto = ring.findIndex((_, k) => visible(cur, at(k)));
        if (onto < 0) return;
        lay(at(onto));
        k0 = onto;
      }
      for (let k = 1; k <= len; k++) lay(at(k0 + k));
    });
  }

  /**
   * The fewest lines from the current nail to `to`: a line inside the shape to
   * one of the nearest nails, used before or not, or a step to the next nail
   * along the edge. Null if there's no way there.
   */
  const alongEdge = (a: number, b: number) => {
    if (ringOf[a] !== ringOf[b]) return false;
    const d = Math.abs(posInRing[a] - posInRing[b]);
    return Math.min(d, rings[ringOf[a]].length - d) === 1;
  };
  const route = (to: number): number[] | null => {
    const prev = new Int32Array(n).fill(-1);
    prev[cur] = cur;
    let frontier = [cur];
    const steps = (a: number) => {
      const r = ringOf[a];
      const len = rings[r].length;
      const k = posInRing[a];
      return [ringStart[r] + ((k + 1) % len), ringStart[r] + ((k + len - 1) % len), ...nearby(a).slice(0, 60)];
    };
    while (frontier.length) {
      const next: number[] = [];
      for (const a of frontier)
        for (const b of steps(a)) {
          if (prev[b] >= 0 || use[b] >= maxUse || (!alongEdge(a, b) && !visible(a, b))) continue;
          prev[b] = a;
          if (b === to) {
            const path = [b];
            for (let v = a; v !== cur; v = prev[v]) path.push(v);
            return path.reverse();
          }
          next.push(b);
        }
      frontier = next;
    }
    return null;
  };

  // Patches the string has been sent to, and ones no line can help any more.
  const NEEDY = 0.3;
  const visits = new Uint8Array(rw * rh);
  const gaveUp = new Uint8Array(rw * rh);
  // Patches given up on; with too few nails for the shading there can be
  // thousands no line helps, and they're left as they are.
  let failsLeft = 300;
  /**
   * Nothing worth doing near the string: send it to the patch furthest short of
   * its target (under 70% of it) that a line can still help, and lay that line.
   * False when there's none left.
   */
  const angle = new Float64Array(n);
  const sortedAngle = new Float64Array(n);
  const byAngle = Array.from({ length: n }, (_, k) => k);
  const goToNeedy = () => {
    const short = (c: number) => (target[c] - cov[c]) / target[c];
    const needy: number[] = [];
    for (let c = 0; c < mask.length; c++) if (mask[c] && !edge[c] && !gaveUp[c] && short(c) > NEEDY && darkness(c) < 1 - NEEDY) needy.push(c);
    needy.sort((a, b) => short(b) - short(a));
    for (const c0 of needy) {
      // Sent here a few times already and it's still short: leave it.
      if (++visits[c0] > 3) {
        gaveUp[c0] = 1;
        continue;
      }
      // The best line through it, from any nail: nails sorted by their angle
      // around the patch, so each nail's partners lie roughly opposite.
      const P: Pt = [minX + ((c0 % rw) + 0.5) * g, minY + (Math.floor(c0 / rw) + 0.5) * g];
      for (let k = 0; k < n; k++) angle[k] = Math.atan2(nodes[k][1] - P[1], nodes[k][0] - P[0]);
      byAngle.sort((a, b) => angle[a] - angle[b]);
      for (let k = 0; k < n; k++) sortedAngle[k] = angle[byAngle[k]];
      let from = -1;
      let to = -1;
      let bestWorth = 0;
      for (let m = 0; m < n; m++) {
        const dm = Math.hypot(nodes[m][0] - P[0], nodes[m][1] - P[1]);
        // Partners within this angle of straight through pass close enough to the patch.
        const spread = Math.min(0.6, (g * 0.75) / Math.max(dm, g) + 0.02);
        let want = angle[m] + Math.PI;
        if (want > Math.PI) want -= 2 * Math.PI;
        for (const lo of [want - spread, want - spread + 2 * Math.PI, want - spread - 2 * Math.PI]) {
          let k = lowerBound(sortedAngle, lo);
          for (; k < n && sortedAngle[k] <= lo + 2 * spread; k++) {
            const c = byAngle[k];
            if (c <= m || distToSegment(P, nodes[m], nodes[c]) > g * 0.75) continue;
            if (use[m] >= maxUse || use[c] >= maxUse || used.has(m * n + c) || !visible(m, c)) continue;
            let through = false;
            lineCells(m, c, (q) => (through ||= q === c0));
            if (!through) continue;
            const w = worth(m, c);
            if (w > bestWorth) {
              bestWorth = w;
              // Start from whichever end is nearer the string.
              const nearM = Math.hypot(nodes[m][0] - nodes[cur][0], nodes[m][1] - nodes[cur][1]);
              const nearC = Math.hypot(nodes[c][0] - nodes[cur][0], nodes[c][1] - nodes[cur][1]);
              [from, to] = nearM <= nearC ? [m, c] : [c, m];
            }
          }
        }
      }
      const path = from < 0 ? null : from === cur ? [] : route(from);
      if (!path) {
        gaveUp[c0] = 1;
        if (--failsLeft < 0) return false;
        continue;
      }
      if (opts.restarts && path.length > 2) {
        // A long way round: tie off, and start a new string there.
        seq = [from];
        strings.push(seq);
        cur = from;
      } else for (const b of path) lay(b);
      lay(to);
      return true;
    }
    return false;
  };

  // Fill until no line anywhere does more good than harm.
  for (let lines = 0; lines < maxLines; lines++) {
    let best = -1;
    let bestWorth = 0;
    for (const c of candidates(cur)) {
      if (!open(cur, c)) continue;
      const w = worth(cur, c) * (0.85 + 0.3 * random());
      if (w > bestWorth) {
        bestWorth = w;
        best = c;
      }
    }
    if (best >= 0) {
      lay(best);
      continue;
    }
    // Nothing worth it from here: cross to the nail with the best line onward
    // (the crossing itself may add a little extra darkness).
    let via = -1;
    let viaWorth = 0;
    for (const m of candidates(cur, 60)) {
      if (!open(cur, m)) continue;
      const there = worth(cur, m);
      for (const c of candidates(m, 60)) {
        if (!open(m, c)) continue;
        const w = there + worth(m, c);
        if (w > viaWorth) {
          viaWorth = w;
          via = m;
        }
      }
    }
    if (via >= 0) {
      lay(via);
      continue;
    }
    if (!goToNeedy()) break;
  }

  // Thin: patches whose neighbourhood is well short of its target.
  const isThin = new Uint8Array(rw * rh);
  const thin: Pt[] = [];
  for (let c = 0; c < mask.length; c++) {
    if (!mask[c] || edge[c] || darkness(c) >= 0.7) continue;
    isThin[c] = 1;
    thin.push([minX + ((c % rw) + 0.5) * g, minY + (Math.floor(c / rw) + 0.5) * g]);
  }

  // Light areas: thin patches that touch, covering at least a nail gap squared.
  const light: Pt[][] = [];
  const seen = new Uint8Array(rw * rh);
  for (let c0 = 0; c0 < isThin.length; c0++) {
    if (!isThin[c0] || seen[c0]) continue;
    seen[c0] = 1;
    const area = [c0];
    for (let q = 0; q < area.length; q++) {
      const i = area[q] % rw;
      const j = (area[q] - i) / rw;
      for (let jj = Math.max(0, j - 1); jj <= Math.min(rh - 1, j + 1); jj++)
        for (let ii = Math.max(0, i - 1); ii <= Math.min(rw - 1, i + 1); ii++) {
          const c = jj * rw + ii;
          if (isThin[c] && !seen[c]) {
            seen[c] = 1;
            area.push(c);
          }
        }
    }
    if (area.length * g * g < avgEdge * avgEdge) continue;
    const corners: Pt[] = [];
    for (const c of area) {
      const x = minX + (c % rw) * g;
      const y = minY + Math.floor(c / rw) * g;
      corners.push([x, y], [x + g, y], [x + g, y + g], [x, y + g]);
    }
    light.push(convexHull(corners));
  }
  return { strings: strings.filter((x) => x.length > 1), thin, light };
}

/** Convex hull, anticlockwise (monotone chain). */
function convexHull(pts: Pt[]): Pt[] {
  const sorted = [...pts].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o: Pt, a: Pt, b: Pt) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: Pt[] = [];
  for (const p of sorted) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: Pt[] = [];
  for (let k = sorted.length - 1; k >= 0; k--) {
    const p = sorted[k];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}

/** First index in sorted `a` whose value is at least `x`. */
function lowerBound(a: Float64Array, x: number): number {
  let lo = 0;
  let hi = a.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (a[mid] < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
