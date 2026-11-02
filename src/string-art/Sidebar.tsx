"use client";

import { useMemo, useState } from "react";
import { edgeToEdge, normalizeDegrees, regularRadius, regularSize } from "./geometry";
import { exportDXF, exportGcode, exportPDF } from "./io";
import { patternKey, patternStats } from "./pattern";
import { artGap, artLineWidth, layerIncluded, openLineCount } from "./outline";
import { arrangement, isFilled } from "./regions";
import { groupBounds } from "./render";
import {
  align,
  type AlignMode,
  calculatePattern,
  centerSelectionOnCanvas,
  distribute,
  getState,
  reshapeRef,
  rotateSelection,
  select,
  restoreLines,
  restoreNails,
  restoreWidths,
  setAllRegions,
  setArtGap,
  setArtLayer,
  setArtLineWeights,
  setArtLineWidth,
  setSelectionBounds,
  setState,
  updateObject,
  useEditor,
} from "./store";
import { PAPERS, planTiles, printBounds } from "./tiles";
import type { Artwork, Bounds, GcodeSettings, Obj, PaperId, PatternSettings, PrintSettings, Pt, RefShape, Units } from "./types";
import { AlignIcon, Btn, Check, Field, LengthInput, NumberInput, Row, Section, Segmented, Select } from "./ui";
import { formatLength, formatLongLength, MM_PER_IN, unitLabel } from "./units";
import { fit } from "./view";

type Tab = "design" | "nails" | "export";

export default function Sidebar() {
  const [tab, setTab] = useState<Tab>("design");
  return (
    <aside className="flex w-80 shrink-0 flex-col border-l border-neutral-800 bg-neutral-950">
      <nav className="flex border-b border-neutral-800">
        {(
          [
            ["design", "Design"],
            ["nails", "Nails"],
            ["export", "Print & CNC"],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => setTab(id)}
            className={`flex-1 py-2.5 text-sm ${tab === id ? "border-b-2 border-amber-500 text-neutral-100" : "border-b-2 border-transparent text-neutral-500 hover:text-neutral-300"}`}
          >
            {label}
          </button>
        ))}
      </nav>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {tab === "design" && <DesignPanel />}
        {tab === "nails" && <NailsPanel />}
        {tab === "export" && <ExportPanel />}
      </div>
    </aside>
  );
}

// ---------------------------------------------------------------------------
// Design

