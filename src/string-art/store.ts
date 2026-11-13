"use client";

import { useSyncExternalStore } from "react";
import { artToWorld, normalizeDegrees, objBounds, regularRadius, regularSize, rotateObj, unionBounds, worldToArt } from "./geometry";
import type { RawContour } from "./import-svg";
import { computePattern, patternKey } from "./pattern";
import { nearestChain } from "./graph";
import { chainLines, matchTolerance, thinGraph } from "./outline";
import { arrangement, chainIndexAt, cutChains, isFilled, regionContains, worldChains, worldThinChains } from "./regions";
import type {
  Artwork,
  Bounds,
  DisplaySettings,
  GcodeSettings,
  LayerSettings,
  Obj,
  Pattern,
  PatternSettings,
  PrintSettings,
  Pt,
  RefShape,
  Units,
} from "./types";
import { MM_PER_IN } from "./units";

export interface State {
  objects: Obj[];
  selection: string[];
  units: Units;
  settings: PatternSettings;
  print: PrintSettings;
  gcode: GcodeSettings;
  display: DisplaySettings;
  pattern: Pattern | null;
  past: Obj[][];
  future: Obj[][];
  /** Transient UI message, e.g. import warnings. */
  notice: { text: string; kind: "info" | "error" } | null;
  /** Clicking the canvas toggles region fills or shading, lines, nails or line widths, instead of selecting. */
  pickMode: "regions" | "shade" | "lines" | "nails" | "widths" | null;
  /** Width given to pieces of line clicked in "widths" mode (mm). */
  paintWidth: number;
  /** Shading given to regions clicked in "shade" mode. */
  paintShade: number;
}

const STORAGE_KEY = "makernaked.string-art.v1";
const HISTORY_LIMIT = 100;

export const DEFAULT_SETTINGS: PatternSettings = {
  spacing: 3 / 8 * MM_PER_IN,
  cornerAngle: 35,
  nailDiameter: 1.6,
  shading: 4,
  minNails: 12,
  outline: true,
  autoSpacing: true,
  restarts: false,
  seed: 1,
};

const DEFAULT_PRINT: PrintSettings = {
  paper: "letter",
  orientation: "auto",
  margin: 0.25 * MM_PER_IN,
  overlap: 0.5 * MM_PER_IN,
  outline: true,
  refs: false,
  strings: false,
  labels: true,
  grid: true,
  sequence: true,
  scale: 1,
};

const DEFAULT_GCODE: GcodeSettings = {
  mode: "plunge",
  units: "mm",
  origin: "center",
  safeZ: 5,
  depth: -2,
  plungeFeed: 300,
  spindle: 0,
  dwell: 0,
  laserPower: 1000,
  laserDwell: 0.1,
};

const DEFAULT_DISPLAY: DisplaySettings = {
  art: true,
  refs: true,
  nails: true,
  strings: true,
  labels: true,
  stringColor: "#e8c39e",
  snap: true,
};

function initialState(): State {
  return {
    objects: [],
    selection: [],
    units: "in",
    settings: DEFAULT_SETTINGS,
    print: DEFAULT_PRINT,
    gcode: DEFAULT_GCODE,
    display: DEFAULT_DISPLAY,
    pattern: null,
    past: [],
    future: [],
    notice: null,
    pickMode: null,
    paintWidth: 0.25 * MM_PER_IN,
    paintShade: 2,
  };
}

// ---------------------------------------------------------------------------
// Store

type Listener = () => void;
let state: State = loadFromStorage() ?? initialState();
const listeners = new Set<Listener>();

export function getState(): State {
  return state;
}

export function setState(patch: Partial<State> | ((s: State) => Partial<State>)) {
  const p = typeof patch === "function" ? patch(state) : patch;
  state = { ...state, ...p };
  listeners.forEach((l) => l());
  scheduleSave();
}

export function subscribe(l: Listener) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

export function useEditor<T>(selector: (s: State) => T): T {
  return useSyncExternalStore(
    subscribe,
    () => selector(state),
    () => selector(state),
  );
}

// ---------------------------------------------------------------------------
// Persistence

let saveTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleSave() {
  if (typeof window === "undefined") return;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(serialize(state)));
    } catch {
      setState({ notice: { text: "Couldn't autosave: browser storage is full. Use Save to keep a copy.", kind: "error" } });
    }
  }, 400);
}

