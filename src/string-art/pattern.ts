import { artToWorld, dist, distToSegment } from "./geometry";
import { placeContourNails } from "./nails";
import { artLineKey } from "./outline";
import { graphChains } from "./graph";
import { type Arrangement, arrangement, isFilled, regionContains, worldRegions } from "./regions";
import { layerShading } from "./shading";
import { fillIsland } from "./stringing";
import type { Artwork, Island, Nail, Obj, Pattern, PatternSettings, Pt } from "./types";

/** Identifies the inputs a pattern was computed from, so we can tell when it is stale. */
export function patternKey(objects: Obj[], s: PatternSettings): string {
  const art = objects
    .filter((o): o is Artwork => o.type === "art")
    .map((o) =>
      [
        o.id,
        o.x,
        o.y,
        o.w,
        o.h,
        o.rotation ?? 0,
        o.contours.length,
        artLineKey(o),
        JSON.stringify(o.layers ?? {}),
        JSON.stringify(o.fills ?? []),
        JSON.stringify(o.shades ?? []),
        JSON.stringify(o.cuts ?? []),
        JSON.stringify(o.removedNails ?? []),
      ].join(","),
    );
  return JSON.stringify([art, s.spacing, s.cornerAngle, s.nailDiameter, s.shading, s.minNails, s.outline, s.autoSpacing, s.restarts, s.seed]);
}

/** String per unit area (per mm) for each step of the shading setting. */
export const SHADING_PER_MM = 0.5;

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


interface ArtBase {
  art: Artwork;
  arr: Arrangement;
  world: Pt[];
  chains: { verts: number[]; closed: boolean }[];
  /** Shading at a world point from the artwork's layers. */
  shadeAt: (x: number, y: number) => number;
}

export function computePattern(objects: Obj[], s: PatternSettings): Pattern {
  const warnings: string[] = [];
  const key = patternKey(objects, s);
  const arts = objects.filter((o): o is Artwork => o.type === "art");
  if (!arts.length) return { key, nails: [], islands: [], warnings: ["Import some artwork first."] };
  if (s.spacing < s.nailDiameter * 2) warnings.push("Nail spacing is less than twice the nail diameter.");

  // Lines as graphs in world space. Nails go on every line, and a line shared by
  // two regions shares its nails.
  const bases: ArtBase[] = arts.map((art) => {
    const arr = arrangement(art);
    const world = arr.verts.map(([x, y]) => artToWorld(art, x, y));
    return { art, arr, world, chains: graphChains(arr.verts.length, arr.edges), shadeAt: layerShading(art, s.shading) };
  });

  // Closer nail spacing along some edges: small filled shapes get enough nails to
  // take their shading, and (with auto spacing) so do stretches the fill couldn't
  // shade enough on a first try. Never closer than a workable minimum.
  const closest = Math.max(s.nailDiameter * 3, s.spacing * 0.35);
  const spacingAt = bases.map(() => new Map<string, number>());
  const tighten = (ai: number, ring: number[], closed: boolean, want: number) => {
    const n = closed ? ring.length : ring.length - 1;
    for (let k = 0; k < n; k++) {
      const key = edgeKey(ring[k], ring[(k + 1) % ring.length]);
      spacingAt[ai].set(key, Math.min(spacingAt[ai].get(key) ?? Infinity, Math.max(closest, want)));
    }
  };
  if (s.minNails > 0) {
    bases.forEach(({ art, arr, world }, ai) => {
      arr.regions.forEach((r, ri) => {
        if (!isFilled(art, ri)) return;
        const ring = r.rings[0];
        let perimeter = 0;
        ring.forEach((v, k) => (perimeter += dist(world[v], world[ring[(k + 1) % ring.length]])));
        if (perimeter / s.minNails < s.spacing) tighten(ai, ring, true, perimeter / s.minNails);
      });
    });
  }

  let run = layout(bases, spacingAt, s);
  if (s.autoSpacing) {
    for (let pass = 0; pass < 2; pass++) {
      let changed = false;
      bases.forEach((b, ai) => {
        const thin = run.thin[ai];
        if (!thin.length) return;
        // Bucket the thin spots so each chain only checks those nearby.
        const reach = s.spacing * 2;
        const buckets = new Map<string, Pt[]>();
        for (const p of thin) {
          const k = `${Math.floor(p[0] / reach)},${Math.floor(p[1] / reach)}`;
          const list = buckets.get(k);
          if (list) list.push(p);
          else buckets.set(k, [p]);
        }
        const nearThin = (a: Pt, c: Pt) => {
          const x0 = Math.floor((Math.min(a[0], c[0]) - reach) / reach);
          const x1 = Math.floor((Math.max(a[0], c[0]) + reach) / reach);
          const y0 = Math.floor((Math.min(a[1], c[1]) - reach) / reach);
          const y1 = Math.floor((Math.max(a[1], c[1]) + reach) / reach);
          for (let i = x0; i <= x1; i++)
            for (let j = y0; j <= y1; j++) for (const p of buckets.get(`${i},${j}`) ?? []) if (distToSegment(p, a, c) < reach) return true;
          return false;
        };
        for (const c of b.chains) {
          const m = c.verts.length;
          const segs = c.closed ? m : m - 1;
          let current = s.spacing;
          for (let k = 0; k < segs; k++) current = Math.min(current, spacingAt[ai].get(edgeKey(c.verts[k], c.verts[(k + 1) % m])) ?? s.spacing);
          if (current <= closest * 1.01) continue;
          let near = false;
          for (let k = 0; k < segs && !near; k++) near = nearThin(b.world[c.verts[k]], b.world[c.verts[(k + 1) % m]]);
          if (!near) continue;
          tighten(ai, c.verts, c.closed, current * 0.6);
          changed = true;
        }
      });
      if (!changed) break;
      run = layout(bases, spacingAt, s);
    }
  }

  const { nails, islands, small, dropped, light, totalRegions } = run;
  if (!totalRegions) warnings.push("No enclosed regions found, so nails only follow the lines. If lines nearly meet, raise “Close gaps” on the Design tab.");
  else if (!islands.length) warnings.push("No regions are set to fill. Use “Pick regions” to choose them.");
  return { key, nails, islands, warnings, issues: { small, dropped, light } };
}

