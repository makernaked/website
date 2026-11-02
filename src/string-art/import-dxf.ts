import DxfParser from "dxf-parser";
import type {
  IArcEntity,
  ICircleEntity,
  IEllipseEntity,
  IEntity,
  IInsertEntity,
  ILineEntity,
  ILwpolylineEntity,
  IPolylineEntity,
  ISplineEntity,
} from "dxf-parser";
import type { ImportResult, RawContour } from "./import-svg";
import type { Pt, Units } from "./types";
import { MM_PER_IN } from "./units";

// $INSUNITS codes → millimetres.
const INSUNITS_MM: Record<number, number> = { 1: MM_PER_IN, 2: MM_PER_IN * 12, 4: 1, 5: 10, 6: 1000 };

type Xf = (p: Pt) => Pt;

const ARC_STEPS = 128;

function arcPoints(cx: number, cy: number, rx: number, ry: number, rot: number, a0: number, a1: number): Pt[] {
  const sweep = a1 - a0;
  const n = Math.max(4, Math.ceil((Math.abs(sweep) / (2 * Math.PI)) * ARC_STEPS));
  const cr = Math.cos(rot);
  const sr = Math.sin(rot);
  const pts: Pt[] = [];
  for (let k = 0; k <= n; k++) {
    const a = a0 + (sweep * k) / n;
    const x = rx * Math.cos(a);
    const y = ry * Math.sin(a);
    pts.push([cx + x * cr - y * sr, cy + x * sr + y * cr]);
  }
  return pts;
}

/** Polyline vertices with DXF bulge arcs expanded. */
function bulgePolyline(vs: { x: number; y: number; bulge?: number }[], closed: boolean): Pt[] {
  const pts: Pt[] = [];
  const count = closed ? vs.length : vs.length - 1;
  for (let i = 0; i < count; i++) {
    const a = vs[i];
    const b = vs[(i + 1) % vs.length];
    const bulge = a.bulge ?? 0;
    if (i === 0) pts.push([a.x, a.y]);
    if (Math.abs(bulge) < 1e-9) {
      pts.push([b.x, b.y]);
      continue;
    }
    const theta = 4 * Math.atan(bulge);
    const chord = Math.hypot(b.x - a.x, b.y - a.y);
    if (chord < 1e-12) continue;
    const r = chord / (2 * Math.sin(Math.abs(theta) / 2));
    const mx = (a.x + b.x) / 2;
    const my = (a.y + b.y) / 2;
    const h = Math.sqrt(Math.max(0, r * r - (chord / 2) ** 2));
    const ux = (b.x - a.x) / chord;
    const uy = (b.y - a.y) / chord;
    // Centre lies to the left of the chord for a CCW (positive) bulge under 180°.
    const side = (bulge > 0 ? 1 : -1) * (Math.abs(theta) > Math.PI ? -1 : 1);
    const cx = mx - uy * h * side;
    const cy = my + ux * h * side;
    const a0 = Math.atan2(a.y - cy, a.x - cx);
    const arc = arcPoints(cx, cy, r, r, 0, a0, a0 + theta);
    arc[arc.length - 1] = [b.x, b.y];
    pts.push(...arc.slice(1));
  }
  if (closed && pts.length > 1) pts.pop();
  return pts;
}

function bspline(degree: number, ctrl: Pt[], knots: number[], samples: number): Pt[] {
  const n = ctrl.length;
  if (knots.length !== n + degree + 1 || degree < 1) return ctrl;
  const lo = knots[degree];
  const hi = knots[n];
  const pts: Pt[] = [];
  for (let s = 0; s <= samples; s++) {
    const t = Math.min(lo + ((hi - lo) * s) / samples, hi - 1e-12);
    let k = degree;
    while (k < n - 1 && t >= knots[k + 1]) k++;
    const d: Pt[] = [];
    for (let j = 0; j <= degree; j++) d.push([...ctrl[k - degree + j]] as Pt);
    for (let r = 1; r <= degree; r++) {
      for (let j = degree; j >= r; j--) {
        const i = k - degree + j;
        const den = knots[i + degree - r + 1] - knots[i];
        const alpha = den ? (t - knots[i]) / den : 0;
        d[j] = [(1 - alpha) * d[j - 1][0] + alpha * d[j][0], (1 - alpha) * d[j - 1][1] + alpha * d[j][1]];
      }
    }
    pts.push(d[degree]);
  }
  return pts;
}