function serialize(s: State) {
  return {
    app: "makernaked-string-art",
    version: 1,
    units: s.units,
    objects: s.objects,
    settings: s.settings,
    print: s.print,
    gcode: s.gcode,
    display: s.display,
    pattern: s.pattern,
  };
}

function deserialize(data: unknown): Partial<State> | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  if (d.app !== "makernaked-string-art" || !Array.isArray(d.objects)) return null;
  return {
    units: d.units === "mm" ? "mm" : "in",
    objects: (d.objects as Obj[]).map((o) => ({ ...o, rotation: o.rotation ?? 0 })),
    settings: { ...DEFAULT_SETTINGS, ...(d.settings as object) },
    print: { ...DEFAULT_PRINT, ...(d.print as object) },
    gcode: { ...DEFAULT_GCODE, ...(d.gcode as object) },
    display: { ...DEFAULT_DISPLAY, ...(d.display as object) },
    pattern: (d.pattern as Pattern) ?? null,
  };
}

function loadFromStorage(): State | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? deserialize(JSON.parse(raw)) : null;
    return parsed ? { ...initialState(), ...parsed } : null;
  } catch {
    return null;
  }
}

export function projectJSON(): string {
  return JSON.stringify(serialize(state));
}

export function loadProject(text: string) {
  let parsed: Partial<State> | null = null;
  try {
    parsed = deserialize(JSON.parse(text));
  } catch {
    // fall through
  }
  if (!parsed) throw new Error("That file isn't a String Art project.");
  setState({ ...initialState(), ...parsed });
}

export function newProject() {
  setState((s) => ({ ...initialState(), units: s.units, settings: s.settings, print: s.print, gcode: s.gcode, display: s.display }));
}

// ---------------------------------------------------------------------------
// History

export function checkpoint() {
  setState((s) => ({ past: [...s.past, s.objects].slice(-HISTORY_LIMIT), future: [] }));
}

/** Replaces objects, recording an undo step unless `history` is false. */
export function setObjects(objects: Obj[], history = true) {
  if (history) checkpoint();
  setState({ objects });
}

export function undo() {
  setState((s) => {
    if (!s.past.length) return {};
    const objects = s.past[s.past.length - 1];
    const ids = new Set(objects.map((o) => o.id));
    return {
      objects,
      past: s.past.slice(0, -1),
      future: [s.objects, ...s.future],
      selection: s.selection.filter((id) => ids.has(id)),
    };
  });
  autoRecalculate();
}

export function redo() {
  setState((s) => {
    if (!s.future.length) return {};
    const objects = s.future[0];
    const ids = new Set(objects.map((o) => o.id));
    return {
      objects,
      past: [...s.past, s.objects],
      future: s.future.slice(1),
      selection: s.selection.filter((id) => ids.has(id)),
    };
  });
  autoRecalculate();
}

// ---------------------------------------------------------------------------
// Objects

export function newId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2) + Date.now().toString(36);
}

export function select(ids: string[]) {
  setState({ selection: ids });
}

export function selectedObjects(s: State = state): Obj[] {
  const ids = new Set(s.selection);
  return s.objects.filter((o) => ids.has(o.id));
}

export function selectionBounds(s: State = state): Bounds | null {
  return unionBounds(selectedObjects(s).map(objBounds));
}

export function addObjects(objs: Obj[]) {
  setObjects([...state.objects, ...objs]);
  select(objs.map((o) => o.id));
}

/** Applies `fn` to every selected object. */
export function updateSelected(fn: (o: Obj) => Obj, history = true) {
  const ids = new Set(state.selection);
  setObjects(
    state.objects.map((o) => (ids.has(o.id) ? fn(o) : o)),
    history,
  );
}

export function updateObject(id: string, patch: Partial<Obj>) {
  setObjects(state.objects.map((o) => (o.id === id ? ({ ...o, ...patch } as Obj) : o)));
}

export function deleteSelection() {
  if (!state.selection.length) return;
  const ids = new Set(state.selection);
  setObjects(state.objects.filter((o) => !ids.has(o.id)));
  select([]);
}

export function moveSelection(dx: number, dy: number) {
  if (!state.selection.length) return;
  updateSelected((o) => ({ ...o, x: o.x + dx, y: o.y + dy }));
}

