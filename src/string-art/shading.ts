import { worldToArt } from "./geometry";
import { layerIncluded, thinLines } from "./outline";
import type { Artwork } from "./types";

/**
 * How dark each point of an artwork should be, from per-layer shading: inside
 * a shape, the shape's layer (later shapes win, as drawn); elsewhere (bands
 * made from lines) the layer of the nearest line. Layers without their own
 * shading use `fallback`.
 */
export function layerShading(a: Artwork, fallback: number): (x: number, y: number) => number {
  const names = [...new Set(a.contours.map((c) => c.layer ?? ""))];
  const value = names.map((name) => a.layers?.[name]?.shading ?? fallback);
  if (value.every((v) => v === fallback)) return () => fallback;

  // A label grid in the artwork's own units.
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const c of a.contours)
    for (let i = 0; i + 1 < c.pts.length; i += 2) {
      minX = Math.min(minX, c.pts[i]);
      maxX = Math.max(maxX, c.pts[i]);
      minY = Math.min(minY, c.pts[i + 1]);
      maxY = Math.max(maxY, c.pts[i + 1]);
    }
  const h = Math.max(maxX - minX, maxY - minY, 1e-6) / 300;
  const nx = Math.ceil((maxX - minX) / h) + 1;
  const ny = Math.ceil((maxY - minY) / h) + 1;
  const label = new Int16Array(nx * ny).fill(-1);
  const cell = (x: number, y: number) => {
    const i = Math.min(nx - 1, Math.max(0, Math.floor((x - minX) / h)));
    const j = Math.min(ny - 1, Math.max(0, Math.floor((y - minY) / h)));
    return j * nx + i;
  };
  const layerIndex = new Map(names.map((name, i) => [name, i]));

  // Lines: mark the cells they pass through, then spread to the nearest line.
  const queue: number[] = [];
  for (const l of thinLines(a)) {
    if (l.closed) continue;
    const li = layerIndex.get(a.contours[l.src!].layer ?? "")!;
    for (let k = 0; k + 1 < l.pts.length; k++) {
      const [x1, y1] = l.pts[k];
      const [x2, y2] = l.pts[k + 1];
      const steps = Math.max(1, Math.ceil(Math.hypot(x2 - x1, y2 - y1) / (h / 2)));
      for (let s = 0; s <= steps; s++) {
        const c = cell(x1 + ((x2 - x1) * s) / steps, y1 + ((y2 - y1) * s) / steps);
        if (label[c] < 0) {
          label[c] = li;
          queue.push(c);
        }
      }
    }
  }
  for (let q = 0; q < queue.length; q++) {
    const c = queue[q];
    const i = c % nx;
    const j = (c - i) / nx;
    for (const [di, dj] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ]) {
      const ii = i + di;
      const jj = j + dj;
      if (ii < 0 || jj < 0 || ii >= nx || jj >= ny) continue;
      const o = jj * nx + ii;
      if (label[o] >= 0) continue;
      label[o] = label[c];
      queue.push(o);
    }
  }

  // Shapes take their own layer, in drawing order.
  for (const c of a.contours) {
    if (!c.closed || !layerIncluded(a, c.layer)) continue;
    const li = layerIndex.get(c.layer ?? "")!;
    const n = c.pts.length / 2;
    for (let j = 0; j < ny; j++) {
      const py = minY + (j + 0.5) * h;
      const xs: number[] = [];
      for (let k = 0, m = n - 1; k < n; m = k++) {
        const y1 = c.pts[m * 2 + 1];
        const y2 = c.pts[k * 2 + 1];
        if (y1 > py !== y2 > py) {
          const x1 = c.pts[m * 2];
          const x2 = c.pts[k * 2];
          xs.push(x1 + ((py - y1) * (x2 - x1)) / (y2 - y1));
        }
      }
      xs.sort((p, q) => p - q);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const i0 = Math.max(0, Math.ceil((xs[k] - minX) / h - 0.5));
        const i1 = Math.min(nx - 1, Math.floor((xs[k + 1] - minX) / h - 0.5));
        for (let i = i0; i <= i1; i++) label[j * nx + i] = li;
      }
    }
  }

  return (x, y) => {
    const [lx, ly] = worldToArt(a, x, y);
    const l = label[cell(lx, ly)];
    return l >= 0 ? value[l] : fallback;
  };
}
