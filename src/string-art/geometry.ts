import { artLines } from "./outline";
import type { Artwork, Bounds, Obj, Pt, RefShape } from "./types";

export interface WorldContour {
  pts: Pt[];
  closed: boolean;
}

export function emptyBounds(): Bounds {
  return { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
}

export function extendBounds(b: Bounds, x: number, y: number) {
  if (x < b.minX) b.minX = x;
  if (y < b.minY) b.minY = y;
  if (x > b.maxX) b.maxX = x;
  if (y > b.maxY) b.maxY = y;
}

export function unionBounds(list: Bounds[]): Bounds | null {
  if (!list.length) return null;
  const b = emptyBounds();
  for (const o of list) {
    extendBounds(b, o.minX, o.minY);
    extendBounds(b, o.maxX, o.maxY);
  }
  return b;
}

const boundsCache = new WeakMap<Obj, Bounds>();

/** World-space bounding box of the (possibly rotated) outline. */
export function objBounds(o: Obj): Bounds {
  let b = boundsCache.get(o);
  if (!b) {
    b = emptyBounds();
    for (const c of worldContours(o)) for (const [x, y] of c.pts) extendBounds(b, x, y);
    if (!Number.isFinite(b.minX)) b = { minX: o.x, minY: o.y, maxX: o.x, maxY: o.y };
    boundsCache.set(o, b);
  }
  return b;
}

/** Maps an object-local offset (before rotation) to world coordinates. */
export function toWorld(o: Obj, lx: number, ly: number): Pt {
  const t = ((o.rotation ?? 0) * Math.PI) / 180;
  const c = Math.cos(t);
  const s = Math.sin(t);
  return [o.x + lx * c - ly * s, o.y + lx * s + ly * c];
}

/** Maps a world point to the object's local, unrotated frame (relative to its centre). */
export function toLocal(o: Obj, x: number, y: number): Pt {
  const t = (-(o.rotation ?? 0) * Math.PI) / 180;
  const c = Math.cos(t);
  const s = Math.sin(t);
  const dx = x - o.x;
  const dy = y - o.y;
  return [dx * c - dy * s, dx * s + dy * c];
}

/** Artwork's own unscaled coordinates (as imported) to world. */
export function artToWorld(a: Artwork, x: number, y: number): Pt {
  return toWorld(a, x * (a.w0 > 0 ? a.w / a.w0 : 1), y * (a.h0 > 0 ? a.h / a.h0 : 1));
}

/** World to the artwork's own unscaled coordinates. */
export function worldToArt(a: Artwork, x: number, y: number): Pt {
  const [lx, ly] = toLocal(a, x, y);
  return [lx / (a.w0 > 0 ? a.w / a.w0 : 1), ly / (a.h0 > 0 ? a.h / a.h0 : 1)];
}

/** Corners of the object's rotated box, in world coordinates. */
export function orientedCorners(o: Obj): Pt[] {
  return [
    toWorld(o, -o.w / 2, -o.h / 2),
    toWorld(o, o.w / 2, -o.h / 2),
    toWorld(o, o.w / 2, o.h / 2),
    toWorld(o, -o.w / 2, o.h / 2),
  ];
}

/** Normalises degrees to (-180, 180], rounded to hide float noise. */
export function normalizeDegrees(d: number): number {
  let r = ((d % 360) + 360) % 360;
  if (r > 180) r -= 360;
  r = Math.round(r * 1e6) / 1e6;
  return r === -180 ? 180 : r;
}

/** Rotates an object about a world point. */
export function rotateObj<T extends Obj>(o: T, deg: number, cx: number, cy: number): T {
  const t = (deg * Math.PI) / 180;
  const c = Math.cos(t);
  const s = Math.sin(t);
  const dx = o.x - cx;
  const dy = o.y - cy;
  return { ...o, x: cx + dx * c - dy * s, y: cy + dx * s + dy * c, rotation: normalizeDegrees((o.rotation ?? 0) + deg) };
}

// ---------------------------------------------------------------------------
// Reference shapes

/** Polygon vertices with circumradius 1, oriented with a flat bottom edge. */
export function unitPolygon(sides: number): Pt[] {
  const start = -Math.PI / 2 + Math.PI / sides;
  const pts: Pt[] = [];
  for (let k = 0; k < sides; k++) {
    const a = start + (2 * Math.PI * k) / sides;
    pts.push([Math.cos(a), Math.sin(a)]);
  }
  return pts;
}

/** Bounding box of the unit polygon, and the offset of its centre from the circumcentre. */
export function unitPolygonBox(sides: number) {
  const b = emptyBounds();
  for (const [x, y] of unitPolygon(sides)) extendBounds(b, x, y);
  return { w: b.maxX - b.minX, h: b.maxY - b.minY, cx: (b.minX + b.maxX) / 2, cy: (b.minY + b.maxY) / 2 };
}

/**
 * Circumradius if the shape is currently regular (not stretched), else null.
 * Ellipses are regular when they are circles.
 */
export function regularRadius(s: RefShape): number | null {
  if (s.kind === "ellipse") return Math.abs(s.w - s.h) < 1e-6 * Math.max(s.w, 1) ? s.w / 2 : null;
  const box = unitPolygonBox(s.sides);
  const rw = s.w / box.w;
  const rh = s.h / box.h;
  return Math.abs(rw - rh) < 1e-6 * Math.max(rw, 1) ? rw : null;
}

/** Edge-to-edge (across flats) distance for a regular polygon with circumradius r. */
export function edgeToEdge(sides: number, r: number): number {
  return 2 * r * Math.cos(Math.PI / sides);
}

/** Bounding box size for a regular shape with circumradius r. */
export function regularSize(s: RefShape, r: number): { w: number; h: number } {
  if (s.kind === "ellipse") return { w: 2 * r, h: 2 * r };
  const box = unitPolygonBox(s.sides);
  return { w: box.w * r, h: box.h * r };
}

// ---------------------------------------------------------------------------
// World geometry

const contourCache = new WeakMap<Obj, WorldContour[]>();

export function worldContours(o: Obj): WorldContour[] {
  let c = contourCache.get(o);
  if (!c) {
    c = o.type === "art" ? artContours(o) : refContours(o);
    contourCache.set(o, c);
  }
  return c;
}

function artContours(a: Artwork): WorldContour[] {
  const sx = a.w0 > 0 ? a.w / a.w0 : 1;
  const sy = a.h0 > 0 ? a.h / a.h0 : 1;
  // The prepared drawing: gaps joined, and single lines thickened if a line width is set.
  return artLines(a).map((l) => ({ pts: l.pts.map(([x, y]) => toWorld(a, x * sx, y * sy)), closed: l.closed }));
}

function refContours(s: RefShape): WorldContour[] {
  if (s.kind === "ellipse") {
    const pts: Pt[] = [];
    const n = 128;
    for (let k = 0; k < n; k++) {
      const a = (2 * Math.PI * k) / n;
      pts.push(toWorld(s, (Math.cos(a) * s.w) / 2, (Math.sin(a) * s.h) / 2));
    }
    return [{ pts, closed: true }];
  }
  const box = unitPolygonBox(s.sides);
  const pts = unitPolygon(s.sides).map(([x, y]) => toWorld(s, ((x - box.cx) / box.w) * s.w, ((y - box.cy) / box.h) * s.h));
  return [{ pts, closed: true }];
}

// ---------------------------------------------------------------------------
// Primitives

export function dist(a: Pt, b: Pt): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

export function polygonArea(pts: Pt[]): number {
  let a = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    a += (pts[j][0] - pts[i][0]) * (pts[j][1] + pts[i][1]);
  }
  return a / 2;
}