function DesignPanel() {
  const units = useEditor((s) => s.units);
  const objects = useEditor((s) => s.objects);
  const selection = useEditor((s) => s.selection);
  const sel = useMemo(() => objects.filter((o) => selection.includes(o.id)), [objects, selection]);
  const [toCanvas, setToCanvas] = useState(false);

  return (
    <>
      {sel.length === 0 && (
        <Section title="Selection">
          <p className="text-sm text-neutral-500">
            Nothing selected. Add a reference shape or import artwork from the toolbar, or drop an SVG/DXF file on the canvas.
          </p>
        </Section>
      )}
      {sel.length === 1 && <ObjectProps key={sel[0].id} o={sel[0]} units={units} />}
      {sel.length > 1 && <GroupProps objs={sel} units={units} />}

      {sel.length > 0 && (
        <Section
          title="Align"
          right={
            sel.length > 1 ? (
              <Segmented
                value={toCanvas ? "canvas" : "selection"}
                options={[
                  { value: "selection", label: "To each other" },
                  { value: "canvas", label: "To canvas" },
                ]}
                onChange={(v) => setToCanvas(v === "canvas")}
              />
            ) : (
              <span className="text-[11px] text-neutral-500">to canvas axes</span>
            )
          }
        >
          <div className="flex flex-wrap gap-1">
            {(["left", "hcenter", "right", "top", "vcenter", "bottom"] as AlignMode[]).map((m) => (
              <Btn key={m} title={`Align ${m.replace("hcenter", "horizontal centres").replace("vcenter", "vertical centres")}`} onClick={() => align(m, toCanvas)}>
                <AlignIcon mode={m} />
              </Btn>
            ))}
          </div>
          <div className="flex flex-wrap gap-1">
            <Btn title="Centre the selection on the canvas origin" onClick={centerSelectionOnCanvas}>
              <AlignIcon mode="center" /> Centre on canvas
            </Btn>
            <Btn title="Distribute horizontally (3+ objects)" onClick={() => distribute("x")} disabled={sel.length < 3}>
              <AlignIcon mode="dist-x" />
            </Btn>
            <Btn title="Distribute vertically (3+ objects)" onClick={() => distribute("y")} disabled={sel.length < 3}>
              <AlignIcon mode="dist-y" />
            </Btn>
          </div>
        </Section>
      )}

      <Section title={`Objects (${objects.length})`}>
        {objects.length === 0 && <p className="text-sm text-neutral-500">No objects yet.</p>}
        <ul className="-mx-2">
          {[...objects].reverse().map((o) => (
            <li key={o.id}>
              <button
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={(e) =>
                  select(
                    e.shiftKey
                      ? selection.includes(o.id)
                        ? selection.filter((id) => id !== o.id)
                        : [...selection, o.id]
                      : [o.id],
                  )
                }
                className={`flex w-full items-center gap-2 rounded px-2 py-1 text-left text-sm ${selection.includes(o.id) ? "bg-amber-500/15 text-amber-200" : "text-neutral-300 hover:bg-neutral-800"}`}
              >
                <span className={`h-2 w-2 shrink-0 rounded-full ${o.type === "art" ? "bg-neutral-300" : "bg-sky-400"}`} />
                <span className="min-w-0 flex-1 truncate">{o.name}</span>
                <span className="shrink-0 font-mono text-[11px] text-neutral-500">
                  {formatLength(o.w, units, 1)}×{formatLength(o.h, units, 1)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </Section>
    </>
  );
}

function SizeFields({
  x,
  y,
  w,
  h,
  units,
  onChange,
}: {
  x: number;
  y: number;
  w: number;
  h: number;
  units: Units;
  onChange: (b: { x: number; y: number; w: number; h: number }) => void;
}) {
  const [lock, setLock] = useState(true);
  const u = unitLabel(units);
  return (
    <>
      <Row>
        <Field label={`X centre (${u})`}>
          <LengthInput value={x} units={units} onCommit={(v) => onChange({ x: v, y, w, h })} />
        </Field>
        <Field label={`Y centre (${u})`}>
          <LengthInput value={y} units={units} onCommit={(v) => onChange({ x, y: v, w, h })} />
        </Field>
      </Row>
      <Row>
        <Field label={`Width (${u})`}>
          <LengthInput value={w} units={units} min={0.1} onCommit={(v) => onChange({ x, y, w: v, h: lock ? (h * v) / w : h })} />
        </Field>
        <Field label={`Height (${u})`}>
          <LengthInput value={h} units={units} min={0.1} onCommit={(v) => onChange({ x, y, w: lock ? (w * v) / h : w, h: v })} />
        </Field>
      </Row>
      <Check label="Keep proportions" checked={lock} onChange={setLock} />
    </>
  );
}

function ObjectProps({ o, units }: { o: Obj; units: Units }) {
  return (
    <Section title={o.type === "art" ? "Artwork" : "Reference shape"}>
      <Field label="Name">
        <input
          className="w-full rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-sm outline-none focus:border-amber-500"
          defaultValue={o.name}
          onBlur={(e) => e.target.value.trim() && e.target.value !== o.name && updateObject(o.id, { name: e.target.value.trim() })}
          onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
        />
      </Field>
      <SizeFields x={o.x} y={o.y} w={o.w} h={o.h} units={units} onChange={(b) => updateObject(o.id, b)} />
      <Field label="Rotation (° counter-clockwise)">
        <div className="flex gap-1">
          <NumberInput value={o.rotation} onCommit={(v) => updateObject(o.id, { rotation: normalizeDegrees(v) })} />
          <QuarterTurns />
        </div>
      </Field>
      {o.rotation !== 0 && <p className="text-[11px] text-neutral-500">Width and height are measured before rotation.</p>}
      {o.type === "ref" ? <RefProps o={o} units={units} /> : <ArtProps o={o} units={units} />}
    </Section>
  );
}

function QuarterTurns() {
  return (
    <>
      <Btn title="Rotate 90° counter-clockwise (R rotates 15°)" onClick={() => rotateSelection(90)}>
        ↺ 90°
      </Btn>
      <Btn title="Rotate 90° clockwise (Shift+R rotates −15°)" onClick={() => rotateSelection(-90)}>
        ↻ 90°
      </Btn>
    </>
  );
}

function RefProps({ o, units }: { o: RefShape; units: Units }) {
  const r = regularRadius(o);
  const u = unitLabel(units);
  const set = (patch: Partial<RefShape>) => updateObject(o.id, reshapeRef(o, patch));
  const diagonal = Math.hypot(o.w, o.h);
  return (
    <>
      <Row>
        <Field label="Shape">
          <Select
            value={o.kind}
            options={[
              { value: "polygon", label: "Polygon" },
              { value: "ellipse", label: "Circle / ellipse" },
            ]}
            onChange={(kind) => set({ kind, sides: o.sides >= 3 ? o.sides : 6 })}
          />
        </Field>
        {o.kind === "polygon" && (
          <Field label="Sides">
            <NumberInput value={o.sides} min={3} max={64} digits={0} onCommit={(v) => set({ sides: Math.round(v) })} />
          </Field>
        )}
      </Row>
      {o.kind === "ellipse" ? (
        <Field label={`Diameter (${u})`}>
          <LengthInput
            value={r === null ? null : 2 * r}
            placeholder="stretched: type to make round"
            units={units}
            min={0.1}
            onCommit={(d) => updateObject(o.id, { w: d, h: d })}
          />
        </Field>
      ) : (
        <Row>
          <Field label={`Corner to corner (${u})`}>
            <LengthInput
              value={r !== null ? 2 * r : o.sides === 4 ? diagonal : null}
              placeholder="stretched"
              units={units}
              min={0.1}
              onCommit={(v) =>
                updateObject(
                  o.id,
                  r === null && o.sides === 4 ? { w: (o.w * v) / diagonal, h: (o.h * v) / diagonal } : regularSize(o, v / 2),
                )
              }
            />
          </Field>
          <Field label={`Edge to edge (${u})`}>
            <LengthInput
              value={r !== null ? edgeToEdge(o.sides, r) : null}
              placeholder="stretched"
              units={units}
              min={0.1}
              onCommit={(v) => updateObject(o.id, regularSize(o, v / (2 * Math.cos(Math.PI / o.sides))))}
            />
          </Field>
        </Row>
      )}
      {o.kind === "polygon" && o.sides % 2 === 1 && (
        <p className="text-[11px] text-neutral-500">With an odd number of sides, edge to edge is the inscribed circle&apos;s diameter.</p>
      )}
    </>
  );
}

function ArtProps({ o, units }: { o: Artwork; units: Units }) {
  const scale = (o.w / o.w0) * 100;
  const k = o.w / o.w0;
  const lines = openLineCount(o);
  const u = unitLabel(units);
  const weights = [...new Set(o.contours.filter((c) => !c.closed && c.weight).map((c) => c.weight!))].sort((a, b) => b - a);
  return (
    <>
      {lines > 0 && (
        <>
          <p className="pt-1 text-xs text-neutral-400">
            {lines} single line{lines === 1 ? "" : "s"} (paths without area)
          </p>
          <Row>
            <Field label={`Line width (${u})`}>
              <LengthInput value={artLineWidth(o) * k} units={units} min={0} onCommit={(v) => setArtLineWidth(o.id, v / k)} />
            </Field>
            <Field label={`Close gaps up to (${u})`}>
              <LengthInput value={artGap(o) * k} units={units} min={0} onCommit={(v) => setArtGap(o.id, v / k)} />
            </Field>
          </Row>
          {weights.length > 1 && (
            <Check
              label={`Scale by the file's line weights (${weights.map((w) => `${Math.round((w / weights[0]) * 100)}%`).join(", ")})`}
              checked={!!o.lineWeights}
              onChange={(on) => setArtLineWeights(o.id, on)}
            />
          )}
          <p className="text-[11px] text-neutral-500">
            Line width turns single lines into bands you can fill with string (0 keeps them thin).
            {weights.length > 1 ? " With line weights on, it's the width of the boldest lines and thinner ones get a share of it." : ""} Close
            gaps joins line ends that stop just short of another line. Both scale with the artwork.
          </p>
        </>
      )}
      <LayerList o={o} units={units} />
      <Row>
        <Field label="Scale (%)">
          <NumberInput value={scale} min={0.1} digits={1} onCommit={(p) => updateObject(o.id, { w: (o.w0 * p) / 100, h: (o.h0 * p) / 100 })} />
        </Field>
        <Field label="Original size">
          <Btn className="w-full" title="Reset to the size it was imported at" onClick={() => updateObject(o.id, { w: o.w0, h: o.h0 })}>
            Reset
          </Btn>
        </Field>
      </Row>
      <p className="text-[11px] text-neutral-500">
        Imported at {formatLength(o.w0, units, 2)} × {formatLength(o.h0, units, 2)} {unitLabel(units)} · {o.contours.length} path
        {o.contours.length === 1 ? "" : "s"}
      </p>
    </>
  );
}

/** Per-layer include and line width, for artwork imported with layers. */
function LayerList({ o, units }: { o: Artwork; units: Units }) {
  const stats = new Map<string, { open: number; shapes: number }>();
  for (const c of o.contours) {
    const s = stats.get(c.layer ?? "") ?? { open: 0, shapes: 0 };
    if (c.closed) s.shapes++;
    else s.open++;
    stats.set(c.layer ?? "", s);
  }
  if (stats.size < 2) return null;
  const k = o.w / o.w0;
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  return (
    <div className="space-y-1 pt-1">
      <p className="text-xs text-neutral-400">Layers</p>
      {[...stats].map(([name, s]) => {
        const settings = o.layers?.[name];
        const included = layerIncluded(o, name || undefined);
        return (
          <div key={name} className="flex items-center gap-2">
            <input
              type="checkbox"
              className="accent-amber-500"
              title={included ? "Leave this layer out" : "Use this layer"}
              disabled={!name}
              checked={included}
              onChange={(e) => setArtLayer(o.id, name, { include: e.target.checked })}
            />
            <span className={`min-w-0 flex-1 truncate text-sm ${included ? "text-neutral-200" : "text-neutral-500 line-through"}`}>
              {name || "(no layer)"}
              <span className="ml-1.5 text-[11px] text-neutral-500 no-underline">
                {[s.open && plural(s.open, "line"), s.shapes && plural(s.shapes, "shape")].filter(Boolean).join(", ")}
              </span>
            </span>
            {!!name && s.open > 0 && included && (
              <div className="flex w-24 shrink-0 items-center gap-0.5" title="Line width for this layer (blank uses the artwork's)">
                <LengthInput
                  value={settings?.lineWidth !== undefined ? settings.lineWidth * k : null}
                  placeholder="width"
                  units={units}
                  min={0}
                  onCommit={(v) => setArtLayer(o.id, name, { lineWidth: v / k })}
                />
                {settings?.lineWidth !== undefined && (
                  <button
                    type="button"
                    className="px-0.5 text-neutral-500 hover:text-neutral-200"
                    title="Use the artwork's line width"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => setArtLayer(o.id, name, { lineWidth: undefined })}
                  >
                    ↺
                  </button>
                )}
              </div>
            )}
          </div>
        );
      })}
      <p className="text-[11px] text-neutral-500">
        Untick a layer to leave it out (no nails or regions; it stays as a faint guide). A layer&apos;s width overrides the artwork&apos;s line
        width for its single lines.
      </p>
    </div>
  );
}

function GroupProps({ objs, units }: { objs: Obj[]; units: Units }) {
  const b = groupBounds(objs);
  return (
    <Section title={`${objs.length} objects selected`}>
      <SizeFields
        x={(b.minX + b.maxX) / 2}
        y={(b.minY + b.maxY) / 2}
        w={b.maxX - b.minX}
        h={b.maxY - b.minY}
        units={units}
        onChange={({ x, y, w, h }) => setSelectionBounds({ minX: x - w / 2, maxX: x + w / 2, minY: y - h / 2, maxY: y + h / 2 })}
      />
      <Field label="Rotate as a group">
        <div className="flex gap-1">
          <QuarterTurns />
        </div>
      </Field>
    </Section>
  );
}

// ---------------------------------------------------------------------------
// Nails

function NailsPanel() {
  const units = useEditor((s) => s.units);
  const settings = useEditor((s) => s.settings);
  const pattern = useEditor((s) => s.pattern);
  const objects = useEditor((s) => s.objects);
  const display = useEditor((s) => s.display);
  const [busy, setBusy] = useState(false);
  const stale = useMemo(() => !!pattern && pattern.key !== patternKey(objects, settings), [pattern, objects, settings]);
  const stats = useMemo(() => (pattern ? patternStats(pattern, settings.nailDiameter) : null), [pattern, settings.nailDiameter]);
  const hasArt = objects.some((o) => o.type === "art");
  const u = unitLabel(units);
  const perUnitBase = units === "in" ? MM_PER_IN : 10;

  const pickMode = useEditor((s) => s.pickMode);
  const selection = useEditor((s) => s.selection);
  const regionCount = useMemo(() => {
    let total = 0;
    let filled = 0;
    for (const o of objects) {
      if (o.type !== "art") continue;
      arrangement(o).regions.forEach((_, i) => {
        total++;
        if (isFilled(o, i)) filled++;
      });
    }
    const count = (pick: (a: Artwork) => number) => objects.reduce((n, o) => n + (o.type === "art" ? pick(o) : 0), 0);
    const removed = count((a) => a.cuts?.length ?? 0);
    const removedNails = count((a) => a.removedNails?.length ?? 0);
    const painted = count((a) => a.widths?.length ?? 0);
    return { total, filled, removed, removedNails, painted };
  }, [objects]);
  const artSelected = objects.some((o) => o.type === "art" && selection.includes(o.id));
  const paintWidth = useEditor((s) => s.paintWidth);
  const toggleMode = (mode: NonNullable<typeof pickMode>) => setState({ pickMode: pickMode === mode ? null : mode });
  const set = (patch: Partial<PatternSettings>) => setState((s) => ({ settings: { ...s.settings, ...patch } }));
  const show = (patch: Partial<typeof display>) => setState((s) => ({ display: { ...s.display, ...patch } }));
  const calculate = () => {
    setBusy(true);
    // Let the button repaint before the (synchronous) calculation runs.
    setTimeout(() => {
      calculatePattern();
      setBusy(false);
    }, 30);
  };

  return (
    <>
      <Section title="Nails">
        <Row>
          <Field label={`Spacing (${u})`}>
            <LengthInput value={settings.spacing} units={units} min={0.5} onCommit={(v) => set({ spacing: v })} />
          </Field>
          <Field label={units === "in" ? "Nails per inch" : "Nails per cm"}>
            <NumberInput
              value={perUnitBase / settings.spacing}
              min={0.02}
              max={20}
              step={0.25}
              digits={3}
              onCommit={(v) => set({ spacing: perUnitBase / v })}
            />
          </Field>
        </Row>
        <Row>
          <Field label={`Nail diameter (${u})`}>
            <LengthInput value={settings.nailDiameter} units={units} min={0.1} onCommit={(v) => set({ nailDiameter: v })} />
          </Field>
          <Field label="Corner angle (°)">
            <NumberInput value={settings.cornerAngle} min={5} max={170} digits={0} onCommit={(v) => set({ cornerAngle: v })} />
          </Field>
        </Row>
        <p className="text-[11px] text-neutral-500">Any turn sharper than the corner angle gets a nail right on the corner.</p>
        <Row>
          <Field label="Min nails per shape">
            <NumberInput value={settings.minNails} min={0} max={100} digits={0} onCommit={(v) => set({ minNails: Math.round(v) })} />
          </Field>
        </Row>
        <p className="text-[11px] text-neutral-500">
          Small filled shapes get closer nails, down to 3× the nail diameter, so they can take as much shading as big ones. 0 turns this off.
        </p>
      </Section>

      {hasArt && (
        <Section title="Regions & lines">
          <p className="text-sm text-neutral-300">
            {regionCount.filled} of {regionCount.total} region{regionCount.total === 1 ? "" : "s"} filled with string
          </p>
          <div className="grid grid-cols-2 gap-1">
            <Btn variant={pickMode === "regions" ? "primary" : "default"} onClick={() => toggleMode("regions")}>
              {pickMode === "regions" ? "Done" : "Pick regions"}
            </Btn>
            <Btn
              variant={pickMode === "widths" ? "primary" : "default"}
              title="Click pieces of single line to give them their own width"
              onClick={() => toggleMode("widths")}
            >
              {pickMode === "widths" ? "Done" : "Line widths"}
            </Btn>
            <Btn
              variant={pickMode === "lines" ? "primary" : "default"}
              title="Click a line to drop its nails and join the regions on either side"
              onClick={() => toggleMode("lines")}
            >
              {pickMode === "lines" ? "Done" : "Remove lines"}
            </Btn>
            <Btn
              variant={pickMode === "nails" ? "primary" : "default"}
              title="Click nails from the last calculation to take them out"
              disabled={!pattern?.nails.length}
              onClick={() => toggleMode("nails")}
            >
              {pickMode === "nails" ? "Done" : "Remove nails"}
            </Btn>
          </div>
          {pickMode === "widths" && (
            <div className="space-y-1 rounded border border-amber-500/40 bg-amber-500/5 p-2">
              <Field label={`Width to give (${u}) · 0 = thin line`}>
                <LengthInput value={paintWidth} units={units} min={0} onCommit={(v) => setState({ paintWidth: v })} />
              </Field>
              <p className="text-[11px] text-neutral-400">
                Click a piece of line to give it this width; click it again to go back to its layer&apos;s width. Shift-click takes the whole
                drawn line.
              </p>
            </div>
          )}
          <div className="grid grid-cols-3 gap-1">
            <Btn onClick={() => setAllRegions(true)}>Fill all</Btn>
            <Btn onClick={() => setAllRegions(false)}>Clear all</Btn>
            <Btn title="Back to the default: areas inside closed outlines" onClick={() => setAllRegions(null)}>
              Reset
            </Btn>
          </div>
          {regionCount.removed > 0 && (
            <div className="flex items-center justify-between text-xs text-neutral-400">
              <span>
                {regionCount.removed} line{regionCount.removed === 1 ? "" : "s"} removed (dashed red)
              </span>
              <Btn onClick={restoreLines}>Restore</Btn>
            </div>
          )}
          {regionCount.painted > 0 && (
            <div className="flex items-center justify-between text-xs text-neutral-400">
              <span>
                {regionCount.painted} piece{regionCount.painted === 1 ? "" : "s"} with their own width
              </span>
              <Btn onClick={restoreWidths}>Restore</Btn>
            </div>
          )}
          {regionCount.removedNails > 0 && (
            <div className="flex items-center justify-between text-xs text-neutral-400">
              <span>
                {regionCount.removedNails} nail{regionCount.removedNails === 1 ? "" : "s"} removed (crossed out)
              </span>
              <Btn onClick={restoreNails}>Restore</Btn>
            </div>
          )}
          <p className="text-[11px] text-neutral-500">
            Regions are the areas enclosed by your lines. Each filled region gets its own string. Removing a line drops its nails and joins
            the regions on either side.
            {artSelected ? " Buttons apply to the selected artwork." : ""}
          </p>
        </Section>
      )}

      <Section title="String fill">
        <Row>
          <Field label="Shading">
            <NumberInput value={settings.shading} min={0.5} max={20} step={0.5} digits={1} onCommit={(v) => set({ shading: v })} />
          </Field>
          <Field label="Variation">
            <div className="flex gap-1">
              <NumberInput value={settings.seed} min={1} digits={0} onCommit={(v) => set({ seed: Math.round(v) })} />
              <Btn title="Try a different random layout" onClick={() => set({ seed: 1 + Math.floor(Math.random() * 9999) })}>
                ↻
              </Btn>
            </div>
          </Field>
        </Row>
        <Check label="Outline (nail to neighbouring nail)" checked={settings.outline} onChange={(outline) => set({ outline })} />
        <Check label="Edge pass (every nail to the one two along)" checked={settings.edgePass} onChange={(edgePass) => set({ edgePass })} />
        <p className="text-[11px] text-neutral-500">
          Shading sets how much string goes into each shape for its area, so big and small shapes come out equally dark. The outline and
          edge pass go around each shape first to crisp up its edge and fill curves and corners; they count towards the shading.
        </p>
        <Btn variant="primary" className="w-full" onClick={calculate} disabled={busy || !hasArt}>
          {busy ? "Calculating…" : pattern ? "Recalculate pattern" : "Calculate pattern"}
        </Btn>
        {!hasArt && <p className="text-xs text-neutral-500">Import artwork to calculate a pattern.</p>}
        {stale && <p className="text-xs text-amber-300">The artwork or settings changed after the last calculation.</p>}
      </Section>

      {pattern && stats && (
        <Section title="Result">
          <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-sm">
            <dt className="text-neutral-500">Shapes</dt>
            <dd className="text-right font-mono">{stats.shapes}</dd>
            <dt className="text-neutral-500">Nails</dt>
            <dd className="text-right font-mono">{stats.nails}</dd>
            <dt className="text-neutral-500">String lines</dt>
            <dd className="text-right font-mono">{stats.lines}</dd>
            <dt className="text-neutral-500">String needed</dt>
            <dd className="text-right font-mono">≈ {formatLongLength(stats.estimate, units)}</dd>
          </dl>
          {pattern.warnings.map((w) => (
            <p key={w} className="text-xs text-amber-300/90">
              {w}
            </p>
          ))}
          {!!pattern.issues?.small.length && (
            <IssueNote
              text={`${pattern.issues.small.length} region${pattern.issues.small.length === 1 ? " is" : "s are"} too small for nails and won't be filled.`}
              hint="Shown in red. Enlarge the artwork, use closer nail spacing, or clear the region with Pick regions."
              spots={pattern.issues.small.map((rings) => boundsOf(rings.flat()))}
              spacing={settings.spacing}
            />
          )}
          {!!pattern.issues?.light?.length && (
            <IssueNote
              tone="yellow"
              text={`${pattern.issues.light.length} shape${pattern.issues.light.length === 1 ? " is" : "s are"} lighter than the rest.`}
              hint="Outlined in yellow. They ran out of different nail-to-nail lines; raise Min nails per shape, use closer spacing, or enlarge the artwork."
              spots={pattern.issues.light.map((rings) => boundsOf(rings.flat()))}
              spacing={settings.spacing}
            />
          )}
          {!!pattern.issues?.dropped.length && (
            <IssueNote
              text={`${pattern.issues.dropped.length} nail${pattern.issues.dropped.length === 1 ? " was" : "s were"} dropped for being too close to another.`}
              hint="Marked with a red ✕, usually where lines meet at a shallow angle. There's already a nail right beside each one."
              spots={pattern.issues.dropped.map((p) => boundsOf([p]))}
              spacing={settings.spacing}
            />
          )}
        </Section>
      )}

      <Section title="Show">
        <div className="grid grid-cols-2 gap-1.5">
          <Check label="Artwork" checked={display.art} onChange={(art) => show({ art })} />
          <Check label="Ref. shapes" checked={display.refs} onChange={(refs) => show({ refs })} />
          <Check label="Nails" checked={display.nails} onChange={(nails) => show({ nails })} />
          <Check label="Strings" checked={display.strings} onChange={(strings) => show({ strings })} />
          <Check label="Nail labels" checked={display.labels} onChange={(labels) => show({ labels })} />
          <label className="flex items-center gap-2 text-sm text-neutral-300">
            <input type="color" className="h-5 w-7 cursor-pointer rounded border-0 bg-transparent" value={display.stringColor} onChange={(e) => show({ stringColor: e.target.value })} />
            String colour
          </label>
        </div>
        <p className="text-[11px] text-neutral-500">Nail labels appear when you zoom in.</p>
      </Section>
    </>
  );
}

function boundsOf(pts: Pt[]): Bounds {
  return {
    minX: Math.min(...pts.map((p) => p[0])),
    minY: Math.min(...pts.map((p) => p[1])),
    maxX: Math.max(...pts.map((p) => p[0])),
    maxY: Math.max(...pts.map((p) => p[1])),
  };
}

/** A problem from the last calculation, with a button that steps the view through each spot. */
function IssueNote({
  text,
  hint,
  spots,
  spacing,
  tone = "red",
}: {
  text: string;
  hint: string;
  spots: Bounds[];
  spacing: number;
  tone?: "red" | "yellow";
}) {
  const [next, setNext] = useState(0);
  const i = next % spots.length;
  const show = () => {
    const b = spots[i];
    // Leave some context around tiny spots rather than zooming all the way in.
    const half = spacing * 6;
    const cx = (b.minX + b.maxX) / 2;
    const cy = (b.minY + b.maxY) / 2;
    const hw = Math.max((b.maxX - b.minX) / 2, half);
    const hh = Math.max((b.maxY - b.minY) / 2, half);
    fit({ minX: cx - hw, maxX: cx + hw, minY: cy - hh, maxY: cy + hh });
    setNext(i + 1);
  };
  return (
    <div className="flex items-start gap-2">
      <span className={`mt-1 h-2 w-2 shrink-0 rounded-full ${tone === "red" ? "bg-red-500" : "bg-yellow-400"}`} />
      <div className="min-w-0 flex-1">
        <p className={`text-xs ${tone === "red" ? "text-red-300" : "text-yellow-200"}`}>{text}</p>
        <p className="text-[11px] text-neutral-500">{hint}</p>
      </div>
      <Btn className="shrink-0" title="Zoom to it on the canvas" onClick={show}>
        {spots.length > 1 ? `Show ${i + 1}/${spots.length}` : "Show"}
      </Btn>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Print & CNC

function ExportPanel() {
  const units = useEditor((s) => s.units);
  const print = useEditor((s) => s.print);
  const gcode = useEditor((s) => s.gcode);
  const pattern = useEditor((s) => s.pattern);
  const objects = useEditor((s) => s.objects);
  const plan = useMemo(() => {
    const content = printBounds(getState());
    return content ? planTiles(content, print) : null;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- printBounds reads these from the store
  }, [pattern, objects, print]);
  const u = unitLabel(units);
  const gu = unitLabel(gcode.units);
  const setPrint = (patch: Partial<PrintSettings>) => setState((s) => ({ print: { ...s.print, ...patch } }));
  const setG = (patch: Partial<GcodeSettings>) => setState((s) => ({ gcode: { ...s.gcode, ...patch } }));
  const noPattern = !pattern?.nails.length;

  return (
    <>
      <Section title="Print template (PDF)">
        <Row>
          <Field label="Paper">
            <Select
              value={print.paper}
              options={(Object.keys(PAPERS) as PaperId[]).map((id) => ({ value: id, label: PAPERS[id].label }))}
              onChange={(paper) => setPrint({ paper })}
            />
          </Field>
          <Field label="Orientation">
            <Select
              value={print.orientation}
              options={[
                { value: "auto", label: "Fewest pages" },
                { value: "portrait", label: "Portrait" },
                { value: "landscape", label: "Landscape" },
              ]}
              onChange={(orientation) => setPrint({ orientation })}
            />
          </Field>
        </Row>
        <Row>
          <Field label={`Printer margin (${u})`}>
            <LengthInput value={print.margin} units={units} min={0} onCommit={(margin) => setPrint({ margin })} />
          </Field>
          <Field label={`Page overlap (${u})`}>
            <LengthInput value={print.overlap} units={units} min={0} onCommit={(overlap) => setPrint({ overlap })} />
          </Field>
        </Row>
        <div className="grid grid-cols-2 gap-1.5">
          <Check label="Artwork outline" checked={print.outline} onChange={(outline) => setPrint({ outline })} />
          <Check label="Ref. shapes" checked={print.refs} onChange={(refs) => setPrint({ refs })} />
          <Check label="Nail labels" checked={print.labels} onChange={(labels) => setPrint({ labels })} />
          <Check label="String lines" checked={print.strings} onChange={(strings) => setPrint({ strings })} />
          <Check label="Grid" checked={print.grid} onChange={(grid) => setPrint({ grid })} />
          <Check label="Stringing order" checked={print.sequence} onChange={(sequence) => setPrint({ sequence })} />
        </div>
        {plan && (
          <p className="text-xs text-neutral-400">
            {plan.rows * plan.cols} template page{plan.rows * plan.cols === 1 ? "" : "s"} ({plan.rows} × {plan.cols},{" "}
            {plan.pw > plan.ph ? "landscape" : "portrait"}) plus a cover page{print.sequence ? " and the stringing order" : ""}.
          </p>
        )}
        <Btn variant="primary" className="w-full" onClick={() => void exportPDF()} disabled={noPattern}>
          Download PDF
        </Btn>
        {noPattern && <p className="text-xs text-neutral-500">Calculate a nail pattern first.</p>}
      </Section>

      <Section title="CNC (G-code / DXF)">
        <Row>
          <Field label="Mode">
            <Select
              value={gcode.mode}
              options={[
                { value: "plunge", label: "Drill / pen" },
                { value: "laser", label: "Laser dot" },
              ]}
              onChange={(mode) => setG({ mode })}
            />
          </Field>
          <Field label="Work origin">
            <Select
              value={gcode.origin}
              options={[
                { value: "center", label: "Canvas centre" },
                { value: "bottom-left", label: "Bottom left" },
                { value: "top-left", label: "Top left" },
              ]}
              onChange={(origin) => setG({ origin })}
            />
          </Field>
        </Row>
        <Field label="Output units">
          <Segmented
            value={gcode.units}
            options={[
              { value: "mm", label: "mm (G21)" },
              { value: "in", label: "in (G20)" },
            ]}
            onChange={(units) => setG({ units })}
          />
        </Field>
        {gcode.mode === "plunge" ? (
          <>
            <Row>
              <Field label={`Safe Z (${gu})`}>
                <LengthInput value={gcode.safeZ} units={gcode.units} onCommit={(safeZ) => setG({ safeZ })} />
              </Field>
              <Field label={`Plunge depth Z (${gu})`}>
                <LengthInput value={gcode.depth} units={gcode.units} onCommit={(depth) => setG({ depth })} />
              </Field>
            </Row>
            <Row>
              <Field label={`Plunge feed (${gu}/min)`}>
                <LengthInput value={gcode.plungeFeed} units={gcode.units} min={0.1} onCommit={(plungeFeed) => setG({ plungeFeed })} />
              </Field>
              <Field label="Dwell at depth (s)">
                <NumberInput value={gcode.dwell} min={0} step={0.1} onCommit={(dwell) => setG({ dwell })} />
              </Field>
            </Row>
            <Field label="Spindle RPM (0 = don't start it)">
              <NumberInput value={gcode.spindle} min={0} step={500} digits={0} onCommit={(spindle) => setG({ spindle })} />
            </Field>
          </>
        ) : (
          <Row>
            <Field label="Laser power (S)">
              <NumberInput value={gcode.laserPower} min={0} step={50} digits={0} onCommit={(laserPower) => setG({ laserPower })} />
            </Field>
            <Field label="Dot time (s)">
              <NumberInput value={gcode.laserDwell} min={0.01} step={0.05} digits={3} onCommit={(laserDwell) => setG({ laserDwell })} />
            </Field>
          </Row>
        )}
        <p className="text-[11px] text-neutral-500">
          GRBL-style G-code, nails visited in nearest-neighbour order. Dry-run above the work first.
        </p>
        <div className="grid grid-cols-2 gap-2">
          <Btn onClick={exportGcode} disabled={noPattern}>
            G-code (.nc)
          </Btn>
          <Btn onClick={exportDXF} disabled={noPattern}>
            DXF of nails
          </Btn>
        </div>
      </Section>
    </>
  );
}
