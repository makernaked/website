import type { GcodeSettings, Pattern, Pt } from "./types";
import { MM_PER_IN } from "./units";

/** Nail centres in output units, shifted to the chosen origin and ordered to keep travel short. */
function cncPoints(p: Pattern, g: GcodeSettings): Pt[] {
  if (!p.nails.length) return [];
  let minX = Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const n of p.nails) {
    minX = Math.min(minX, n.x);
    minY = Math.min(minY, n.y);
    maxY = Math.max(maxY, n.y);
  }
  const ox = g.origin === "center" ? 0 : minX;
  const oy = g.origin === "center" ? 0 : g.origin === "bottom-left" ? minY : maxY;
  const k = g.units === "in" ? 1 / MM_PER_IN : 1;
  const pts = p.nails.map((n): Pt => [(n.x - ox) * k, (n.y - oy) * k]);
  return nearestNeighbourOrder(pts);
}

function nearestNeighbourOrder(pts: Pt[]): Pt[] {
  const n = pts.length;
  const out: Pt[] = [];
  let cx = 0;
  let cy = 0;
  // Bucket grid so each lookup only scans nearby points.
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of pts) {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  const g = Math.max(1, Math.ceil(Math.sqrt(n)));
  const cw = Math.max((maxX - minX) / g, 1e-9);
  const ch = Math.max((maxY - minY) / g, 1e-9);
  const cells: number[][] = Array.from({ length: g * g }, () => []);
  const cellOf = (x: number, y: number): [number, number] => [
    Math.min(g - 1, Math.max(0, Math.floor((x - minX) / cw))),
    Math.min(g - 1, Math.max(0, Math.floor((y - minY) / ch))),
  ];
  pts.forEach(([x, y], i) => {
    const [i0, j0] = cellOf(x, y);
    cells[j0 * g + i0].push(i);
  });
  let best = -1;
  let bestD = Infinity;
  const scan = (i: number, j: number) => {
    if (i < 0 || j < 0 || i >= g || j >= g) return;
    for (const idx of cells[j * g + i]) {
      const d = (pts[idx][0] - cx) ** 2 + (pts[idx][1] - cy) ** 2;
      if (d < bestD) {
        bestD = d;
        best = idx;
      }
    }
  };
  const cellMin = Math.min(cw, ch);
  for (let step = 0; step < n; step++) {
    const [ci, cj] = cellOf(cx, cy);
    best = -1;
    bestD = Infinity;
    // Search rings of cells outward until no closer point can exist.
    for (let r = 0; r <= g && (best < 0 || (r - 1) * cellMin <= Math.sqrt(bestD)); r++) {
      if (r === 0) scan(ci, cj);
      for (let i = ci - r; i <= ci + r && r > 0; i++) {
        scan(i, cj - r);
        scan(i, cj + r);
      }
      for (let j = cj - r + 1; j <= cj + r - 1 && r > 0; j++) {
        scan(ci - r, j);
        scan(ci + r, j);
      }
    }
    if (best < 0) break;
    const [bi, bj] = cellOf(pts[best][0], pts[best][1]);
    const cell = cells[bj * g + bi];
    cell.splice(cell.indexOf(best), 1);
    out.push(pts[best]);
    [cx, cy] = pts[best];
  }
  return out;
}

export function buildGcode(p: Pattern, g: GcodeSettings): string {
  const pts = cncPoints(p, g);
  const inch = g.units === "in";
  const k = inch ? 1 / MM_PER_IN : 1;
  const f = (v: number) => v.toFixed(inch ? 4 : 3);
  const lines: string[] = [
    `; MakerNaked String Art: ${pts.length} nails`,
    `; Origin: ${g.origin === "center" ? "canvas centre" : g.origin}. Units: ${inch ? "inches" : "millimetres"}.`,
    `; Mode: ${g.mode === "laser" ? "laser dot (GRBL M3 constant power + dwell)" : "plunge"}`,
    inch ? "G20" : "G21",
    "G90",
    "G17",
  ];
  if (g.mode === "laser") {
    lines.push("M5");
    for (const [x, y] of pts) {
      lines.push(`G0 X${f(x)} Y${f(y)}`, `M3 S${Math.round(g.laserPower)}`, `G4 P${g.laserDwell.toFixed(3)}`, "M5");
    }
  } else {
    lines.push(`G0 Z${f(g.safeZ * k)}`);
    if (g.spindle > 0) lines.push(`M3 S${Math.round(g.spindle)}`, "G4 P2");
    for (const [x, y] of pts) {
      lines.push(`G0 X${f(x)} Y${f(y)}`, `G1 Z${f(g.depth * k)} F${f(g.plungeFeed * k)}`);
      if (g.dwell > 0) lines.push(`G4 P${g.dwell.toFixed(3)}`);
      lines.push(`G0 Z${f(g.safeZ * k)}`);
    }
    if (g.spindle > 0) lines.push("M5");
  }
  lines.push("G0 X0 Y0", "M2", "");
  return lines.join("\n");
}

/** Minimal R12 DXF: a circle per nail plus a point at each centre, using the CNC units and origin. */
export function buildDXF(p: Pattern, g: GcodeSettings, nailDiameter: number): string {
  const pts = cncPoints(p, g);
  const inch = g.units === "in";
  const r = (nailDiameter / 2) * (inch ? 1 / MM_PER_IN : 1);
  const out: string[] = ["0", "SECTION", "2", "HEADER", "9", "$ACADVER", "1", "AC1009", "9", "$INSUNITS", "70", inch ? "1" : "4", "0", "ENDSEC"];
  out.push("0", "SECTION", "2", "ENTITIES");
  for (const [x, y] of pts) {
    out.push("0", "CIRCLE", "8", "NAILS", "10", x.toFixed(4), "20", y.toFixed(4), "30", "0", "40", r.toFixed(4));
    out.push("0", "POINT", "8", "NAIL_CENTERS", "10", x.toFixed(4), "20", y.toFixed(4), "30", "0");
  }
  out.push("0", "ENDSEC", "0", "EOF", "");
  return out.join("\n");
}
