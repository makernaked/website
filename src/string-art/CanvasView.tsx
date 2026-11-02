"use client";

import { useEffect, useRef, useState } from "react";
import { artToWorld, distToSegment, normalizeDegrees, objBounds, pointInPolygon, rotateObj, toLocal, unionBounds, worldContours } from "./geometry";
import { importFiles } from "./io";
import { patternKey } from "./pattern";
import { chainLines, thinGraph } from "./outline";
import { regionAt, worldChainAt, worldChains, worldThinChains } from "./regions";
import {
  drawScene,
  groupBounds,
  HANDLE,
  HANDLE_DIRS,
  handlePositions,
  type Overlay,
  ROTATE_R,
  rotateHandlePosition,
  RULER,
  screenToWorld,
  tickScale,
  type View,
} from "./render";
import {
  checkpoint,
  copySelection,
  cutSelection,
  deleteSelection,
  duplicateSelection,
  getState,
  mapObjects,
  moveSelection,
  paste,
  redo,
  rotateSelection,
  select,
  selectAll,
  selectedObjects,
  setObjects,
  setState,
  subscribe,
  paintLineWidth,
  toggleLine,
  toggleNail,
  toggleRegion,
  undo,
  useEditor,
} from "./store";
import type { Artwork, Bounds, Obj } from "./types";
import { formatLength, MM_PER_IN } from "./units";
import { fit, getView, home, setCanvasSize, setView, subscribeView, zoomAt } from "./view";

type Drag =
  | { kind: "pan"; sx: number; sy: number; view: View }
  | { kind: "move"; sx: number; sy: number; wx: number; wy: number; objs: Obj[]; bounds: Bounds; moved: boolean }
  | { kind: "resize"; dir: [number, number]; objs: Obj[]; bounds: Bounds; moved: boolean }
  | { kind: "rotate"; cx: number; cy: number; start: number; objs: Obj[]; moved: boolean }
  | { kind: "marquee"; wx: number; wy: number; base: string[] };

const HANDLE_CURSORS = ["nwse-resize", "ns-resize", "nesw-resize", "ew-resize", "nwse-resize", "ns-resize", "nesw-resize", "ew-resize"];

function isTyping(t: EventTarget | null) {
  const el = t as HTMLElement | null;
  return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable);
}

/** Replaces objects by id without recording an undo step (used mid-drag). */
function replaceObjects(updated: Obj[]) {
  const map = new Map(updated.map((o) => [o.id, o]));
  setObjects(
    getState().objects.map((o) => map.get(o.id) ?? o),
    false,
  );
}