/** `order` is the entity's position in the file (its drawing order). */
type Meta = { layer?: string; weight?: number; order?: number };
type Piece = Meta & { pts: Pt[] };

/**
 * Joins loose segments on the same layer whose endpoints meet into longer
 * chains, closing loops where possible.
 */
function chainPieces(pieces: Piece[], tol: number): (RawContour & Meta)[] {
  const out: (RawContour & Meta)[] = [];
  const left = pieces.filter((p) => p.pts.length >= 2);
  const close = (a: Pt, b: Pt) => Math.abs(a[0] - b[0]) <= tol && Math.abs(a[1] - b[1]) <= tol;
  while (left.length) {
    const first = left.pop()!;
    let chain = first.pts;
    let order = first.order ?? 0;
    let grew = true;
    while (grew && !close(chain[0], chain[chain.length - 1])) {
      grew = false;
      for (let i = 0; i < left.length; i++) {
        if (left[i].layer !== first.layer) continue;
        const p = left[i].pts;
        const end = chain[chain.length - 1];
        const start = chain[0];
        if (close(end, p[0])) chain = chain.concat(p.slice(1));
        else if (close(end, p[p.length - 1])) chain = chain.concat(p.slice(0, -1).reverse());
        else if (close(start, p[p.length - 1])) chain = p.slice(0, -1).concat(chain);
        else if (close(start, p[0])) chain = p.slice(1).reverse().concat(chain);
        else continue;
        order = Math.min(order, left[i].order ?? 0);
        left.splice(i, 1);
        grew = true;
        break;
      }
    }
    const closed = chain.length > 2 && close(chain[0], chain[chain.length - 1]);
    if (closed) chain = chain.slice(0, -1);
    out.push({ pts: chain, closed, layer: first.layer, weight: first.weight, order });
  }
  return out;
}

