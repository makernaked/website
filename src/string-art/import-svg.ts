import svgpath from "svgpath";
import type { Pt } from "./types";
import { MM_PER_IN } from "./units";

export interface RawContour {
  pts: Pt[];
  closed: boolean;
  layer?: string;
  /** Stroke width in mm, if the shape is stroked. */
  weight?: number;
  /** Closed and filled in the file. */
  filled?: boolean;
}

export interface ImportResult {
  contours: RawContour[];
  warnings: string[];
  /** Layers hidden in the source file; they start out left out. */
  hiddenLayers?: string[];
}

type Seg = { t: "L"; p: Pt } | { t: "C"; c1: Pt; c2: Pt; p: Pt } | { t: "Q"; c: Pt; p: Pt };
interface SubPath {
  start: Pt;
  segs: Seg[];
  closed: boolean;
  layer?: string;
  weight?: number;
  filled?: boolean;
}

const SKIP = new Set(["defs", "clipPath", "mask", "symbol", "marker", "pattern", "metadata", "title", "desc", "style", "script", "linearGradient", "radialGradient", "filter"]);

const UNIT_MM: Record<string, number> = {
  mm: 1,
  cm: 10,
  in: MM_PER_IN,
  pt: MM_PER_IN / 72,
  pc: MM_PER_IN / 6,
  px: MM_PER_IN / 96,
  "": MM_PER_IN / 96,
};

function lengthToMM(v: string | null): number | null {
  if (!v) return null;
  const m = v.trim().match(/^([\d.eE+-]+)\s*(mm|cm|in|pt|pc|px)?$/);
  if (!m) return null;
  const n = parseFloat(m[1]);
  return Number.isFinite(n) && n > 0 ? n * UNIT_MM[m[2] ?? ""] : null;
}

const num = (el: Element, name: string) => parseFloat(el.getAttribute(name) ?? "0") || 0;

/** Millimetres per user unit under a transform (geometric mean of the axis scales). */
function transformScale(transform: string): number {
  let len = 1;
  svgpath("M0 0L1 0M0 0L0 1")
    .transform(transform)
    .abs()
    .iterate((seg, _i, x, y) => {
      if (seg[0] === "L") len *= Math.hypot(seg[1] - x, seg[2] - y);
    });
  return Math.sqrt(len);
}

/** A group's name as an editor would show it: Inkscape label, Illustrator data-name, or id. */
function groupLabel(el: Element): string | null {
  return (
    el.getAttributeNS("http://www.inkscape.org/namespaces/inkscape", "label") ??
    el.getAttribute("data-name") ??
    el.getAttribute("id")
  );
}

/** Converts a basic SVG shape element to path data. */
function elementToPath(el: Element): string | null {
  switch (el.localName) {
    case "path":
      return el.getAttribute("d");
    case "rect": {
      const x = num(el, "x");
      const y = num(el, "y");
      const w = num(el, "width");
      const h = num(el, "height");
      if (w <= 0 || h <= 0) return null;
      let rx = el.hasAttribute("rx") ? num(el, "rx") : num(el, "ry");
      let ry = el.hasAttribute("ry") ? num(el, "ry") : rx;
      rx = Math.min(rx, w / 2);
      ry = Math.min(ry, h / 2);
      if (rx <= 0 || ry <= 0) return `M${x} ${y}H${x + w}V${y + h}H${x}Z`;
      return (
        `M${x + rx} ${y}H${x + w - rx}A${rx} ${ry} 0 0 1 ${x + w} ${y + ry}V${y + h - ry}` +
        `A${rx} ${ry} 0 0 1 ${x + w - rx} ${y + h}H${x + rx}A${rx} ${ry} 0 0 1 ${x} ${y + h - ry}` +
        `V${y + ry}A${rx} ${ry} 0 0 1 ${x + rx} ${y}Z`
      );
    }
    case "circle":
    case "ellipse": {
      const cx = num(el, "cx");
      const cy = num(el, "cy");
      const rx = el.localName === "circle" ? num(el, "r") : num(el, "rx");
      const ry = el.localName === "circle" ? rx : num(el, "ry");
      if (rx <= 0 || ry <= 0) return null;
      return `M${cx - rx} ${cy}A${rx} ${ry} 0 1 0 ${cx + rx} ${cy}A${rx} ${ry} 0 1 0 ${cx - rx} ${cy}Z`;
    }
    case "line":
      return `M${num(el, "x1")} ${num(el, "y1")}L${num(el, "x2")} ${num(el, "y2")}`;
    case "polyline":
    case "polygon": {
      const n = (el.getAttribute("points") ?? "").trim().split(/[\s,]+/).map(parseFloat);
      if (n.length < 4) return null;
      let d = `M${n[0]} ${n[1]}`;
      for (let i = 2; i + 1 < n.length; i += 2) d += `L${n[i]} ${n[i + 1]}`;
      return el.localName === "polygon" ? d + "Z" : d;
    }
  }
  return null;
}

