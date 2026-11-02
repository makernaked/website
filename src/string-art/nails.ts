import { dist } from "./geometry";
import type { Pt } from "./types";

export interface ContourNails {
  pts: Pt[];
  corner: boolean[];
  /** Distance of each nail along the contour from its first point. */
  s: number[];
}

/**
 * Places nails along a contour. Sharp corners always get a nail; the stretches
 * between corners are divided evenly so the spacing stays as close as possible
 * to the requested value.
 */
export function placeContourNails(pts: Pt[], closed: boolean, spacing: number, cornerAngleDeg: number): ContourNails {
  const n = pts.length;
  if (n === 0) return { pts: [], corner: [], s: [] };
  if (n === 1) return { pts: [pts[0]], corner: [true], s: [0] };

  const segCount = closed ? n : n - 1;
  const s = new Float64Array(n + 1);
  for (let i = 0; i < segCount; i++) s[i + 1] = s[i] + dist(pts[i], pts[(i + 1) % n]);
  const L = s[segCount];
  if (L < 1e-9) return { pts: [pts[0]], corner: [true], s: [0] };

  const at = (t: number): Pt => {
    if (closed) t = ((t % L) + L) % L;
    else t = Math.max(0, Math.min(L, t));
    let lo = 0;
    let hi = segCount - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (s[mid] <= t) lo = mid;
      else hi = mid - 1;
    }
    const a = pts[lo];
    const b = pts[(lo + 1) % n];
    const len = s[lo + 1] - s[lo];
    const u = len > 0 ? (t - s[lo]) / len : 0;
    return [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u];
  };

  // Corner detection: the turn across a window of half a nail spacing, so that
  // tight fillets count as corners at nail scale but gentle curves do not.
  const w = Math.min(spacing * 0.5, L / 6);
  const threshold = (cornerAngleDeg * Math.PI) / 180;
  const candidates: { s: number; angle: number }[] = [];
  for (let i = 0; i < n; i++) {
    const si = s[i];
    if (!closed && (si < w * 0.5 || si > L - w * 0.5)) continue;
    const b = at(si - w);
    const f = at(si + w);
    const p = pts[i];
    const v1x = p[0] - b[0];
    const v1y = p[1] - b[1];
    const v2x = f[0] - p[0];
    const v2y = f[1] - p[1];
    const angle = Math.abs(Math.atan2(v1x * v2y - v1y * v2x, v1x * v2x + v1y * v2y));
    if (angle >= threshold) candidates.push({ s: si, angle });
  }
  candidates.sort((a, b) => b.angle - a.angle);
  const arcDist = (a: number, b: number) => {
    const d = Math.abs(a - b);
    return closed ? Math.min(d, L - d) : d;
  };
  const corners: number[] = [];
  for (const c of candidates) {
    if (corners.every((o) => arcDist(o, c.s) >= w)) corners.push(c.s);
  }
  corners.sort((a, b) => a - b);

  const out: Pt[] = [];
  const corner: boolean[] = [];
  const sOut: number[] = [];
  const place = (t: number, isCorner: boolean) => {
    const u = closed ? ((t % L) + L) % L : t;
    out.push(at(u));
    corner.push(isCorner);
    sOut.push(u);
  };
  const span = (a: number, b: number, markFirst: boolean) => {
    const cnt = Math.max(1, Math.round((b - a) / spacing));
    for (let k = 0; k < cnt; k++) place(a + (k * (b - a)) / cnt, markFirst && k === 0);
  };

  if (closed) {
    if (corners.length) {
      for (let j = 0; j < corners.length; j++) {
        span(corners[j], j + 1 < corners.length ? corners[j + 1] : corners[0] + L, true);
      }
    }
    if (out.length < 3) {
      out.length = 0;
      corner.length = 0;
      sOut.length = 0;
      let top = 0;
      for (let i = 1; i < n; i++) if (pts[i][1] > pts[top][1]) top = i;
      const start = corners.length ? corners[0] : s[top];
      const cnt = Math.max(3, Math.round(L / spacing));
      for (let k = 0; k < cnt; k++) place(start + (k * L) / cnt, corners.length > 0 && k === 0);
    }
  } else {
    const stops = [0, ...corners, L];
    for (let j = 0; j + 1 < stops.length; j++) span(stops[j], stops[j + 1], true);
    place(L, true);
  }
  return { pts: out, corner, s: sOut };
}
