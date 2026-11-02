import { artToWorld, dist, polygonArea, toWorld } from "./geometry";
import { placeContourNails } from "./nails";
import { artLineKey } from "./outline";
import { graphChains } from "./graph";
import { type Arrangement, arrangement, isFilled, worldRegions } from "./regions";
import { fillIsland } from "./stringing";
import type { Artwork, Island, Nail, Obj, Pattern, PatternSettings, Pt } from "./types";

/** Identifies the inputs a pattern was computed from, so we can tell when it is stale. */
export function patternKey(objects: Obj[], s: PatternSettings): string {
  const art = objects
    .filter((o): o is Artwork => o.type === "art")
    .map((o) =>
      [o.id, o.x, o.y, o.w, o.h, o.rotation ?? 0, o.contours.length, artLineKey(o), JSON.stringify(o.fills ?? []), JSON.stringify(o.cuts ?? []), JSON.stringify(o.removedNails ?? [])].join(","),
    );
  return JSON.stringify([art, s.spacing, s.cornerAngle, s.nailDiameter, s.shading, s.minNails, s.seed]);
}

/** String per unit area (per mm) for each step of the shading setting. */
const SHADING_PER_MM = 0.5;

export function islandLabel(i: number): string {
  let s = "";
  i++;
  while (i > 0) {
    const r = (i - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    i = Math.floor((i - 1) / 26);
  }
  return s;
}

const edgeKey = (u: number, v: number) => (u < v ? `${u},${v}` : `${v},${u}`);

interface ArtGraph {
  art: Artwork;
  arr: Arrangement;
  world: Pt[];
  /** Closer nail spacing wanted along edges of small filled shapes. */
  edgeSpacing: Map<string, number>;
  /** Nail sitting exactly on a vertex (junctions, line ends, some corners). */
  vertexNail: Map<number, number>;
  /** Nails part-way along an edge, by position from the lower to the higher vertex id. */
  edgeNails: Map<string, { t: number; n: number }[]>;
}

export function computePattern(objects: Obj[], s: PatternSettings): Pattern {
  const warnings: string[] = [];
  const key = patternKey(objects, s);
  const arts = objects.filter((o): o is Artwork => o.type === "art");
  if (!arts.length) return { key, nails: [], islands: [], warnings: ["Import some artwork first."] };
  if (s.spacing < s.nailDiameter * 2) warnings.push("Nail spacing is less than twice the nail diameter.");

  // 1. Lines as graphs in world space. Nails go on every line, and a line shared
  //    by two regions shares its nails.
  const drafts: { x: number; y: number; corner: boolean; art: Artwork }[] = [];
  const graphs: ArtGraph[] = [];
  const chains: { g: ArtGraph; verts: number[]; closed: boolean; top: number; left: number }[] = [];
  for (const art of arts) {
    const arr = arrangement(art);
    const sx = art.w0 > 0 ? art.w / art.w0 : 1;
    const sy = art.h0 > 0 ? art.h / art.h0 : 1;
    const world = arr.verts.map(([x, y]) => toWorld(art, x * sx, y * sy));
    const g: ArtGraph = { art, arr, world, edgeSpacing: new Map(), vertexNail: new Map(), edgeNails: new Map() };
    graphs.push(g);
    for (const c of graphChains(arr.verts.length, arr.edges)) {
      let top = -Infinity;
      let left = Infinity;
      for (const v of c.verts) {
        top = Math.max(top, world[v][1]);
        left = Math.min(left, world[v][0]);
      }
      chains.push({ g, ...c, top, left });
    }
  }

  // 2. Small filled shapes get closer nails (down to a workable minimum), so they
  //    have enough nail-to-nail lines to take as much shading as big ones.
  const closest = Math.max(s.nailDiameter * 3, s.spacing * 0.35);
  if (s.minNails > 0) {
    for (const g of graphs) {
      g.arr.regions.forEach((r, ri) => {
        if (!isFilled(g.art, ri)) return;
        const ring = r.rings[0];
        let perimeter = 0;
        ring.forEach((v, k) => (perimeter += dist(g.world[v], g.world[ring[(k + 1) % ring.length]])));
        const want = Math.max(closest, perimeter / s.minNails);
        if (want >= s.spacing) return;
        ring.forEach((v, k) => {
          const key = edgeKey(v, ring[(k + 1) % ring.length]);
          g.edgeSpacing.set(key, Math.min(g.edgeSpacing.get(key) ?? Infinity, want));
        });
      });
    }
  }

  // 3. Nails along each chain, numbered in reading order so neighbours get nearby numbers.
  chains.sort((a, b) => (Math.abs(a.top - b.top) > s.spacing ? b.top - a.top : a.left - b.left));
  const vertexNail = (g: ArtGraph, v: number, corner: boolean) => {
    if (!g.vertexNail.has(v)) {
      g.vertexNail.set(v, drafts.length);
      drafts.push({ x: g.world[v][0], y: g.world[v][1], corner, art: g.art });
    }
  };
  for (const c of chains) {
    const { g, verts, closed } = c;
    const pts = verts.map((v) => g.world[v]);
    const m = pts.length;
    if (m < 2) continue;
    if (!closed) vertexNail(g, verts[0], true);
    let spacing = s.spacing;
    for (let k = 0; k < (closed ? m : m - 1); k++) spacing = Math.min(spacing, g.edgeSpacing.get(edgeKey(verts[k], verts[(k + 1) % m])) ?? Infinity);
    const placed = placeContourNails(pts, closed, spacing, s.cornerAngle);
    const segCount = closed ? m : m - 1;
    const cum = [0];
    for (let k = 0; k < segCount; k++) cum.push(cum[k] + dist(pts[k], pts[(k + 1) % m]));
    const L = cum[segCount];
    const eps = L * 1e-9 + 1e-9;
    placed.s.forEach((at, i) => {
      // Line ends are placed as vertex nails, above and below.
      if (!closed && (at <= eps || at >= L - eps)) return;
      let lo = 0;
      let hi = segCount - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (cum[mid] <= at) lo = mid;
        else hi = mid - 1;
      }
      const u = verts[lo];
      const v = verts[(lo + 1) % m];
      const len = cum[lo + 1] - cum[lo];
      const t = len > 0 ? (at - cum[lo]) / len : 0;
      if (t <= 1e-6) vertexNail(g, u, placed.corner[i]);
      else if (t >= 1 - 1e-6) vertexNail(g, v, placed.corner[i]);
      else {
        const k = edgeKey(u, v);
        const list = g.edgeNails.get(k) ?? [];
        list.push({ t: u < v ? t : 1 - t, n: drafts.length });
        g.edgeNails.set(k, list);
        drafts.push({ x: placed.pts[i][0], y: placed.pts[i][1], corner: placed.corner[i], art: g.art });
      }
    });
    if (!closed) vertexNail(g, verts[m - 1], true);
  }
  for (const g of graphs) for (const list of g.edgeNails.values()) list.sort((a, b) => a.t - b.t);

  // 4. Drop nails that would sit on top of each other (lines meeting at a shallow angle).
  const minGap = Math.min(Math.max(s.nailDiameter * 1.5, s.spacing * 0.3), s.spacing * 0.45);
  const taken = new Map<string, Pt[]>();
  const tooClose = (p: Pt) => {
    const ix = Math.floor(p[0] / minGap);
    const iy = Math.floor(p[1] / minGap);
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++) for (const q of taken.get(`${ix + dx},${iy + dy}`) ?? []) if (dist(p, q) < minGap) return true;
    return false;
  };
  const keep = new Uint8Array(drafts.length);
  for (const pass of [true, false]) {
    drafts.forEach((d, i) => {
      if (d.corner !== pass) return;
      const p: Pt = [d.x, d.y];
      if (tooClose(p)) return;
      keep[i] = 1;
      const k = `${Math.floor(d.x / minGap)},${Math.floor(d.y / minGap)}`;
      const list = taken.get(k);
      if (list) list.push(p);
      else taken.set(k, [p]);
    });
  }
  const dropped = drafts.filter((_, i) => !keep[i]).map((d): Pt => [d.x, d.y]);

  // Nails the user removed: each takes out the nearest nail it sits on.
  const removeWithin = s.spacing * 0.45;
  for (const art of arts) {
    for (const [lx, ly] of art.removedNails ?? []) {
      const [x, y] = artToWorld(art, lx, ly);
      let best = -1;
      let bestD = removeWithin;
      drafts.forEach((d, i) => {
        if (!keep[i] || d.art !== art) return;
        const dd = Math.hypot(d.x - x, d.y - y);
        if (dd < bestD) {
          bestD = dd;
          best = i;
        }
      });
      if (best >= 0) keep[best] = 0;
    }
  }
  const index = new Int32Array(drafts.length).fill(-1);
  const nails: Nail[] = [];
  drafts.forEach((d, i) => {
    if (!keep[i]) return;
    index[i] = nails.length;
    nails.push({ x: d.x, y: d.y, corner: d.corner, label: String(nails.length + 1), art: d.art.id });
  });

  // 5. The ring of nails around each filled region, then string it with an amount
  //    of string in proportion to its area, so every shape is shaded alike.
  const ringNails = (g: ArtGraph, ring: number[]) => {
    const raw: number[] = [];
    ring.forEach((u, k) => {
      const v = ring[(k + 1) % ring.length];
      const vn = g.vertexNail.get(u);
      if (vn !== undefined) raw.push(vn);
      const list = g.edgeNails.get(edgeKey(u, v));
      if (!list) return;
      if (u < v) for (const e of list) raw.push(e.n);
      else for (let j = list.length - 1; j >= 0; j--) raw.push(list[j].n);
    });
    const out: number[] = [];
    for (const r of raw) {
      const n = index[r];
      if (n >= 0 && n !== out[out.length - 1]) out.push(n);
    }
    while (out.length > 1 && out[0] === out[out.length - 1]) out.pop();
    return out;
  };

  const toFill: { rings: number[][]; top: number; left: number; target: number; world: Pt[][] }[] = [];
  let totalRegions = 0;
  const small: Pt[][][] = [];
  arts.forEach((art, ai) => {
    const g = graphs[ai];
    const areaScale = (art.w0 > 0 ? art.w / art.w0 : 1) * (art.h0 > 0 ? art.h / art.h0 : 1);
    g.arr.regions.forEach((r, ri) => {
      totalRegions++;
      if (!isFilled(art, ri)) return;
      const [outer, ...holes] = r.rings.map((ring) => ringNails(g, ring));
      if (outer.length < 2) {
        small.push(worldRegions(art)[ri]);
        return;
      }
      let top = -Infinity;
      let left = Infinity;
      for (const n of outer) {
        top = Math.max(top, nails[n].y);
        left = Math.min(left, nails[n].x);
      }
      const area = (Math.abs(polygonArea(r.pts[0])) - r.pts.slice(1).reduce((a, h) => a + Math.abs(polygonArea(h)), 0)) * areaScale;
      toFill.push({
        rings: [outer, ...holes.filter((h) => h.length >= 3)],
        top,
        left,
        target: s.shading * SHADING_PER_MM * Math.max(area, 0),
        world: worldRegions(art)[ri],
      });
    });
  });
  toFill.sort((a, b) => (Math.abs(a.top - b.top) > s.spacing ? b.top - a.top : a.left - b.left));

  const light: Pt[][][] = [];
  const islands: Island[] = toFill.map((region, i) => {
    const flat = region.rings.flat();
    const outer = region.rings[0];
    // A sliver with only two nails on its edge gets a single string between them.
    const tiny = outer.length === 2;
    let sequence = tiny
      ? [...outer]
      : fillIsland(
          region.rings.map((ring) => ring.map((n): Pt => [nails[n].x, nails[n].y])),
          { targetLength: region.target, seed: s.seed + i * 7919 },
        ).map((k) => flat[k]);
    // Too small to fill: wrap the outline instead.
    if (sequence.length < 3 && !tiny) sequence = [...outer, outer[0]];
    let length = 0;
    for (let k = 1; k < sequence.length; k++) {
      const a = nails[sequence[k - 1]];
      const b = nails[sequence[k]];
      length += Math.hypot(a.x - b.x, a.y - b.y);
    }
    // Ran out of distinct nail-to-nail lines before reaching the shading.
    if (!tiny && length < region.target * 0.75) light.push(region.world);
    return { label: islandLabel(i), nails: [...new Set(flat)], sequence, length };
  });

  if (!totalRegions) warnings.push("No enclosed regions found, so nails only follow the lines. If lines nearly meet, raise “Close gaps” on the Design tab.");
  else if (!islands.length) warnings.push("No regions are set to fill. Use “Pick regions” to choose them.");
  return { key, nails, islands, warnings, issues: { small, dropped, light } };
}

/** Totals for display, with a rough string estimate that allows for wraps and slack. */
export function patternStats(p: Pattern, nailDiameter: number) {
  let lines = 0;
  let length = 0;
  for (const isl of p.islands) {
    lines += Math.max(0, isl.sequence.length - 1);
    length += isl.length;
  }
  const estimate = length * 1.1 + lines * Math.PI * nailDiameter;
  return { nails: p.nails.length, shapes: p.islands.length, lines, estimate };
}