function parsePathData(d: string, transform: string): SubPath[] {
  const subs: SubPath[] = [];
  let cur: SubPath | null = null;
  svgpath(d)
    .abs()
    .unshort()
    .unarc()
    .transform(transform)
    .abs()
    .iterate((seg, _i, x, y) => {
      const cmd = seg[0];
      if (cmd === "M") {
        cur = { start: [seg[1], seg[2]], segs: [], closed: false };
        subs.push(cur);
        return;
      }
      if (!cur) {
        cur = { start: [x, y], segs: [], closed: false };
        subs.push(cur);
      }
      switch (cmd) {
        case "L":
          cur.segs.push({ t: "L", p: [seg[1], seg[2]] });
          break;
        case "H":
          cur.segs.push({ t: "L", p: [seg[1], y] });
          break;
        case "V":
          cur.segs.push({ t: "L", p: [x, seg[1]] });
          break;
        case "C":
          cur.segs.push({ t: "C", c1: [seg[1], seg[2]], c2: [seg[3], seg[4]], p: [seg[5], seg[6]] });
          break;
        case "Q":
          cur.segs.push({ t: "Q", c: [seg[1], seg[2]], p: [seg[3], seg[4]] });
          break;
        case "Z":
        case "z":
          cur.closed = true;
          // A drawing command after Z starts a new subpath at the current point.
          cur = null;
          break;
      }
    });
  return subs.filter((s) => s.segs.length > 0);
}

function flattenCubic(p0: Pt, c1: Pt, c2: Pt, p3: Pt, tol: number, out: Pt[], depth = 0) {
  const dx = p3[0] - p0[0];
  const dy = p3[1] - p0[1];
  const len = Math.hypot(dx, dy) || 1e-12;
  const d1 = Math.abs((c1[0] - p3[0]) * dy - (c1[1] - p3[1]) * dx) / len;
  const d2 = Math.abs((c2[0] - p3[0]) * dy - (c2[1] - p3[1]) * dx) / len;
  const chordLen = Math.hypot(dx, dy);
  const handles = Math.hypot(c1[0] - p0[0], c1[1] - p0[1]) + Math.hypot(c2[0] - p3[0], c2[1] - p3[1]);
  if (depth > 16 || (d1 + d2 <= tol && (chordLen > 1e-9 || handles <= tol))) {
    out.push(p3);
    return;
  }
  const m = (a: Pt, b: Pt): Pt => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  const p01 = m(p0, c1);
  const p12 = m(c1, c2);
  const p23 = m(c2, p3);
  const p012 = m(p01, p12);
  const p123 = m(p12, p23);
  const mid = m(p012, p123);
  flattenCubic(p0, p01, p012, mid, tol, out, depth + 1);
  flattenCubic(mid, p123, p23, p3, tol, out, depth + 1);
}

/** Flattens sub-paths to polylines with a tolerance relative to the overall size. */
export function flattenSubPaths(subs: SubPath[]): RawContour[] {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const ext = (p: Pt) => {
    minX = Math.min(minX, p[0]);
    minY = Math.min(minY, p[1]);
    maxX = Math.max(maxX, p[0]);
    maxY = Math.max(maxY, p[1]);
  };
  for (const s of subs) {
    ext(s.start);
    for (const g of s.segs) ext(g.p);
  }
  const diag = Math.hypot(maxX - minX, maxY - minY) || 1;
  const tol = diag / 4000;

  return subs.map((s) => {
    const pts: Pt[] = [s.start];
    let p = s.start;
    for (const g of s.segs) {
      if (g.t === "L") pts.push(g.p);
      else if (g.t === "C") flattenCubic(p, g.c1, g.c2, g.p, tol, pts);
      else {
        const c1: Pt = [p[0] + (2 / 3) * (g.c[0] - p[0]), p[1] + (2 / 3) * (g.c[1] - p[1])];
        const c2: Pt = [g.p[0] + (2 / 3) * (g.c[0] - g.p[0]), g.p[1] + (2 / 3) * (g.c[1] - g.p[1])];
        flattenCubic(p, c1, c2, g.p, tol, pts);
      }
      p = g.p;
    }
    const first = pts[0];
    const lastPt = pts[pts.length - 1];
    const closed = s.closed || Math.hypot(first[0] - lastPt[0], first[1] - lastPt[1]) < tol * 2;
    return { pts, closed, layer: s.layer, weight: s.weight, filled: closed && s.filled };
  });
}

