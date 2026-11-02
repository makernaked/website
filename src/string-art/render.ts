import { objBounds, orientedCorners, worldContours } from "./geometry";
import { isFilled, worldRegions } from "./regions";
import type { State } from "./store";
import type { Bounds, Obj, Units } from "./types";
import { formatInchLabel, MM_PER_IN } from "./units";

export interface View {
  /** World point at the centre of the canvas. */
  cx: number;
  cy: number;
  /** Pixels per millimetre. */
  zoom: number;
}

export const RULER = 22;
export const HANDLE = 8;
/** Radius of the rotation handle, and its distance above the selection box. */
export const ROTATE_R = 5;
const ROTATE_GAP = 22;

export const COLORS = {
  bg: "#111113",
  gridMinor: "rgba(255,255,255,0.035)",
  gridMajor: "rgba(255,255,255,0.08)",
  axis: "rgba(255,255,255,0.28)",
  ruler: "#1a1a1d",
  rulerText: "#a1a1aa",
  rulerTick: "#71717a",
  ref: "#38bdf8",
  art: "#d4d4d8",
  artFill: "rgba(255,255,255,0.08)",
  select: "#f59e0b",
  nail: "#fafafa",
  problem: "#ef4444",
  light: "#facc15",
};

export function worldToScreen(v: View, w: number, h: number, x: number, y: number): [number, number] {
  return [w / 2 + (x - v.cx) * v.zoom, h / 2 - (y - v.cy) * v.zoom];
}

export function screenToWorld(v: View, w: number, h: number, sx: number, sy: number): [number, number] {
  return [v.cx + (sx - w / 2) / v.zoom, v.cy - (sy - h / 2) / v.zoom];
}

// ---------------------------------------------------------------------------
// Ruler ticks

const IMPERIAL_STEPS = [1 / 32, 1 / 16, 1 / 8, 1 / 4, 1 / 2, 1, 6, 12, 24, 48, 96, 192];
const METRIC_STEPS = [0.5, 1, 5, 10, 50, 100, 500, 1000, 5000, 10000];

export interface TickScale {
  /** Tick steps in display units, from minor to labelled. */
  levels: number[];
  /** Millimetres per display unit. */
  unit: number;
  label: (v: number) => string;
}

export function tickScale(units: Units, zoom: number): TickScale {
  const unit = units === "in" ? MM_PER_IN : 1;
  const steps = units === "in" ? IMPERIAL_STEPS : METRIC_STEPS;
  const px = (s: number) => s * unit * zoom;
  const minorIdx = Math.max(0, steps.findIndex((s) => px(s) >= 6));
  let labelIdx = steps.findIndex((s) => px(s) >= 56);
  if (labelIdx < 0) labelIdx = steps.length - 1;
  const levels = steps.slice(minorIdx, Math.max(minorIdx, labelIdx) + 1);
  const label = units === "in" ? formatInchLabel : (v: number) => String(Math.round(v * 100) / 100);
  return { levels, unit, label };
}