export default function CanvasView() {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const statusRef = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  const overlay = useRef<Overlay>({ marquee: null, cursor: null, patternStale: false, angle: null, hoverRegion: null, hoverLine: null, hoverNail: null, hoverPiece: null });
  const space = useRef(false);
  const size = useRef({ w: 0, h: 0 });
  const frame = useRef(0);
  const [dropping, setDropping] = useState(false);
  const pickMode = useEditor((s) => s.pickMode);

  useEffect(() => {
    const canvas = canvasRef.current!;
    const wrap = wrapRef.current!;
    const ctx = canvas.getContext("2d")!;

    const draw = () => {
      frame.current = 0;
      const { w, h } = size.current;
      if (!w || !h) return;
      const s = getState();
      overlay.current.patternStale = !!s.pattern && s.pattern.key !== patternKey(s.objects, s.settings);
      if (s.pickMode !== "regions") overlay.current.hoverRegion = null;
      if (s.pickMode !== "lines") overlay.current.hoverLine = null;
      if (s.pickMode !== "widths") overlay.current.hoverPiece = null;
      if (s.pickMode !== "nails") overlay.current.hoverNail = null;
      const dpr = window.devicePixelRatio || 1;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      drawScene(ctx, s, getView(), w, h, overlay.current);
      updateStatus();
    };
    const requestDraw = () => {
      if (!frame.current) frame.current = requestAnimationFrame(draw);
    };

    const updateStatus = () => {
      const el = statusRef.current;
      if (!el) return;
      const s = getState();
      const v = getView();
      const c = overlay.current.cursor;
      const zoomPct = Math.round((v.zoom / (96 / MM_PER_IN)) * 100);
      el.textContent = `${c ? `X ${formatLength(c[0], s.units)}  Y ${formatLength(c[1], s.units)} ${s.units}   ·   ` : ""}${zoomPct}%`;
    };

    const ro = new ResizeObserver(() => {
      const r = wrap.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      size.current = { w: r.width, h: r.height };
      canvas.width = Math.round(r.width * dpr);
      canvas.height = Math.round(r.height * dpr);
      canvas.style.width = `${r.width}px`;
      canvas.style.height = `${r.height}px`;
      setCanvasSize(r.width, r.height);
      draw();
    });
    ro.observe(wrap);
    const unsub = subscribe(requestDraw);
    const unsubView = subscribeView(requestDraw);

    // ---- helpers bound to the current size/view ----
    const local = (e: { clientX: number; clientY: number }): [number, number] => {
      const r = canvas.getBoundingClientRect();
      return [e.clientX - r.left, e.clientY - r.top];
    };
    const toWorld = (sx: number, sy: number) => screenToWorld(getView(), size.current.w, size.current.h, sx, sy);
    const snapStep = () => {
      const s = getState();
      const t = tickScale(s.units, getView().zoom);
      return t.levels[0] * t.unit;
    };
    const snap = (v: number, on: boolean) => {
      if (!on) return v;
      const st = snapStep();
      return Math.round(v / st) * st;
    };

    const hitHandle = (sx: number, sy: number): number => {
      const sel = selectedObjects();
      if (!sel.length) return -1;
      const pos = handlePositions(groupBounds(sel), getView(), size.current.w, size.current.h);
      return pos.findIndex(([hx, hy]) => Math.abs(hx - sx) <= HANDLE / 2 + 3 && Math.abs(hy - sy) <= HANDLE / 2 + 3);
    };

    const hitRotate = (sx: number, sy: number): boolean => {
      const sel = selectedObjects();
      if (!sel.length) return false;
      const [rx, ry] = rotateHandlePosition(groupBounds(sel), getView(), size.current.w, size.current.h);
      return Math.hypot(rx - sx, ry - sy) <= ROTATE_R + 4;
    };

    const hitObject = (sx: number, sy: number): Obj | null => {
      const s = getState();
      const [x, y] = toWorld(sx, sy);
      const tol = 6 / getView().zoom;
      const visible = [
        ...(s.display.art ? s.objects.filter((o) => o.type === "art").reverse() : []),
        ...(s.display.refs ? s.objects.filter((o) => o.type === "ref").reverse() : []),
      ];
      // Outlines first, so a shape's edge wins over the inside of a larger one.
      for (const o of visible) {
        const b = objBounds(o);
        if (x < b.minX - tol || x > b.maxX + tol || y < b.minY - tol || y > b.maxY + tol) continue;
        for (const c of worldContours(o)) {
          const n = c.pts.length;
          for (let i = 0; i < (c.closed ? n : n - 1); i++)
            if (distToSegment([x, y], c.pts[i], c.pts[(i + 1) % n]) <= tol) return o;
        }
      }
      for (const o of visible) {
        const b = objBounds(o);
        if (x < b.minX || x > b.maxX || y < b.minY || y > b.maxY) continue;
        if (o.type === "ref") {
          if (pointInPolygon(x, y, worldContours(o)[0].pts)) return o;
          continue;
        }
        // Artwork is grabbable anywhere inside its (rotated) box.
        const [lx, ly] = toLocal(o, x, y);
        if (Math.abs(lx) <= o.w / 2 && Math.abs(ly) <= o.h / 2) return o;
      }
      return null;
    };

    const regionHit = (sx: number, sy: number) => {
      const s = getState();
      const [x, y] = toWorld(sx, sy);
      for (const o of [...s.objects].reverse()) {
        if (o.type !== "art") continue;
        const b = objBounds(o);
        if (x < b.minX || x > b.maxX || y < b.minY || y > b.maxY) continue;
        const index = regionAt(o, x, y);
        if (index >= 0) return { id: o.id, index };
      }
      return null;
    };

    const lineHit = (sx: number, sy: number) => {
      const s = getState();
      const [x, y] = toWorld(sx, sy);
      const tol = 6 / getView().zoom;
      for (const o of [...s.objects].reverse()) {
        if (o.type !== "art") continue;
        const b = objBounds(o);
        if (x < b.minX - tol || x > b.maxX + tol || y < b.minY - tol || y > b.maxY + tol) continue;
        const index = worldChainAt(worldChains(o), x, y, tol);
        if (index >= 0) return { id: o.id, index };
      }
      return null;
    };

    /** A piece of single line (or the whole drawn line with `whole`) to paint a width onto. */
    const pieceHit = (sx: number, sy: number, whole: boolean) => {
      const s = getState();
      const [x, y] = toWorld(sx, sy);
      const tol = 6 / getView().zoom;
      for (const o of [...s.objects].reverse()) {
        if (o.type !== "art") continue;
        const b = objBounds(o);
        if (x < b.minX - tol || x > b.maxX + tol || y < b.minY - tol || y > b.maxY + tol) continue;
        const index = worldChainAt(worldThinChains(o), x, y, tol);
        if (index < 0) continue;
        const lineOf = chainLines(thinGraph(o));
        const indices = whole ? lineOf.flatMap((l, i) => (l === lineOf[index] ? [i] : [])) : [index];
        return { id: o.id, index, indices };
      }
      return null;
    };

    /** A removed-nail marker (to put back) or a nail from the last calculation (to remove). */
    const nailHit = (sx: number, sy: number) => {
      const s = getState();
      const [x, y] = toWorld(sx, sy);
      const zoom = getView().zoom;
      const within = Math.max(8, (s.settings.nailDiameter / 2) * zoom + 4) / zoom;
      for (const o of s.objects) {
        if (o.type !== "art") continue;
        for (const [lx, ly] of o.removedNails ?? []) {
          const [wx, wy] = artToWorld(o, lx, ly);
          if (Math.hypot(wx - x, wy - y) < within) return { id: o.id, x: wx, y: wy };
        }
      }
      let best: { id: string; x: number; y: number } | null = null;
      let bestD = within;
      for (const n of s.pattern?.nails ?? []) {
        const d = Math.hypot(n.x - x, n.y - y);
        if (d >= bestD) continue;
        // Older patterns don't record the artwork; fall back to whichever contains the nail.
        const id =
          n.art ??
          [...s.objects].reverse().find((o) => {
            const b = objBounds(o);
            return o.type === "art" && n.x >= b.minX && n.x <= b.maxX && n.y >= b.minY && n.y <= b.maxY;
          })?.id;
        if (!id) continue;
        bestD = d;
        best = { id, x: n.x, y: n.y };
      }
      return best;
    };

    const setCursor = (sx: number, sy: number) => {
      if (drag.current) return;
      if (space.current) canvas.style.cursor = "grab";
      else if (getState().pickMode === "regions") canvas.style.cursor = overlay.current.hoverRegion ? "pointer" : "default";
      else if (getState().pickMode === "lines") canvas.style.cursor = overlay.current.hoverLine ? "pointer" : "default";
      else if (getState().pickMode === "nails") canvas.style.cursor = overlay.current.hoverNail ? "pointer" : "default";
      else if (getState().pickMode === "widths") canvas.style.cursor = overlay.current.hoverPiece ? "pointer" : "default";
      else {
        const hi = hitHandle(sx, sy);
        canvas.style.cursor = hitRotate(sx, sy) ? "grab" : hi >= 0 ? HANDLE_CURSORS[hi] : hitObject(sx, sy) ? "move" : "default";
      }
    };

    // ---- pointer ----
    const onDown = (e: PointerEvent) => {
      const [sx, sy] = local(e);
      canvas.setPointerCapture(e.pointerId);
      if (e.button === 1 || (e.button === 0 && space.current)) {
        drag.current = { kind: "pan", sx, sy, view: getView() };
        canvas.style.cursor = "grabbing";
        return;
      }
      if (e.button !== 0 || sx < RULER || sy < RULER) return;
      const mode = getState().pickMode;
      if (mode === "regions") {
        const hit = regionHit(sx, sy);
        if (hit) toggleRegion(hit.id, hit.index);
        return;
      }
      if (mode === "lines") {
        const hit = lineHit(sx, sy);
        if (hit) toggleLine(hit.id, hit.index);
        return;
      }
      if (mode === "nails") {
        const hit = nailHit(sx, sy);
        if (hit) toggleNail(hit.id, hit.x, hit.y);
        return;
      }
      if (mode === "widths") {
        const hit = pieceHit(sx, sy, e.shiftKey);
        const art = hit && getState().objects.find((o): o is Artwork => o.id === hit.id && o.type === "art");
        // The painted width is in world units; artwork stores its own (unscaled) units.
        if (hit && art) paintLineWidth(hit.id, hit.index, getState().paintWidth / (art.w0 > 0 ? art.w / art.w0 : 1), e.shiftKey);
        return;
      }
      const [wx, wy] = toWorld(sx, sy);
      if (hitRotate(sx, sy)) {
        const objs = selectedObjects();
        const b = groupBounds(objs);
        // One object turns about its own centre; a group about the middle of its bounds.
        const [cx, cy] = objs.length === 1 ? [objs[0].x, objs[0].y] : [(b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2];
        drag.current = { kind: "rotate", cx, cy, start: (Math.atan2(wy - cy, wx - cx) * 180) / Math.PI, objs, moved: false };
        canvas.style.cursor = "grabbing";
        return;
      }
      const hi = hitHandle(sx, sy);
      if (hi >= 0) {
        const objs = selectedObjects();
        drag.current = { kind: "resize", dir: HANDLE_DIRS[hi], objs, bounds: groupBounds(objs), moved: false };
        return;
      }
      const hit = hitObject(sx, sy);
      const s = getState();
      if (hit) {
        let ids = s.selection;
        if (e.shiftKey) {
          if (ids.includes(hit.id)) {
            select(ids.filter((id) => id !== hit.id));
            return;
          }
          ids = [...ids, hit.id];
        } else if (!ids.includes(hit.id)) ids = [hit.id];
        select(ids);
        const objs = selectedObjects();
        drag.current = { kind: "move", sx, sy, wx, wy, objs, bounds: groupBounds(objs), moved: false };
        return;
      }
      const base = e.shiftKey ? s.selection : [];
      if (!e.shiftKey) select([]);
      drag.current = { kind: "marquee", wx, wy, base };
    };

    const onMove = (e: PointerEvent) => {
      const [sx, sy] = local(e);
      const [wx, wy] = toWorld(sx, sy);
      overlay.current.cursor = [wx, wy];
      const d = drag.current;
      if (!d) {
        const mode = getState().pickMode;
        if (mode === "regions") overlay.current.hoverRegion = regionHit(sx, sy);
        if (mode === "lines") overlay.current.hoverLine = lineHit(sx, sy);
        if (mode === "nails") overlay.current.hoverNail = nailHit(sx, sy);
        if (mode === "widths") overlay.current.hoverPiece = pieceHit(sx, sy, e.shiftKey);
        setCursor(sx, sy);
        requestDraw();
        return;
      }
      const snapOn = getState().display.snap && !e.altKey;
      if (d.kind === "pan") {
        const v = d.view;
        setView({ ...v, cx: v.cx - (sx - d.sx) / v.zoom, cy: v.cy + (sy - d.sy) / v.zoom });
      } else if (d.kind === "move") {
        if (!d.moved && Math.hypot(sx - d.sx, sy - d.sy) < 3) return;
        if (!d.moved) {
          checkpoint();
          d.moved = true;
        }
        const cx = (d.bounds.minX + d.bounds.maxX) / 2;
        const cy = (d.bounds.minY + d.bounds.maxY) / 2;
        let dx = wx - d.wx;
        let dy = wy - d.wy;
        if (e.shiftKey) {
          // Constrain to the dominant axis.
          if (Math.abs(dx) > Math.abs(dy)) dy = 0;
          else dx = 0;
        }
        dx = snap(cx + dx, snapOn) - cx;
        dy = snap(cy + dy, snapOn) - cy;
        replaceObjects(d.objs.map((o) => ({ ...o, x: o.x + dx, y: o.y + dy })));
      } else if (d.kind === "rotate") {
        if (!d.moved) {
          checkpoint();
          d.moved = true;
        }
        let delta = (Math.atan2(wy - d.cy, wx - d.cx) * 180) / Math.PI - d.start;
        const single = d.objs.length === 1 ? d.objs[0] : null;
        // Shift snaps to 15°: the final angle for one object, the turn for a group.
        if (e.shiftKey) {
          delta = single ? Math.round((single.rotation + delta) / 15) * 15 - single.rotation : Math.round(delta / 15) * 15;
        }
        replaceObjects(d.objs.map((o) => rotateObj(o, delta, d.cx, d.cy)));
        const shown = normalizeDegrees(single ? single.rotation + delta : delta);
        overlay.current.angle = { deg: shown, x: sx, y: sy };
      } else if (d.kind === "resize") {
        if (!d.moved) {
          checkpoint();
          d.moved = true;
        }
        const b = d.bounds;
        const [hx, hy] = d.dir;
        const px = snap(wx, snapOn);
        const py = snap(wy, snapOn);
        const fromCenter = e.altKey;
        const cx = (b.minX + b.maxX) / 2;
        const cy = (b.minY + b.maxY) / 2;
        const min = 0.5;
        let { minX, maxX, minY, maxY } = b;
        if (hx === 1) {
          maxX = Math.max(px, (fromCenter ? cx : minX) + min);
          if (fromCenter) minX = 2 * cx - maxX;
        } else if (hx === -1) {
          minX = Math.min(px, (fromCenter ? cx : maxX) - min);
          if (fromCenter) maxX = 2 * cx - minX;
        }
        if (hy === 1) {
          maxY = Math.max(py, (fromCenter ? cy : minY) + min);
          if (fromCenter) minY = 2 * cy - maxY;
        } else if (hy === -1) {
          minY = Math.min(py, (fromCenter ? cy : maxY) - min);
          if (fromCenter) maxY = 2 * cy - minY;
        }
        // Corner handles keep proportions unless Shift is held.
        if (hx && hy && !e.shiftKey) {
          const bw = b.maxX - b.minX;
          const bh = b.maxY - b.minY;
          const k = Math.max((maxX - minX) / bw, (maxY - minY) / bh);
          const ax = fromCenter ? cx : hx === 1 ? b.minX : b.maxX;
          const ay = fromCenter ? cy : hy === 1 ? b.minY : b.maxY;
          const nw = bw * k;
          const nh = bh * k;
          if (fromCenter) {
            minX = ax - nw / 2;
            maxX = ax + nw / 2;
            minY = ay - nh / 2;
            maxY = ay + nh / 2;
          } else {
            minX = hx === 1 ? ax : ax - nw;
            maxX = minX + nw;
            minY = hy === 1 ? ay : ay - nh;
            maxY = minY + nh;
          }
        }
        replaceObjects(mapObjects(d.objs, b, { minX, maxX, minY, maxY }));
      } else if (d.kind === "marquee") {
        const m: Bounds = { minX: Math.min(d.wx, wx), maxX: Math.max(d.wx, wx), minY: Math.min(d.wy, wy), maxY: Math.max(d.wy, wy) };
        overlay.current.marquee = m;
        const s = getState();
        const hits = s.objects
          .filter((o) => (o.type === "art" ? s.display.art : s.display.refs))
          .filter((o) => {
            const b = objBounds(o);
            return b.minX <= m.maxX && b.maxX >= m.minX && b.minY <= m.maxY && b.maxY >= m.minY;
          })
          .map((o) => o.id);
        select([...new Set([...d.base, ...hits])]);
      }
      requestDraw();
    };

    const onUp = (e: PointerEvent) => {
      drag.current = null;
      overlay.current.marquee = null;
      overlay.current.angle = null;
      if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
      const [sx, sy] = local(e);
      setCursor(sx, sy);
      requestDraw();
    };

    const onLeave = () => {
      overlay.current.cursor = null;
      requestDraw();
    };

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const [sx, sy] = local(e);
      const scale = e.deltaMode === 1 ? 33 : 1;
      if (e.ctrlKey || e.metaKey) {
        const dy = Math.max(-50, Math.min(50, e.deltaY * scale));
        zoomAt(Math.exp(-dy * 0.01), sx, sy);
      } else {
        const v = getView();
        setView({ ...v, cx: v.cx + (e.deltaX * scale) / v.zoom, cy: v.cy - (e.deltaY * scale) / v.zoom });
      }
    };

    // ---- keyboard ----
    const onKeyDown = (e: KeyboardEvent) => {
      if (isTyping(e.target)) return;
      const mod = e.metaKey || e.ctrlKey;
      const k = e.key.toLowerCase();
      const s = getState();
      let handled = true;
      if (e.key === " ") {
        space.current = true;
        if (!drag.current) canvas.style.cursor = "grab";
      } else if (mod && k === "z") (e.shiftKey ? redo : undo)();
      else if (mod && k === "y") redo();
      else if (mod && k === "a") selectAll();
      else if (mod && k === "c") copySelection();
      else if (mod && k === "x") cutSelection();
      else if (mod && k === "v") paste();
      else if (mod && k === "d") duplicateSelection();
      else if (!mod && k === "r") rotateSelection(e.shiftKey ? -15 : 15);
      else if (e.key === "Delete" || e.key === "Backspace") deleteSelection();
      else if (e.key === "Escape") {
        if (s.pickMode) setState({ pickMode: null });
        else select([]);
      }
      else if (e.key.startsWith("Arrow") && s.selection.length) {
        const step = s.units === "in" ? (e.shiftKey ? 0.5 : 1 / 16) * MM_PER_IN : e.shiftKey ? 10 : 1;
        const dx = e.key === "ArrowLeft" ? -step : e.key === "ArrowRight" ? step : 0;
        const dy = e.key === "ArrowDown" ? -step : e.key === "ArrowUp" ? step : 0;
        moveSelection(dx, dy);
      } else if (!mod && (e.key === "0" || e.key === "Home")) home();
      else if (!mod && k === "f") fit(s.selection.length ? unionBounds(selectedObjects().map(objBounds)) : unionBounds(s.objects.map(objBounds)));
      else if (!mod && (e.key === "=" || e.key === "+")) zoomAt(1.25);
      else if (!mod && e.key === "-") zoomAt(0.8);
      else handled = false;
      if (handled) e.preventDefault();
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === " ") {
        space.current = false;
        if (!drag.current) canvas.style.cursor = "default";
      }
    };

    canvas.addEventListener("pointerdown", onDown);
    canvas.addEventListener("pointermove", onMove);
    canvas.addEventListener("pointerup", onUp);
    canvas.addEventListener("pointercancel", onUp);
    canvas.addEventListener("pointerleave", onLeave);
    canvas.addEventListener("wheel", onWheel, { passive: false });
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      ro.disconnect();
      unsub();
      unsubView();
      if (frame.current) cancelAnimationFrame(frame.current);
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerup", onUp);
      canvas.removeEventListener("pointercancel", onUp);
      canvas.removeEventListener("pointerleave", onLeave);
      canvas.removeEventListener("wheel", onWheel);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, []);

  return (
    <div
      ref={wrapRef}
      className="relative h-full w-full overflow-hidden"
      onDragOver={(e) => {
        e.preventDefault();
        setDropping(true);
      }}
      onDragLeave={() => setDropping(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDropping(false);
        void importFiles(Array.from(e.dataTransfer.files));
      }}
    >
      <canvas ref={canvasRef} className="absolute inset-0 touch-none select-none" />
      <div
        ref={statusRef}
        className="pointer-events-none absolute right-2 bottom-2 rounded bg-black/60 px-2 py-0.5 font-mono text-[11px] text-neutral-400"
      />
      {pickMode && (
        <div className="absolute top-8 left-1/2 z-10 flex -translate-x-1/2 items-center gap-3 rounded-full border border-amber-500/50 bg-neutral-950/90 py-1 pr-1 pl-4 text-sm text-amber-100 shadow-lg">
          {pickMode === "regions"
            ? "Click regions to fill or clear them"
            : pickMode === "lines"
              ? "Click a line to remove it (no nails, regions join) or put it back"
              : pickMode === "widths"
                ? "Click a piece of line to give it the width (again to undo) · Shift-click for the whole line"
                : "Click a nail to remove it, or a crossed-out one to put it back"}
          <button
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => setState({ pickMode: null })}
            className="rounded-full bg-amber-500 px-3 py-0.5 text-sm font-medium text-neutral-950 hover:bg-amber-400"
          >
            Done
          </button>
        </div>
      )}
      {dropping && (
        <div className="pointer-events-none absolute inset-3 flex items-center justify-center rounded-lg border-2 border-dashed border-amber-400/70 bg-amber-400/5 text-sm text-amber-200">
          Drop SVG or DXF artwork to import
        </div>
      )}
    </div>
  );
}