/**
 * Maps objects proportionally from one bounding box to another (group move/resize).
 * Objects turned by a quarter-turn swap axes; other angles can't stretch without
 * skewing, so they scale uniformly by whichever axis changed most.
 */
export function mapObjects(objs: Obj[], from: Bounds, to: Bounds): Obj[] {
  const fw = from.maxX - from.minX;
  const fh = from.maxY - from.minY;
  const sx = fw > 1e-9 ? (to.maxX - to.minX) / fw : 1;
  const sy = fh > 1e-9 ? (to.maxY - to.minY) / fh : 1;
  return objs.map((o) => {
    const r = (normalizeDegrees(o.rotation ?? 0) + 180) % 180;
    let kw = sx;
    let kh = sy;
    if (Math.abs(r - 90) < 1e-6) {
      kw = sy;
      kh = sx;
    } else if (r > 1e-6 && r < 180 - 1e-6) {
      kw = kh = Math.abs(sx - 1) >= Math.abs(sy - 1) ? sx : sy;
    }
    return {
      ...o,
      x: to.minX + (o.x - from.minX) * sx,
      y: to.minY + (o.y - from.minY) * sy,
      w: Math.max(o.w * kw, 0.01),
      h: Math.max(o.h * kh, 0.01),
    };
  });
}

/** Resizes/moves the current selection so its bounds become `to`. */
export function setSelectionBounds(to: Bounds, history = true) {
  const from = selectionBounds();
  if (!from) return;
  const mapped = new Map(mapObjects(selectedObjects(), from, to).map((o) => [o.id, o]));
  setObjects(
    state.objects.map((o) => mapped.get(o.id) ?? o),
    history,
  );
}

let clipboard: Obj[] = [];
let pasteCount = 0;

function pasteStep() {
  return state.units === "in" ? 0.5 * MM_PER_IN : 10;
}

export function copySelection() {
  clipboard = selectedObjects();
  pasteCount = 0;
}

export function cutSelection() {
  copySelection();
  deleteSelection();
}

export function paste() {
  if (!clipboard.length) return;
  pasteCount++;
  const d = pasteStep() * pasteCount;
  addObjects(clipboard.map((o) => ({ ...o, id: newId(), x: o.x + d, y: o.y - d })));
}

export function duplicateSelection() {
  const objs = selectedObjects();
  if (!objs.length) return;
  const d = pasteStep();
  addObjects(objs.map((o) => ({ ...o, id: newId(), x: o.x + d, y: o.y - d })));
}

export function selectAll() {
  select(state.objects.map((o) => o.id));
}

export type AlignMode = "left" | "hcenter" | "right" | "top" | "vcenter" | "bottom";

/**
 * Aligns each selected object to the selection bounds, or to the canvas axes
 * when `toCanvas` is set (or only one object is selected).
 */
export function align(mode: AlignMode, toCanvas: boolean) {
  const objs = selectedObjects();
  if (!objs.length) return;
  const useCanvas = toCanvas || objs.length === 1;
  const t = useCanvas ? { minX: 0, maxX: 0, minY: 0, maxY: 0 } : selectionBounds()!;
  // Work from each object's visible bounds so rotated shapes line up by what you see.
  updateSelected((o) => {
    const b = objBounds(o);
    switch (mode) {
      case "left":
        return { ...o, x: o.x + t.minX - b.minX };
      case "hcenter":
        return { ...o, x: o.x + (t.minX + t.maxX) / 2 - (b.minX + b.maxX) / 2 };
      case "right":
        return { ...o, x: o.x + t.maxX - b.maxX };
      case "top":
        return { ...o, y: o.y + t.maxY - b.maxY };
      case "vcenter":
        return { ...o, y: o.y + (t.minY + t.maxY) / 2 - (b.minY + b.maxY) / 2 };
      case "bottom":
        return { ...o, y: o.y + t.minY - b.minY };
    }
  });
}

/**
 * Rotates the selection counter-clockwise by `deg`: a single object about its
 * own centre, several about the centre of their combined bounds.
 */
