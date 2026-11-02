import { jsPDF } from "jspdf";
import { worldContours } from "./geometry";
import { patternStats } from "./pattern";
import type { State } from "./store";
import { PAPERS, planTiles, printBounds, tileLabel, type TilePlan } from "./tiles";
import type { Bounds } from "./types";
import { formatLengthWithUnit, formatLongLength, MM_PER_IN } from "./units";

/** Liang–Barsky segment clipping. */
function clip(x0: number, y0: number, x1: number, y1: number, b: Bounds): [number, number, number, number] | null {
  let t0 = 0;
  let t1 = 1;
  const dx = x1 - x0;
  const dy = y1 - y0;
  const p = [-dx, dx, -dy, dy];
  const q = [x0 - b.minX, b.maxX - x0, y0 - b.minY, b.maxY - y0];
  for (let i = 0; i < 4; i++) {
    if (p[i] === 0) {
      if (q[i] < 0) return null;
    } else {
      const r = q[i] / p[i];
      if (p[i] < 0) {
        if (r > t1) return null;
        if (r > t0) t0 = r;
      } else {
        if (r < t0) return null;
        if (r < t1) t1 = r;
      }
    }
  }
  return [x0 + t0 * dx, y0 + t0 * dy, x0 + t1 * dx, y0 + t1 * dy];
}

type RGB = [number, number, number];