/** Nails along every line (with the given spacing overrides), then string each filled region. */
function layout(bases: ArtBase[], spacingAt: Map<string, number>[], s: PatternSettings) {
  const drafts: { x: number; y: number; corner: boolean; art: Artwork }[] = [];
  const graphs = bases.map((b) => ({ ...b, vertexNail: new Map<number, number>(), edgeNails: new Map<string, { t: number; n: number }[]>() }));
  type G = (typeof graphs)[number];

  // Nails along each chain, numbered in reading order so neighbours get nearby numbers.
  const chains = graphs.flatMap((g, ai) =>
    g.chains.map((c) => {
      let top = -Infinity;
      let left = Infinity;
      for (const v of c.verts) {
        top = Math.max(top, g.world[v][1]);
        left = Math.min(left, g.world[v][0]);
      }
      return { g, ai, ...c, top, left };
    }),
  );
  chains.sort((a, b) => (Math.abs(a.top - b.top) > s.spacing ? b.top - a.top : a.left - b.left));
  const vertexNail = (g: G, v: number, corner: boolean) => {
    if (!g.vertexNail.has(v)) {
      g.vertexNail.set(v, drafts.length);
      drafts.push({ x: g.world[v][0], y: g.world[v][1], corner, art: g.art });
    }
  };
  for (const c of chains) {
    const { g, ai, verts, closed } = c;
    const pts = verts.map((v) => g.world[v]);
    const m = pts.length;
    if (m < 2) continue;
    if (!closed) vertexNail(g, verts[0], true);
    let spacing = s.spacing;
    for (let k = 0; k < (closed ? m : m - 1); k++) spacing = Math.min(spacing, spacingAt[ai].get(edgeKey(verts[k], verts[(k + 1) % m])) ?? Infinity);
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

  // Drop nails that would sit on top of each other (lines meeting at a shallow angle).
  const closest = Math.max(s.nailDiameter * 3, s.spacing * 0.35);
  const minGap = Math.min(Math.max(s.nailDiameter * 1.5, s.spacing * 0.3), s.spacing * 0.45, closest * 0.8);
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
  for (const { art } of bases) {
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

  // The ring of nails around each filled region.
  const ringNails = (g: G, ring: number[]) => {
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

  const toFill: { ai: number; rings: number[][]; top: number; left: number; world: Pt[][]; densityAt: (x: number, y: number) => number }[] = [];
  let totalRegions = 0;
  const small: Pt[][][] = [];
  graphs.forEach((g, ai) => {
    const art = g.art;
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
      // A region's own shading wins; otherwise it follows the layers.
      const shades = art.shades ?? [];
      let own: number | undefined;
      for (let k = shades.length - 1; k >= 0 && own === undefined; k--) if (regionContains(r, shades[k].at)) own = shades[k].shading;
      const densityAt = own !== undefined ? () => own! * SHADING_PER_MM : (x: number, y: number) => g.shadeAt(x, y) * SHADING_PER_MM;
      toFill.push({ ai, rings: [outer, ...holes.filter((h) => h.length >= 3)], top, left, world: worldRegions(art)[ri], densityAt });
    });
  });
  toFill.sort((a, b) => (Math.abs(a.top - b.top) > s.spacing ? b.top - a.top : a.left - b.left));

  // String each region to an even darkness.
  const light: Pt[][][] = [];
  const thin: Pt[][] = bases.map(() => []);
  const islands: Island[] = toFill.flatMap((region, i) => {
    const flat = region.rings.flat();
    const outer = region.rings[0];
    // A sliver with only two nails on its edge gets a single string between them.
    const tiny = outer.length === 2;
    let strings: number[][];
    if (tiny) strings = [[...outer]];
    else {
      const filled = fillIsland(
        region.rings.map((ring) => ring.map((n): Pt => [nails[n].x, nails[n].y])),
        { densityAt: region.densityAt, seed: s.seed + i * 7919, outline: s.outline, restarts: s.restarts },
      );
      strings = filled.strings.map((seq) => seq.map((k) => flat[k]));
      thin[region.ai].push(...filled.thin);
      light.push(...filled.light.map((ring) => [ring]));
    }
    // Too small to fill: wrap the outline instead.
    if (!tiny && strings.reduce((sum, seq) => sum + seq.length, 0) < 3) strings = [[...outer, outer[0]]];
    const shapeNails = [...new Set(flat)];
    return strings.map((sequence, k): Island => {
      let length = 0;
      for (let q = 1; q < sequence.length; q++) {
        const a = nails[sequence[q - 1]];
        const b = nails[sequence[q]];
        length += Math.hypot(a.x - b.x, a.y - b.y);
      }
      const part = strings.length > 1 ? { index: k + 1, of: strings.length } : undefined;
      return { label: islandLabel(i), part, nails: shapeNails, sequence, length };
    });
  });

  return { nails, islands, small, dropped, light, thin, totalRegions };
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
  return { nails: p.nails.length, shapes: new Set(p.islands.map((i) => i.label)).size, strings: p.islands.length, lines, estimate };
}