/** Index of the largest level that `v` is a multiple of. */
function tickLevel(v: number, levels: number[]): number {
  for (let i = levels.length - 1; i > 0; i--) {
    const q = v / levels[i];
    if (Math.abs(q - Math.round(q)) < 1e-6) return i;
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Scene

export interface Overlay {
  marquee: Bounds | null;
  cursor: [number, number] | null;
  patternStale: boolean;
  /** Angle readout while rotating, at a screen position. */
  angle: { deg: number; x: number; y: number } | null;
  /** Region under the cursor while picking regions. */
  hoverRegion: { id: string; index: number } | null;
}

function tracePath(ctx: CanvasRenderingContext2D, o: Obj, v: View, w: number, h: number) {
  for (const c of worldContours(o)) {
    c.pts.forEach(([x, y], i) => {
      const [sx, sy] = worldToScreen(v, w, h, x, y);
      if (i === 0) ctx.moveTo(sx, sy);
      else ctx.lineTo(sx, sy);
    });
    if (c.closed) ctx.closePath();
  }
}

export function drawScene(ctx: CanvasRenderingContext2D, s: State, v: View, w: number, h: number, overlay: Overlay) {
  ctx.fillStyle = COLORS.bg;
  ctx.fillRect(0, 0, w, h);

  const [wx0, wy1] = screenToWorld(v, w, h, 0, 0);
  const [wx1, wy0] = screenToWorld(v, w, h, w, h);
  const ticks = tickScale(s.units, v.zoom);

  // Grid: the labelled step plus one finer level when it isn't too dense.
  const gridLevels = ticks.levels.length > 1 ? [ticks.levels[ticks.levels.length - 2], ticks.levels[ticks.levels.length - 1]] : ticks.levels;
  gridLevels.forEach((step, gi) => {
    const mm = step * ticks.unit;
    if (mm * v.zoom < 10) return;
    ctx.strokeStyle = gi === gridLevels.length - 1 ? COLORS.gridMajor : COLORS.gridMinor;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = Math.ceil(wx0 / mm) * mm; x <= wx1; x += mm) {
      const sx = Math.round(worldToScreen(v, w, h, x, 0)[0]) + 0.5;
      ctx.moveTo(sx, 0);
      ctx.lineTo(sx, h);
    }
    for (let y = Math.ceil(wy0 / mm) * mm; y <= wy1; y += mm) {
      const sy = Math.round(worldToScreen(v, w, h, 0, y)[1]) + 0.5;
      ctx.moveTo(0, sy);
      ctx.lineTo(w, sy);
    }
    ctx.stroke();
  });

  // Axes through the origin.
  const [ox, oy] = worldToScreen(v, w, h, 0, 0);
  ctx.strokeStyle = COLORS.axis;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(Math.round(ox) + 0.5, 0);
  ctx.lineTo(Math.round(ox) + 0.5, h);
  ctx.moveTo(0, Math.round(oy) + 0.5);
  ctx.lineTo(w, Math.round(oy) + 0.5);
  ctx.stroke();

  // Reference shapes.
  if (s.display.refs) {
    ctx.save();
    ctx.strokeStyle = COLORS.ref;
    ctx.lineWidth = 1.25;
    ctx.setLineDash([6, 4]);
    for (const o of s.objects) {
      if (o.type !== "ref") continue;
      ctx.beginPath();
      tracePath(ctx, o, v, w, h);
      ctx.stroke();
    }
    ctx.restore();
  }

  // Artwork: regions set to be filled are shaded, and lines are drawn as lines.
  if (s.display.art) {
    for (const o of s.objects) {
      if (o.type !== "art") continue;
      worldRegions(o).forEach((rings, i) => {
        const hovered = overlay.hoverRegion?.id === o.id && overlay.hoverRegion.index === i;
        const filled = isFilled(o, i);
        if (!filled && !hovered) return;
        ctx.beginPath();
        for (const ring of rings) {
          ring.forEach(([x, y], k) => {
            const [sx, sy] = worldToScreen(v, w, h, x, y);
            if (k === 0) ctx.moveTo(sx, sy);
            else ctx.lineTo(sx, sy);
          });
          ctx.closePath();
        }
        ctx.fillStyle = hovered ? (filled ? "rgba(245,158,11,0.38)" : "rgba(245,158,11,0.2)") : COLORS.artFill;
        ctx.fill("evenodd");
      });
      ctx.beginPath();
      tracePath(ctx, o, v, w, h);
      ctx.strokeStyle = COLORS.art;
      ctx.lineWidth = 1;
      ctx.stroke();
    }
  }

  // Pattern.
  const p = s.pattern;
  if (p) {
    ctx.save();
    if (overlay.patternStale) ctx.globalAlpha = 0.3;
    if (s.display.strings) {
      ctx.strokeStyle = s.display.stringColor;
      ctx.lineWidth = 0.75;
      const a = ctx.globalAlpha;
      ctx.globalAlpha = a * 0.55;
      ctx.beginPath();
      for (const isl of p.islands) {
        isl.sequence.forEach((ni, k) => {
          const n = p.nails[ni];
          const [sx, sy] = worldToScreen(v, w, h, n.x, n.y);
          if (k === 0) ctx.moveTo(sx, sy);
          else ctx.lineTo(sx, sy);
        });
      }
      ctx.stroke();
      ctx.globalAlpha = a;
    }
    if (s.display.nails) {
      const r = Math.max(1.5, (s.settings.nailDiameter / 2) * v.zoom);
      ctx.fillStyle = COLORS.nail;
      ctx.beginPath();
      for (const n of p.nails) {
        const [sx, sy] = worldToScreen(v, w, h, n.x, n.y);
        if (sx < -r || sy < -r || sx > w + r || sy > h + r) continue;
        ctx.moveTo(sx + r, sy);
        ctx.arc(sx, sy, r, 0, Math.PI * 2);
      }
      ctx.fill();
      if (s.display.labels && s.settings.spacing * v.zoom >= 26) {
        ctx.fillStyle = "#e4e4e7";
        ctx.font = "10px ui-sans-serif, system-ui, sans-serif";
        ctx.textBaseline = "bottom";
        for (const n of p.nails) {
          const [sx, sy] = worldToScreen(v, w, h, n.x, n.y);
          if (sx < -40 || sy < -20 || sx > w + 40 || sy > h + 20) continue;
          ctx.fillText(n.label, sx + r + 1, sy - r - 1);
        }
      }
    }

    // Problems: regions too small to nail in red (ringed so tiny ones stand out),
    // and a cross where each dropped nail would have gone.
    if (p.issues) {
      ctx.strokeStyle = COLORS.light;
      ctx.lineWidth = 1.5;
      ctx.setLineDash([5, 4]);
      for (const rings of p.issues.light ?? []) {
        ctx.beginPath();
        for (const ring of rings) {
          ring.forEach(([x, y], k) => {
            const [sx, sy] = worldToScreen(v, w, h, x, y);
            if (k === 0) ctx.moveTo(sx, sy);
            else ctx.lineTo(sx, sy);
          });
          ctx.closePath();
        }
        ctx.stroke();
      }
      ctx.setLineDash([]);
      ctx.strokeStyle = COLORS.problem;
      ctx.lineWidth = 1.5;
      for (const rings of p.issues.small) {
        ctx.beginPath();
        let minX = Infinity;
        let minY = Infinity;
        let maxX = -Infinity;
        let maxY = -Infinity;
        for (const ring of rings) {
          ring.forEach(([x, y], k) => {
            const [sx, sy] = worldToScreen(v, w, h, x, y);
            minX = Math.min(minX, sx);
            minY = Math.min(minY, sy);
            maxX = Math.max(maxX, sx);
            maxY = Math.max(maxY, sy);
            if (k === 0) ctx.moveTo(sx, sy);
            else ctx.lineTo(sx, sy);
          });
          ctx.closePath();
        }
        ctx.fillStyle = "rgba(239,68,68,0.45)";
        ctx.fill("evenodd");
        ctx.stroke();
        ctx.beginPath();
        ctx.arc((minX + maxX) / 2, (minY + maxY) / 2, Math.max(12, Math.hypot(maxX - minX, maxY - minY) / 2 + 6), 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.beginPath();
      for (const [x, y] of p.issues.dropped) {
        const [sx, sy] = worldToScreen(v, w, h, x, y);
        ctx.moveTo(sx - 4, sy - 4);
        ctx.lineTo(sx + 4, sy + 4);
        ctx.moveTo(sx + 4, sy - 4);
        ctx.lineTo(sx - 4, sy + 4);
      }
      ctx.stroke();
    }
    ctx.restore();
  }

  // Selection.
  const ids = new Set(s.selection);
  const sel = s.objects.filter((o) => ids.has(o.id));
  if (sel.length) {
    ctx.strokeStyle = COLORS.select;
    ctx.lineWidth = 1;
    // Each object's own (rotated) box, where it differs from the selection box.
    ctx.setLineDash([3, 3]);
    for (const o of sel) {
      if (sel.length === 1 && !o.rotation) continue;
      ctx.beginPath();
      orientedCorners(o).forEach(([x, y], i) => {
        const [sx, sy] = worldToScreen(v, w, h, x, y);
        if (i === 0) ctx.moveTo(sx, sy);
        else ctx.lineTo(sx, sy);
      });
      ctx.closePath();
      ctx.stroke();
    }
    ctx.setLineDash([]);
    const gb = groupBounds(sel);
    strokeBounds(ctx, gb, v, w, h, []);
    const [tx, ty] = handlePositions(gb, v, w, h)[1];
    const [rx, ry] = rotateHandlePosition(gb, v, w, h);
    ctx.beginPath();
    ctx.moveTo(Math.round(tx) + 0.5, ty);
    ctx.lineTo(Math.round(rx) + 0.5, ry + ROTATE_R);
    ctx.stroke();
    ctx.fillStyle = COLORS.bg;
    ctx.beginPath();
    ctx.arc(rx, ry, ROTATE_R, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    for (const [hx, hy] of handlePositions(gb, v, w, h)) {
      ctx.fillRect(hx - HANDLE / 2, hy - HANDLE / 2, HANDLE, HANDLE);
      ctx.strokeRect(hx - HANDLE / 2 + 0.5, hy - HANDLE / 2 + 0.5, HANDLE - 1, HANDLE - 1);
    }
  }

  if (overlay.angle) {
    const text = `${Math.round(overlay.angle.deg * 10) / 10}°`;
    ctx.font = "11px ui-sans-serif, system-ui, sans-serif";
    const tw = ctx.measureText(text).width;
    const x = overlay.angle.x + 14;
    const y = overlay.angle.y + 14;
    ctx.fillStyle = "rgba(0,0,0,0.75)";
    ctx.fillRect(x, y, tw + 10, 18);
    ctx.fillStyle = COLORS.select;
    ctx.textBaseline = "middle";
    ctx.fillText(text, x + 5, y + 9);
  }

  if (overlay.marquee) {
    const m = overlay.marquee;
    const [x0, y0] = worldToScreen(v, w, h, m.minX, m.maxY);
    const [x1, y1] = worldToScreen(v, w, h, m.maxX, m.minY);
    ctx.fillStyle = "rgba(245,158,11,0.08)";
    ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
    ctx.strokeStyle = COLORS.select;
    ctx.setLineDash([4, 3]);
    ctx.strokeRect(x0 + 0.5, y0 + 0.5, x1 - x0, y1 - y0);
    ctx.setLineDash([]);
  }

  drawRulers(ctx, s, v, w, h, ticks, overlay.cursor, sel.length ? groupBounds(sel) : null);
}

export function groupBounds(objs: Obj[]): Bounds {
  const b = objs.map(objBounds);
  return {
    minX: Math.min(...b.map((o) => o.minX)),
    minY: Math.min(...b.map((o) => o.minY)),
    maxX: Math.max(...b.map((o) => o.maxX)),
    maxY: Math.max(...b.map((o) => o.maxY)),
  };
}

function strokeBounds(ctx: CanvasRenderingContext2D, b: Bounds, v: View, w: number, h: number, dash: number[]) {
  const [x0, y0] = worldToScreen(v, w, h, b.minX, b.maxY);
  const [x1, y1] = worldToScreen(v, w, h, b.maxX, b.minY);
  ctx.setLineDash(dash);
  ctx.strokeRect(Math.round(x0) + 0.5, Math.round(y0) + 0.5, Math.round(x1 - x0), Math.round(y1 - y0));
  ctx.setLineDash([]);
}

/** Handle order: nw, n, ne, e, se, s, sw, w. */
export const HANDLE_DIRS: [number, number][] = [
  [-1, 1],
  [0, 1],
  [1, 1],
  [1, 0],
  [1, -1],
  [0, -1],
  [-1, -1],
  [-1, 0],
];

export function handlePositions(b: Bounds, v: View, w: number, h: number): [number, number][] {
  const cx = (b.minX + b.maxX) / 2;
  const cy = (b.minY + b.maxY) / 2;
  const hw = (b.maxX - b.minX) / 2;
  const hh = (b.maxY - b.minY) / 2;
  return HANDLE_DIRS.map(([dx, dy]) => worldToScreen(v, w, h, cx + dx * hw, cy + dy * hh));
}

/** Screen position of the rotation handle, centred above the selection box. */
export function rotateHandlePosition(b: Bounds, v: View, w: number, h: number): [number, number] {
  const [x, y] = worldToScreen(v, w, h, (b.minX + b.maxX) / 2, b.maxY);
  return [x, y - ROTATE_GAP];
}

function drawRulers(
  ctx: CanvasRenderingContext2D,
  s: State,
  v: View,
  w: number,
  h: number,
  ticks: TickScale,
  cursor: [number, number] | null,
  sel: Bounds | null,
) {
  ctx.save();
  ctx.fillStyle = COLORS.ruler;
  ctx.fillRect(0, 0, w, RULER);
  ctx.fillRect(0, 0, RULER, h);

  // Selection extent highlight.
  if (sel) {
    ctx.fillStyle = "rgba(245,158,11,0.22)";
    const [x0, y0] = worldToScreen(v, w, h, sel.minX, sel.maxY);
    const [x1, y1] = worldToScreen(v, w, h, sel.maxX, sel.minY);
    ctx.fillRect(Math.max(RULER, x0), 0, x1 - Math.max(RULER, x0), RULER);
    ctx.fillRect(0, Math.max(RULER, y0), RULER, y1 - Math.max(RULER, y0));
  }

  const { levels, unit, label } = ticks;
  const minor = levels[0] * unit;
  const top = levels.length - 1;
  const heightFor = (lvl: number) => (top === 0 ? RULER - 6 : 4 + (lvl / top) * (RULER - 10));

  ctx.strokeStyle = COLORS.rulerTick;
  ctx.fillStyle = COLORS.rulerText;
  ctx.font = "10px ui-sans-serif, system-ui, sans-serif";
  ctx.lineWidth = 1;

  // Horizontal ruler.
  const [wx0] = screenToWorld(v, w, h, RULER, 0);
  const [wx1] = screenToWorld(v, w, h, w, 0);
  ctx.beginPath();
  ctx.textBaseline = "top";
  for (let i = Math.ceil(wx0 / minor); i * minor <= wx1; i++) {
    const mm = i * minor;
    const val = i * levels[0];
    const lvl = tickLevel(val, levels);
    const sx = Math.round(worldToScreen(v, w, h, mm, 0)[0]) + 0.5;
    const th = heightFor(lvl);
    ctx.moveTo(sx, RULER);
    ctx.lineTo(sx, RULER - th);
    if (lvl === top) ctx.fillText(label(val), sx + 3, 2);
  }
  ctx.stroke();

  // Vertical ruler.
  const [, wy1] = screenToWorld(v, w, h, 0, RULER);
  const [, wy0] = screenToWorld(v, w, h, 0, h);
  ctx.beginPath();
  for (let i = Math.ceil(wy0 / minor); i * minor <= wy1; i++) {
    const mm = i * minor;
    const val = i * levels[0];
    const lvl = tickLevel(val, levels);
    const sy = Math.round(worldToScreen(v, w, h, 0, mm)[1]) + 0.5;
    const th = heightFor(lvl);
    ctx.moveTo(RULER, sy);
    ctx.lineTo(RULER - th, sy);
    if (lvl === top) {
      ctx.save();
      ctx.translate(2, sy - 3);
      ctx.rotate(-Math.PI / 2);
      ctx.textBaseline = "top";
      ctx.fillText(label(val), 0, 0);
      ctx.restore();
    }
  }
  ctx.stroke();

  // Cursor position markers.
  if (cursor) {
    const [cx, cy] = worldToScreen(v, w, h, cursor[0], cursor[1]);
    ctx.strokeStyle = COLORS.select;
    ctx.beginPath();
    ctx.moveTo(Math.round(cx) + 0.5, 0);
    ctx.lineTo(Math.round(cx) + 0.5, RULER);
    ctx.moveTo(0, Math.round(cy) + 0.5);
    ctx.lineTo(RULER, Math.round(cy) + 0.5);
    ctx.stroke();
  }

  ctx.fillStyle = COLORS.ruler;
  ctx.fillRect(0, 0, RULER, RULER);
  ctx.fillStyle = COLORS.rulerText;
  ctx.textBaseline = "middle";
  ctx.fillText(s.units, 4, RULER / 2);
  ctx.strokeStyle = "#27272a";
  ctx.beginPath();
  ctx.moveTo(0, RULER + 0.5);
  ctx.lineTo(w, RULER + 0.5);
  ctx.moveTo(RULER + 0.5, 0);
  ctx.lineTo(RULER + 0.5, h);
  ctx.stroke();
  ctx.restore();
}