export function buildPDF(s: State): Blob {
  const p = s.pattern;
  const content = printBounds(s);
  if (!p || !content) throw new Error("Calculate the nail pattern first.");
  const ps = s.print;
  const t = planTiles(content, ps);
  const orient = t.pw > t.ph ? "l" : "p";
  const doc = new jsPDF({ unit: "mm", format: [t.pw, t.ph], orientation: orient, compress: true });
  const m = ps.margin;
  const overlap = t.aw - t.sx;
  const nailR = s.settings.nailDiameter / 2;
  const unitsIn = s.units === "in";

  const style = (rgb: RGB, width: number, dash: number[] = []) => {
    doc.setDrawColor(...rgb);
    doc.setLineWidth(width);
    doc.setLineDashPattern(dash, 0);
  };

  // Seams between tiles, in world coordinates.
  const vSeams = Array.from({ length: t.cols - 1 }, (_, i) => t.x0 + (i + 1) * t.sx + overlap / 2);
  const hSeams = Array.from({ length: t.rows - 1 }, (_, i) => t.top - (i + 1) * t.sy - overlap / 2);
  const marks: [number, number][] = [];
  vSeams.forEach((x) => {
    for (let r = 0; r < t.rows; r++) for (const f of [0.25, 0.75]) marks.push([x, t.top - r * t.sy - t.ah * f]);
  });
  hSeams.forEach((y) => {
    for (let c = 0; c < t.cols; c++) for (const f of [0.25, 0.75]) marks.push([t.x0 + c * t.sx + t.aw * f, y]);
  });

  const stats = patternStats(p, s.settings.nailDiameter);
  const pageCount = t.cols * t.rows;

  drawCover(doc, s, t, content, stats, pageCount);

  for (let r = 0; r < t.rows; r++) {
    for (let c = 0; c < t.cols; c++) {
      doc.addPage([t.pw, t.ph], orient);
      const left = t.x0 + c * t.sx;
      const top = t.top - r * t.sy;
      const rect: Bounds = { minX: left, maxX: left + t.aw, minY: top - t.ah, maxY: top };
      const X = (x: number) => m + (x - left);
      const Y = (y: number) => m + (top - y);
      const seg = (x0: number, y0: number, x1: number, y1: number) => {
        const k = clip(x0, y0, x1, y1, rect);
        if (k) doc.line(X(k[0]), Y(k[1]), X(k[2]), Y(k[3]));
      };

      if (ps.grid) {
        const step = unitsIn ? MM_PER_IN : 10;
        style([228, 228, 228], 0.1);
        for (let x = Math.ceil(rect.minX / step) * step; x <= rect.maxX; x += step) seg(x, rect.minY, x, rect.maxY);
        for (let y = Math.ceil(rect.minY / step) * step; y <= rect.maxY; y += step) seg(rect.minX, y, rect.maxX, y);
      }

      style([150, 150, 150], 0.2, [3, 2]);
      seg(0, rect.minY, 0, rect.maxY);
      seg(rect.minX, 0, rect.maxX, 0);

      for (const o of s.objects) {
        if (o.type === "ref" ? !ps.refs : !ps.outline) continue;
        if (o.type === "ref") style([90, 160, 220], 0.25, [2, 1.5]);
        else style([140, 140, 140], 0.25);
        for (const ct of worldContours(o)) {
          const n = ct.pts.length;
          for (let i = 0; i < (ct.closed ? n : n - 1); i++) {
            const a = ct.pts[i];
            const b = ct.pts[(i + 1) % n];
            seg(a[0], a[1], b[0], b[1]);
          }
        }
      }

      if (ps.strings) {
        style([205, 205, 205], 0.1);
        for (const isl of p.islands)
          for (let k = 1; k < isl.sequence.length; k++) {
            const a = p.nails[isl.sequence[k - 1]];
            const b = p.nails[isl.sequence[k]];
            seg(a.x, a.y, b.x, b.y);
          }
      }

      // Seams: this page is trimmed on its left/top seams and laid over its neighbours.
      vSeams.forEach((x, i) => {
        if (x < rect.minX || x > rect.maxX) return;
        const cut = i + 1 === c;
        style(cut ? [0, 0, 0] : [150, 150, 150], cut ? 0.25 : 0.15, cut ? [3, 2] : [0.6, 1.2]);
        seg(x, rect.minY, x, rect.maxY);
        doc.setFontSize(6);
        doc.setTextColor(cut ? 0 : 150);
        doc.text(cut ? "CUT" : "ALIGN", X(x) - 1, m + 12, { angle: 90 });
      });
      hSeams.forEach((y, i) => {
        if (y < rect.minY || y > rect.maxY) return;
        const cut = i + 1 === r;
        style(cut ? [0, 0, 0] : [150, 150, 150], cut ? 0.25 : 0.15, cut ? [3, 2] : [0.6, 1.2]);
        seg(rect.minX, y, rect.maxX, y);
        doc.setFontSize(6);
        doc.setTextColor(cut ? 0 : 150);
        doc.text(cut ? "CUT" : "ALIGN", m + 4, Y(y) - 1);
      });
      style([0, 0, 0], 0.2);
      for (const [x, y] of marks) {
        if (x < rect.minX - 4 || x > rect.maxX + 4 || y < rect.minY - 4 || y > rect.maxY + 4) continue;
        seg(x - 3.5, y, x + 3.5, y);
        seg(x, y - 3.5, x, y + 3.5);
        if (x - 2.5 >= rect.minX && x + 2.5 <= rect.maxX && y - 2.5 >= rect.minY && y + 2.5 <= rect.maxY)
          doc.circle(X(x), Y(y), 2.5, "S");
      }

      // Nails: outline at nail size plus a crosshair for centre-punching.
      style([0, 0, 0], 0.2);
      doc.setFontSize(5);
      doc.setTextColor(60);
      const arm = nailR + 1.2;
      for (const n of p.nails) {
        if (n.x < rect.minX - arm || n.x > rect.maxX + arm || n.y < rect.minY - arm || n.y > rect.maxY + arm) continue;
        seg(n.x - arm, n.y, n.x + arm, n.y);
        seg(n.x, n.y - arm, n.x, n.y + arm);
        const inside = n.x - nailR >= rect.minX && n.x + nailR <= rect.maxX && n.y - nailR >= rect.minY && n.y + nailR <= rect.maxY;
        if (inside) doc.circle(X(n.x), Y(n.y), Math.max(nailR, 0.3), "S");
        if (ps.labels && inside) doc.text(n.label, X(n.x) + nailR + 0.5, Y(n.y) - nailR - 0.3);
      }

      // Page label and a scale check, bottom right (under the next page's overlap when assembled).
      const bar = unitsIn ? MM_PER_IN : 25;
      const bx = m + t.aw - 2 - bar;
      const by = m + t.ah - 8;
      style([120, 120, 120], 0.3);
      doc.line(bx, by, bx + bar, by);
      doc.line(bx, by - 1, bx, by + 1);
      doc.line(bx + bar, by - 1, bx + bar, by + 1);
      doc.setFontSize(6);
      doc.setTextColor(120);
      doc.text(unitsIn ? "1 in" : "25 mm", bx + bar / 2, by - 1.2, { align: "center" });
      doc.setFontSize(12);
      doc.text(tileLabel(r, c), m + t.aw - 2, m + t.ah - 2, { align: "right" });
      doc.setFontSize(6);
      doc.text(`page ${r * t.cols + c + 1} of ${pageCount}`, m + t.aw - 12, m + t.ah - 2.4, { align: "right" });
    }
  }

  if (ps.sequence) drawSequence(doc, s, t, orient);
  return doc.output("blob");
}