export function rotateSelection(deg: number) {
  const objs = selectedObjects();
  if (!objs.length) return;
  const b = selectionBounds()!;
  const [cx, cy] = objs.length === 1 ? [objs[0].x, objs[0].y] : [(b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2];
  updateSelected((o) => rotateObj(o, deg, cx, cy));
}

/** Moves the selection as a group so its centre is on the canvas origin. */
export function centerSelectionOnCanvas() {
  const b = selectionBounds();
  if (!b) return;
  const dx = -(b.minX + b.maxX) / 2;
  const dy = -(b.minY + b.maxY) / 2;
  moveSelection(dx, dy);
}

/** Spaces selected objects so the gaps between them are equal. */
export function distribute(axis: "x" | "y") {
  const objs = selectedObjects();
  if (objs.length < 3) return;
  const lo = (o: Obj) => (axis === "x" ? objBounds(o).minX : objBounds(o).minY);
  const size = (o: Obj) => {
    const b = objBounds(o);
    return axis === "x" ? b.maxX - b.minX : b.maxY - b.minY;
  };
  const sorted = [...objs].sort((a, b) => lo(a) + size(a) / 2 - (lo(b) + size(b) / 2));
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  const start = lo(first);
  const end = lo(last) + size(last);
  const total = sorted.reduce((sum, o) => sum + size(o), 0);
  const gap = (end - start - total) / (sorted.length - 1);
  // Shift each object so its visible box starts at the next slot.
  const shift = new Map<string, number>();
  let cursor = start;
  for (const o of sorted) {
    shift.set(o.id, cursor - lo(o));
    cursor += size(o) + gap;
  }
  updateSelected((o) => (axis === "x" ? { ...o, x: o.x + shift.get(o.id)! } : { ...o, y: o.y + shift.get(o.id)! }));
}

// ---------------------------------------------------------------------------
// Creation

export const SHAPE_PRESETS: { label: string; kind: RefShape["kind"]; sides: number }[] = [
  { label: "Rectangle", kind: "polygon", sides: 4 },
  { label: "Circle", kind: "ellipse", sides: 0 },
  { label: "Triangle", kind: "polygon", sides: 3 },
  { label: "Pentagon", kind: "polygon", sides: 5 },
  { label: "Hexagon", kind: "polygon", sides: 6 },
  { label: "Octagon", kind: "polygon", sides: 8 },
];

export function addReferenceShape(preset: (typeof SHAPE_PRESETS)[number]) {
  const across = state.units === "in" ? 12 * MM_PER_IN : 300;
  const base: RefShape = {
    id: newId(),
    name: preset.label,
    type: "ref",
    kind: preset.kind,
    sides: preset.sides,
    x: 0,
    y: 0,
    w: across,
    h: across,
    rotation: 0,
  };
  // Size regular shapes by their corner-to-corner distance.
  const size = preset.kind === "polygon" && preset.sides !== 4 ? regularSize(base, across / 2) : { w: across, h: across };
  addObjects([{ ...base, ...size }]);
}

/**
 * Applies a kind/sides change. A regular shape stays regular and keeps its
 * corner-to-corner size.
 */
export function reshapeRef(s: RefShape, patch: Partial<RefShape>): RefShape {
  const r = regularRadius(s);
  const next = { ...s, ...patch };
  return r === null ? next : { ...next, ...regularSize(next, r) };
}

export function makeArtwork(name: string, contours: RawContour[], hiddenLayers: string[] = []): Artwork | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const c of contours)
    for (const [x, y] of c.pts) {
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  if (!Number.isFinite(minX)) return null;
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const round = (v: number) => Math.round(v * 1e4) / 1e4;
  const w0 = Math.max(maxX - minX, 0.01);
  const h0 = Math.max(maxY - minY, 0.01);
  // Scale widths by the file's line weights when its single lines differ.
  const weights = new Set(contours.filter((c) => !c.closed && c.weight).map((c) => c.weight));
  const present = new Set(contours.map((c) => c.layer));
  const hidden = hiddenLayers.filter((l) => present.has(l));
  return {
    id: newId(),
    name,
    type: "art",
    x: 0,
    y: 0,
    w: w0,
    h: h0,
    w0,
    h0,
    rotation: 0,
    contours: contours
      .filter((c) => c.pts.length > 1)
      .map((c) => ({
        closed: c.closed,
        pts: c.pts.flatMap(([x, y]) => [round(x - cx), round(y - cy)]),
        ...(c.layer ? { layer: c.layer } : {}),
        ...(c.weight ? { weight: round(c.weight) } : {}),
        ...(c.filled ? { filled: true } : {}),
      })),
    ...(weights.size > 1 ? { lineWeights: true } : {}),
    ...(hidden.length ? { layers: Object.fromEntries(hidden.map((l) => [l, { include: false }])) } : {}),
  };
}