export function importDXF(text: string, fallbackUnits: Units): ImportResult {
  const warnings: string[] = [];
  // Some exporters omit the closing EOF record, which the parser insists on.
  if (!/\n\s*EOF\s*$/.test(text)) text = `${text.trimEnd()}\n0\nEOF\n`;
  const dxf = new DxfParser().parseSync(text);
  if (!dxf) throw new Error("This doesn't look like a valid DXF file.");

  const insUnits = Number(dxf.header?.$INSUNITS ?? 0);
  const scale = INSUNITS_MM[insUnits] ?? (fallbackUnits === "in" ? MM_PER_IN : 1);
  if (!INSUNITS_MM[insUnits]) warnings.push(`The DXF doesn't say what units it uses, so ${fallbackUnits === "in" ? "inches" : "millimetres"} were assumed.`);

  const closedOut: (RawContour & Meta)[] = [];
  const pieces: Piece[] = [];
  const skipped = new Set<string>();
  let meta: Meta = {};

  // DXF has no fill for plain outlines; a closed outline without a line weight is
  // how filled shapes come through (Illustrator exports them that way).
  const emit = (pts: Pt[], closed: boolean, xf: Xf) => {
    const t = pts.map(xf);
    if (closed) closedOut.push({ pts: t, closed: true, ...meta, filled: meta.weight === undefined });
    else pieces.push({ pts: t, ...meta });
  };
  let entityOrder = 0;

  // Entities with an extrusion of (0,0,-1) are mirrored in X.
  const ocs = (e: { extrusionDirectionZ?: number; extrusionDirection?: { z: number } }, xf: Xf): Xf => {
    const z = e.extrusionDirectionZ ?? e.extrusionDirection?.z ?? 1;
    return z < 0 ? ([x, y]) => xf([-x, y]) : xf;
  };

  // Inside a block, layer "0" and by-block line weights take the inserting entity's.
  const handle = (e: IEntity, xf: Xf, depth: number, parent: Meta = {}) => {
    if (e.inPaperSpace || e.visible === false) return;
    const lw = e.lineweight as number | undefined;
    meta = {
      layer: e.layer && e.layer !== "0" ? e.layer : (parent.layer ?? e.layer),
      weight: lw !== undefined && lw > 0 ? lw / 100 : lw === -2 ? parent.weight : undefined,
      order: entityOrder++,
    };
    switch (e.type) {
      case "LINE": {
        const l = e as ILineEntity;
        emit(l.vertices.map((v): Pt => [v.x, v.y]), false, xf);
        break;
      }
      case "LWPOLYLINE":
      case "POLYLINE": {
        const p = e as ILwpolylineEntity | IPolylineEntity;
        if (!p.vertices?.length) break;
        const pts = bulgePolyline(p.vertices, !!p.shape);
        emit(pts, !!p.shape && pts.length > 2, ocs(p as ILwpolylineEntity, xf));
        break;
      }
      case "CIRCLE": {
        const c = e as ICircleEntity;
        emit(arcPoints(c.center.x, c.center.y, c.radius, c.radius, 0, 0, 2 * Math.PI).slice(0, -1), true, ocs(c as unknown as IArcEntity, xf));
        break;
      }
      case "ARC": {
        const a = e as IArcEntity;
        let end = a.endAngle;
        while (end <= a.startAngle) end += 2 * Math.PI;
        emit(arcPoints(a.center.x, a.center.y, a.radius, a.radius, 0, a.startAngle, end), false, ocs(a, xf));
        break;
      }
      case "ELLIPSE": {
        const el = e as IEllipseEntity;
        const mx = el.majorAxisEndPoint.x;
        const my = el.majorAxisEndPoint.y;
        const rx = Math.hypot(mx, my);
        const rot = Math.atan2(my, mx);
        let end = el.endAngle;
        while (end <= el.startAngle) end += 2 * Math.PI;
        const full = Math.abs(end - el.startAngle - 2 * Math.PI) < 1e-6;
        const pts = arcPoints(el.center.x, el.center.y, rx, rx * el.axisRatio, rot, el.startAngle, end);
        emit(full ? pts.slice(0, -1) : pts, full, xf);
        break;
      }
      case "SPLINE": {
        const s = e as ISplineEntity;
        let pts: Pt[] = [];
        if (s.controlPoints?.length && s.knotValues?.length) {
          const ctrl = s.controlPoints.map((v): Pt => [v.x, v.y]);
          pts = bspline(s.degreeOfSplineCurve ?? 3, ctrl, s.knotValues, Math.max(32, ctrl.length * 16));
        } else if (s.fitPoints?.length) pts = s.fitPoints.map((v): Pt => [v.x, v.y]);
        if (pts.length > 1) {
          const closed = !!s.closed || Math.hypot(pts[0][0] - pts[pts.length - 1][0], pts[0][1] - pts[pts.length - 1][1]) < 1e-9;
          emit(closed ? pts.slice(0, -1) : pts, closed, xf);
        }
        break;
      }
      case "INSERT": {
        const ins = e as IInsertEntity;
        const block = dxf.blocks?.[ins.name];
        if (!block || depth > 16) break;
        const sx = ins.xScale ?? 1;
        const sy = ins.yScale ?? 1;
        const r = ((ins.rotation ?? 0) * Math.PI) / 180;
        const cr = Math.cos(r);
        const sr = Math.sin(r);
        const bx = block.position?.x ?? 0;
        const by = block.position?.y ?? 0;
        const inner: Xf = ([x, y]) => {
          const lx = (x - bx) * sx;
          const ly = (y - by) * sy;
          return xf([ins.position.x + lx * cr - ly * sr, ins.position.y + lx * sr + ly * cr]);
        };
        const outer = meta;
        for (const be of block.entities ?? []) handle(be, inner, depth + 1, outer);
        break;
      }
      default:
        skipped.add(e.type);
    }
  };

  const identity: Xf = ([x, y]) => [x * scale, y * scale];
  for (const e of dxf.entities ?? []) handle(e, identity, 0);
  if (skipped.size) warnings.push(`Skipped unsupported DXF entities: ${[...skipped].join(", ")}.`);

  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const c of [...closedOut, ...pieces].map((c) => c.pts))
    for (const [x, y] of c) {
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
  const diag = Math.hypot(maxX - minX, maxY - minY) || 1;
  const hiddenLayers = Object.values(dxf.tables?.layer?.layers ?? {})
    .filter((l) => l.visible === false || l.frozen)
    .map((l) => l.name);
  // Keep the file's drawing order: later shapes sit on top of earlier ones.
  const contours = [...closedOut, ...chainPieces(pieces, diag * 1e-5)]
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
    .map(({ pts, closed, layer, weight, filled }) => ({ pts, closed, layer, weight, filled }));
  return { contours, warnings, hiddenLayers };
}