function drawCover(
  doc: jsPDF,
  s: State,
  t: TilePlan,
  content: Bounds,
  stats: ReturnType<typeof patternStats>,
  pageCount: number,
) {
  const p = s.pattern!;
  const u = s.units;
  const x = 15;
  let y = 22;
  doc.setTextColor(20);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(20);
  doc.text("String Art Nail Template", x, y);
  doc.setFont("helvetica", "normal");
  doc.setFontSize(9);
  doc.setTextColor(110);
  y += 6;
  doc.text(`MakerNaked · ${new Date().toLocaleDateString()}`, x, y);

  doc.setTextColor(30);
  doc.setFontSize(10);
  y += 10;
  const W = content.maxX - content.minX;
  const H = content.maxY - content.minY;
  const info = [
    `Pattern size: ${formatLengthWithUnit(W, u, 1)} × ${formatLengthWithUnit(H, u, 1)}`,
    `Nails: ${stats.nails} in ${stats.shapes} shape${stats.shapes === 1 ? "" : "s"}, spaced ${formatLengthWithUnit(s.settings.spacing, u)}`,
    `Nail diameter: ${formatLengthWithUnit(s.settings.nailDiameter, u)}`,
    `String: ${stats.lines} lines, about ${formatLongLength(stats.estimate, u)}`,
    `Pages: ${pageCount} (${t.rows} row${t.rows === 1 ? "" : "s"} × ${t.cols} column${t.cols === 1 ? "" : "s"}), ${PAPERS[s.print.paper].label}`,
  ];
  for (const line of info) {
    doc.text(line, x, y);
    y += 5.5;
  }

  y += 3;
  doc.setFont("helvetica", "bold");
  doc.text("Printing and assembly", x, y);
  doc.setFont("helvetica", "normal");
  y += 5.5;
  const steps = [
    "1. Print at 100% / Actual size. Turn off any 'Fit to page' scaling.",
    "2. Check the scale bar below with a ruler before assembling.",
    "3. Trim each page along its dashed CUT lines (top and left edges).",
    "4. Lay it over its neighbour so the registration marks line up, then tape.",
    "5. The dashed cross-hair lines are the canvas centre (0, 0).",
  ];
  for (const line of steps) {
    doc.text(line, x, y);
    y += 5;
  }

  y += 4;
  const bar = u === "in" ? 2 * MM_PER_IN : 50;
  doc.setDrawColor(0);
  doc.setLineWidth(0.4);
  doc.setLineDashPattern([], 0);
  doc.line(x, y, x + bar, y);
  for (let k = 0; k <= (u === "in" ? 8 : 10); k++) {
    const tx = x + (bar * k) / (u === "in" ? 8 : 10);
    const major = u === "in" ? k % 4 === 0 : k % 5 === 0;
    doc.line(tx, y, tx, y - (major ? 3 : 1.5));
  }
  doc.setFontSize(8);
  doc.text(u === "in" ? "This bar should measure exactly 2 in" : "This bar should measure exactly 50 mm", x + bar + 4, y);

  // Tile map with a miniature of the pattern.
  const mapTop = y + 10;
  const mapW = t.pw - 2 * x;
  const mapH = t.ph - mapTop - 15;
  const totalW = t.aw + (t.cols - 1) * t.sx;
  const totalH = t.ah + (t.rows - 1) * t.sy;
  const k = Math.min(mapW / totalW, mapH / totalH);
  const ox = x + (mapW - totalW * k) / 2;
  const oy = mapTop;
  const MX = (wx: number) => ox + (wx - t.x0) * k;
  const MY = (wy: number) => oy + (t.top - wy) * k;

  doc.setDrawColor(150);
  doc.setLineWidth(0.15);
  for (const o of s.objects) {
    if (o.type !== "art") continue;
    for (const c of worldContours(o)) {
      const n = c.pts.length;
      for (let i = 0; i < (c.closed ? n : n - 1); i++) {
        const a = c.pts[i];
        const b = c.pts[(i + 1) % n];
        doc.line(MX(a[0]), MY(a[1]), MX(b[0]), MY(b[1]));
      }
    }
  }
  doc.setFillColor(40, 40, 40);
  const dot = Math.max(0.15, Math.min(0.6, s.settings.spacing * k * 0.2));
  for (const n of p.nails) doc.circle(MX(n.x), MY(n.y), dot, "F");

  doc.setDrawColor(200, 60, 60);
  doc.setLineWidth(0.3);
  doc.setTextColor(200, 60, 60);
  doc.setFontSize(Math.max(6, Math.min(14, t.aw * k * 0.8)));
  for (let r = 0; r < t.rows; r++)
    for (let c = 0; c < t.cols; c++) {
      const l = t.x0 + c * t.sx;
      const tp = t.top - r * t.sy;
      doc.rect(MX(l), MY(tp), t.aw * k, t.ah * k, "S");
      doc.text(tileLabel(r, c), MX(l) + 1.5, MY(tp) + 1.5, { baseline: "top" });
    }
  doc.setTextColor(0);
}

