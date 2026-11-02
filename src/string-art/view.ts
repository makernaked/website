"use client";

import { useSyncExternalStore } from "react";
import { RULER, type View } from "./render";
import type { Bounds } from "./types";

/** About 800 mm (~31 in) across the shorter side of the canvas at home. */
const HOME_SPAN = 800;
const MIN_ZOOM = 0.02;
const MAX_ZOOM = 200;

let view: View = { cx: 0, cy: 0, zoom: 1 };
let size = { w: 800, h: 600 };
let homed = false;
const listeners = new Set<() => void>();

function emit() {
  listeners.forEach((l) => l());
}

export function getView() {
  return view;
}

export function getCanvasSize() {
  return size;
}

export function setView(v: View) {
  view = { ...v, zoom: Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, v.zoom)) };
  emit();
}

export function subscribeView(l: () => void) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

export function useView(): View {
  return useSyncExternalStore(subscribeView, getView, getView);
}

export function setCanvasSize(w: number, h: number) {
  size = { w, h };
  if (!homed && w > 0 && h > 0) {
    homed = true;
    home();
  } else emit();
}

export function home() {
  setView({ cx: 0, cy: 0, zoom: Math.min(size.w, size.h) / HOME_SPAN });
}

/** Zooms by `factor` keeping the screen point (sx, sy) fixed. */
export function zoomAt(factor: number, sx = size.w / 2, sy = size.h / 2) {
  const z = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, view.zoom * factor));
  const wx = view.cx + (sx - size.w / 2) / view.zoom;
  const wy = view.cy - (sy - size.h / 2) / view.zoom;
  setView({ cx: wx - (sx - size.w / 2) / z, cy: wy + (sy - size.h / 2) / z, zoom: z });
}

/** Fits the bounds in the visible area (inside the rulers) with some padding. */
export function fit(b: Bounds | null) {
  if (!b) return home();
  const bw = Math.max(b.maxX - b.minX, 1);
  const bh = Math.max(b.maxY - b.minY, 1);
  const availW = size.w - RULER - 80;
  const availH = size.h - RULER - 80;
  const zoom = Math.min(availW / bw, availH / bh);
  // Offset so the bounds centre lands in the middle of the area right/below the rulers.
  setView({
    cx: (b.minX + b.maxX) / 2 - RULER / 2 / zoom,
    cy: (b.minY + b.maxY) / 2 + RULER / 2 / zoom,
    zoom,
  });
}

/** True if the bounds are entirely visible. */
export function isVisible(b: Bounds): boolean {
  const left = view.cx + (RULER - size.w / 2) / view.zoom;
  const right = view.cx + size.w / 2 / view.zoom;
  const top = view.cy - (RULER - size.h / 2) / view.zoom;
  const bottom = view.cy - size.h / 2 / view.zoom;
  return b.minX >= left && b.maxX <= right && b.minY >= bottom && b.maxY <= top;
}