// ---------------------------------------------------------------------------
// Regions

export function toggleRegion(artId: string, index: number) {
  const a = findArt(artId);
  const region = a && arrangement(a).regions[index];
  if (!a || !region) return;
  // The choice is saved as a point inside the region; earlier ones inside it are replaced.
  const on = !isFilled(a, index);
  const fills = (a.fills ?? []).filter((f) => !regionContains(region, f.at));
  updateObject(artId, { fills: [...fills, { at: region.sample, on }] } as Partial<Artwork>);
  autoRecalculate();
}

/**
 * Gives a region its own shading (saved as a point inside it). Clicking again
 * with the same shading goes back to the layer's or pattern's shading.
 */
export function shadeRegion(artId: string, index: number, shading: number) {
  const a = findArt(artId);
  const region = a && arrangement(a).regions[index];
  if (!a || !region) return;
  const mine = (a.shades ?? []).filter((x) => regionContains(region, x.at));
  const others = (a.shades ?? []).filter((x) => !regionContains(region, x.at));
  const same = mine.length > 0 && mine[mine.length - 1].shading === shading;
  const shades = same ? others : [...others, { at: region.sample, shading }];
  updateObject(artId, { shades: shades.length ? shades : undefined } as Partial<Artwork>);
  autoRecalculate();
}

export function restoreShades() {
  const ids = new Set(regionTargets().map((a) => a.id));
  setObjects(state.objects.map((o) => (o.type === "art" && ids.has(o.id) ? { ...o, shades: undefined } : o)));
  autoRecalculate();
}

function findArt(id: string): Artwork | undefined {
  return state.objects.find((o): o is Artwork => o.id === id && o.type === "art");
}

/** Removes a line piece (no nails, regions either side join), or puts it back. */
export function toggleLine(artId: string, index: number) {
  const a = findArt(artId);
  const piece = a && worldChains(a)[index];
  if (!a || !piece) return;
  const cuts = a.cuts ?? [];
  const next = cutChains(a).has(index) ? cuts.filter((p) => chainIndexAt(a, p) !== index) : [...cuts, piece.mid];
  updateObject(artId, { cuts: next.length ? next : undefined } as Partial<Artwork>);
  autoRecalculate();
}

/**
 * Gives a piece of single line (or with `wholeLine`, every piece of the drawn
 * line) its own width in artwork units. Clicking again with the same width goes
 * back to the layer's width.
 */
export function paintLineWidth(artId: string, index: number, width: number, wholeLine: boolean) {
  const a = findArt(artId);
  if (!a) return;
  const g = thinGraph(a);
  const pieces = worldThinChains(a);
  if (!pieces[index]) return;
  const lineOf = chainLines(g);
  const targets = wholeLine ? pieces.flatMap((_, i) => (lineOf[i] === lineOf[index] ? [i] : [])) : [index];
  const tol = matchTolerance(a);
  const pieceOf = (p: Pt) => nearestChain(g.verts, g.chains, p, tol);
  const current = a.widths ?? [];
  const mine = current.filter((w) => targets.includes(pieceOf(w.at)));
  const already = mine.length === targets.length && mine.every((w) => Math.abs(w.width - width) < 1e-9);
  const widths = current.filter((w) => !targets.includes(pieceOf(w.at)));
  if (!already) widths.push(...targets.map((i) => ({ at: pieces[i].mid, width })));
  updateObject(artId, { widths: widths.length ? widths : undefined } as Partial<Artwork>);
  autoRecalculate();
}

export function restoreWidths() {
  const ids = new Set(regionTargets().map((a) => a.id));
  setObjects(state.objects.map((o) => (o.type === "art" && ids.has(o.id) ? { ...o, widths: undefined } : o)));
  autoRecalculate();
}

/**
 * Takes out the nail at a world point, or puts back a removed one there. Removed
 * nails are kept by position on the artwork, so they survive recalculating.
 */