export function pointInPolygon(x: number, y: number, pts: Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i];
    const [xj, yj] = pts[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function orient(ax: number, ay: number, bx: number, by: number, cx: number, cy: number): number {
  return (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
}

function onSegment(ax: number, ay: number, bx: number, by: number, px: number, py: number): boolean {
  return (
    Math.min(ax, bx) <= px && px <= Math.max(ax, bx) && Math.min(ay, by) <= py && py <= Math.max(ay, by)
  );
}

/** True if segments ab and cd touch or cross (inclusive). */
export function segmentsTouch(a: Pt, b: Pt, c: Pt, d: Pt): boolean {
  const d1 = orient(c[0], c[1], d[0], d[1], a[0], a[1]);
  const d2 = orient(c[0], c[1], d[0], d[1], b[0], b[1]);
  const d3 = orient(a[0], a[1], b[0], b[1], c[0], c[1]);
  const d4 = orient(a[0], a[1], b[0], b[1], d[0], d[1]);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return true;
  if (d1 === 0 && onSegment(c[0], c[1], d[0], d[1], a[0], a[1])) return true;
  if (d2 === 0 && onSegment(c[0], c[1], d[0], d[1], b[0], b[1])) return true;
  if (d3 === 0 && onSegment(a[0], a[1], b[0], b[1], c[0], c[1])) return true;
  if (d4 === 0 && onSegment(a[0], a[1], b[0], b[1], d[0], d[1])) return true;
  return false;
}

export function distToSegment(p: Pt, a: Pt, b: Pt): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  let t = len2 ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

// ---------------------------------------------------------------------------
// Seeded RNG (mulberry32)

export function rng(seed: number): () => number {
  let a = seed >>> 0 || 1;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