function drawSequence(doc: jsPDF, s: State, t: TilePlan, orient: "l" | "p") {
  const p = s.pattern!;
  const islands = p.islands.filter((i) => i.sequence.length > 1);
  if (!islands.length) return;
  const margin = 14;
  const rowH = 3.6;
  const colW = 24;
  const cols = Math.max(1, Math.floor((t.pw - 2 * margin) / colW));
  let col = 0;
  let y = 0;
  let pageTop = 0;

  const newPage = (title: string) => {
    doc.addPage([t.pw, t.ph], orient);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(12);
    doc.setTextColor(20);
    doc.text(title, margin, margin + 4);
    col = 0;
    pageTop = margin + 12;
    y = pageTop;
  };

  for (const isl of islands) {
    const lines = isl.sequence.length - 1;
    newPage(`Stringing order: shape ${isl.label}`);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(9);
    doc.setTextColor(80);
    doc.text(
      `${isl.nails.length} nails · ${lines} lines · about ${formatLongLength(isl.length * 1.1 + lines * Math.PI * s.settings.nailDiameter, s.units)} of string. Tie on at ${p.nails[isl.sequence[0]].label}, then follow the steps in order.`,
      margin,
      margin + 9,
    );
    pageTop = margin + 15;
    y = pageTop;
    doc.setFont("courier", "normal");
    doc.setFontSize(8);
    doc.setTextColor(20);
    isl.sequence.forEach((ni, step) => {
      if (y > t.ph - margin) {
        col++;
        y = pageTop;
        if (col >= cols) {
          newPage(`Stringing order: shape ${isl.label} (continued)`);
          doc.setFont("courier", "normal");
          doc.setFontSize(8);
          doc.setTextColor(20);
        }
      }
      const cx = margin + col * colW;
      doc.setTextColor(140);
      doc.text(String(step + 1).padStart(4, " "), cx, y);
      doc.setTextColor(20);
      doc.text(p.nails[ni].label, cx + 9, y);
      y += rowH;
    });
  }
}