export function toggleNail(artId: string, x: number, y: number) {
  const a = state.objects.find((o): o is Artwork => o.id === artId && o.type === "art");
  if (!a) return;
  const list = a.removedNails ?? [];
  const within = state.settings.spacing * 0.45;
  const i = list.findIndex(([lx, ly]) => {
    const [wx, wy] = artToWorld(a, lx, ly);
    return Math.hypot(wx - x, wy - y) < within;
  });
  const removedNails = i >= 0 ? list.filter((_, k) => k !== i) : [...list, worldToArt(a, x, y)];
  updateObject(artId, { removedNails: removedNails.length ? removedNails : undefined } as Partial<Artwork>);
  autoRecalculate();
}

export function restoreNails() {
  const ids = new Set(regionTargets().map((a) => a.id));
  setObjects(state.objects.map((o) => (o.type === "art" && ids.has(o.id) ? { ...o, removedNails: undefined } : o)));
  autoRecalculate();
}

export function restoreLines() {
  const ids = new Set(regionTargets().map((a) => a.id));
  setObjects(state.objects.map((o) => (o.type === "art" && ids.has(o.id) ? { ...o, cuts: undefined } : o)));
  autoRecalculate();
}

/** Artwork the region buttons act on: the selected artwork, or all of it. */
function regionTargets(): Artwork[] {
  const arts = state.objects.filter((o): o is Artwork => o.type === "art");
  const sel = arts.filter((a) => state.selection.includes(a.id));
  return sel.length ? sel : arts;
}

/** Fills or clears every region, or with `null` goes back to the defaults. */
export function setAllRegions(value: boolean | null) {
  const ids = new Set(regionTargets().map((a) => a.id));
  setObjects(
    state.objects.map((o) => {
      if (o.type !== "art" || !ids.has(o.id)) return o;
      const fills = value === null ? undefined : arrangement(o).regions.map((r) => ({ at: r.sample, on: value }));
      return { ...o, fills };
    }),
  );
  autoRecalculate();
}

// Region fills, removed lines and nails, and painted widths are saved as positions,
// so they carry over when the gap, widths or layers change.
export function setArtGap(id: string, gap: number) {
  updateObject(id, { gap } as Partial<Artwork>);
}

export function setArtLineWidth(id: string, lineWidth: number) {
  updateObject(id, { lineWidth } as Partial<Artwork>);
}

export function setArtLineWeights(id: string, lineWeights: boolean) {
  updateObject(id, { lineWeights } as Partial<Artwork>);
}

/** Includes/leaves out a layer or sets its line width (`lineWidth: undefined` goes back to the artwork's). */
export function setArtLayer(id: string, layer: string, patch: LayerSettings) {
  const a = state.objects.find((o): o is Artwork => o.id === id && o.type === "art");
  if (!a) return;
  const next = { ...a.layers?.[layer], ...patch };
  if (next.include !== false) delete next.include;
  if (next.lineWidth === undefined) delete next.lineWidth;
  if (next.shading === undefined) delete next.shading;
  const layers = { ...a.layers, [layer]: next };
  if (!Object.keys(next).length) delete layers[layer];
  updateObject(id, { layers: Object.keys(layers).length ? layers : undefined } as Partial<Artwork>);
}

// ---------------------------------------------------------------------------
// Pattern

/** Recent results by input, so undo/redo back to a calculated state is instant. */
const patternCache = new Map<string, Pattern>();
const PATTERN_CACHE_SIZE = 20;

export function calculatePattern() {
  const key = patternKey(state.objects, state.settings);
  let pattern = patternCache.get(key);
  if (pattern) patternCache.delete(key);
  else pattern = computePattern(state.objects, state.settings);
  patternCache.set(key, pattern);
  if (patternCache.size > PATTERN_CACHE_SIZE) patternCache.delete(patternCache.keys().next().value!);
  setState({ pattern });
}

let recalcTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Brings an existing pattern up to date shortly after region, line and nail
 * edits and undo/redo. Moves and setting changes still wait for Recalculate.
 */
function autoRecalculate() {
  if (!state.pattern) return;
  if (recalcTimer) clearTimeout(recalcTimer);
  recalcTimer = setTimeout(() => {
    recalcTimer = null;
    if (state.pattern && state.pattern.key !== patternKey(state.objects, state.settings)) calculatePattern();
  }, 120);
}

export function notify(text: string, kind: "info" | "error" = "info") {
  setState({ notice: { text, kind } });
}