export function importSVG(text: string): ImportResult {
  const warnings: string[] = [];
  const doc = new DOMParser().parseFromString(text, "image/svg+xml");
  const root = doc.documentElement;
  if (!root || root.localName !== "svg" || doc.getElementsByTagName("parsererror").length) {
    throw new Error("This doesn't look like a valid SVG file.");
  }

  // Map user units to millimetres from the root width/height and viewBox.
  const vb = (root.getAttribute("viewBox") ?? "").trim().split(/[\s,]+/).map(parseFloat);
  const hasVB = vb.length === 4 && vb.every(Number.isFinite) && vb[2] > 0 && vb[3] > 0;
  const widthMM = lengthToMM(root.getAttribute("width"));
  const heightMM = lengthToMM(root.getAttribute("height"));
  let scale = UNIT_MM.px;
  if (hasVB && widthMM) scale = widthMM / vb[2];
  else if (hasVB && heightMM) scale = heightMM / vb[3];
  const rootTransform = `scale(${scale}) ${hasVB ? `translate(${-vb[0]} ${-vb[1]})` : ""}`;

  const subs: SubPath[] = [];
  let skippedText = 0;
  let skippedImages = 0;

  // Work on a live (hidden) copy so computed styles resolve CSS classes and inheritance.
  const host = document.createElement("div");
  // Off-screen rather than visibility:hidden, which every element would inherit.
  host.style.cssText = "position:absolute;left:-10000px;top:0;width:0;height:0;overflow:hidden;opacity:0;pointer-events:none";
  const live = document.importNode(root, true) as unknown as SVGSVGElement;
  host.appendChild(live);
  document.body.appendChild(host);

  // Top-level groups are the layers. Skip a single wrapper group around everything.
  const top = Array.from(live.children).filter((c) => !SKIP.has(c.localName));
  const layerRoot = top.length === 1 && top[0].localName === "g" && top[0].querySelector(":scope > g") ? top[0] : live;

  const walk = (el: Element, transform: string, depth: number, layer: string | undefined) => {
    const cs = getComputedStyle(el);
    if (depth > 64 || cs.display === "none" || cs.visibility === "hidden") return;
    const name = el.localName;
    if (SKIP.has(name)) return;
    if (name === "text") {
      skippedText++;
      return;
    }
    if (name === "image") {
      skippedImages++;
      return;
    }
    const t = `${transform} ${el.getAttribute("transform") ?? ""}`;
    if (name === "use") {
      const href = el.getAttribute("href") ?? el.getAttributeNS("http://www.w3.org/1999/xlink", "href") ?? "";
      const target = href.startsWith("#") ? live.querySelector(`[id="${CSS.escape(href.slice(1))}"]`) : null;
      if (target) {
        const ut = `${t} translate(${num(el, "x")} ${num(el, "y")})`;
        if (target.localName === "symbol") for (const c of Array.from(target.children)) walk(c, ut, depth + 1, layer);
        else walk(target, ut, depth + 1, layer);
      }
      return;
    }
    const d = elementToPath(el);
    if (d) {
      try {
        const stroked = cs.stroke && cs.stroke !== "none";
        const width = parseFloat(cs.strokeWidth);
        const weight = stroked && width > 0 ? width * transformScale(t) : undefined;
        const filled = !!cs.fill && cs.fill !== "none" && parseFloat(cs.fillOpacity || "1") > 0;
        for (const sp of parsePathData(d, t)) subs.push({ ...sp, layer, weight, filled });
      } catch {
        warnings.push("Skipped a path that could not be read.");
      }
    }
    const childLayer = el.parentElement === layerRoot && name === "g" ? (groupLabel(el) ?? layer) : layer;
    for (const c of Array.from(el.children)) walk(c, t, depth + 1, childLayer);
  };
  try {
    for (const c of Array.from(live.children)) walk(c, rootTransform, 0, undefined);
  } finally {
    host.remove();
  }

  if (skippedText) warnings.push(`${skippedText} text element${skippedText > 1 ? "s were" : " was"} skipped. Convert text to paths in your editor.`);
  if (skippedImages) warnings.push("Embedded bitmap images were skipped; only vector shapes are used.");

  // SVG is Y-down; the canvas is Y-up.
  const contours = flattenSubPaths(subs).map((c) => ({
    ...c,
    pts: c.pts.map(([x, y]): Pt => [x, -y]),
  }));
  return { contours, warnings };
}
