// All lengths are stored in millimetres. World coordinates are Y-up with the
// canvas origin at (0, 0).

export type Units = "mm" | "in";

export type Pt = [number, number];

export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** Flattened outline, stored as [x0, y0, x1, y1, ...] relative to the artwork's natural centre. */
export interface Contour {
  pts: number[];
  closed: boolean;
  /** Layer it was drawn on in the source file. */
  layer?: string;
  /** Stroke width in the source file (mm); only meaningful relative to other lines. */
  weight?: number;
  /** A closed shape that's filled in the source file, so it hides what was drawn before it. */
  filled?: boolean;
}

export interface LayerSettings {
  /** false leaves the layer out: no nails or regions (it stays visible as a guide). */
  include?: boolean;
  /** Width for this layer's single lines (local units), instead of the artwork's. */
  lineWidth?: number;
}

interface ObjBase {
  id: string;
  name: string;
  /** Centre, and the point the object rotates about. */
  x: number;
  y: number;
  /** Size before rotation. */
  w: number;
  h: number;
  /** Degrees counter-clockwise about (x, y). */
  rotation: number;
}

export type RefKind = "polygon" | "ellipse";

export interface RefShape extends ObjBase {
  type: "ref";
  kind: RefKind;
  sides: number;
}

export interface Artwork extends ObjBase {
  type: "art";
  /** Natural size of the contours as imported. */
  w0: number;
  h0: number;
  contours: Contour[];
  /** Loose line ends closer than this (local units) to another line are joined. */
  gap?: number;
  /** Width given to open lines (local units); 0 keeps them as thin lines. */
  lineWidth?: number;
  /** Scale each line's width by its stroke width in the file, relative to the widest. */
  lineWeights?: boolean;
  /** Per-layer settings, by layer name. */
  layers?: Record<string, LayerSettings>;
  /** Region fill choices, each saved as a point inside the region (artwork units). */
  fills?: { at: Pt; on: boolean }[];
  /** Removed line pieces (no nails; regions either side join), each saved as a point on the piece. */
  cuts?: Pt[];
  /** Widths painted onto pieces of single lines, each saved as a point on the piece (artwork units). */
  widths?: { at: Pt; width: number }[];
  /** Nails the user took out, by position in the artwork's own (unscaled) coordinates. */
  removedNails?: Pt[];
}

export type Obj = RefShape | Artwork;

export interface PatternSettings {
  spacing: number;
  cornerAngle: number;
  nailDiameter: number;
  /** How much string goes into each shape, in proportion to its area. */
  shading: number;
  /** Small filled shapes get closer nails to reach at least this many. 0 turns it off. */
  minNails: number;
  seed: number;
}

export interface Nail {
  x: number;
  y: number;
  label: string;
  corner: boolean;
  /** Id of the artwork the nail belongs to. */
  art?: string;
}

export interface Island {
  label: string;
  /** Indices into Pattern.nails. */
  nails: number[];
  /** Stringing order as indices into Pattern.nails. */
  sequence: number[];
  /** Length of string used by the sequence, centre to centre. */
  length: number;
}

export interface Pattern {
  key: string;
  nails: Nail[];
  islands: Island[];
  warnings: string[];
  /** Where things went wrong, in world coordinates, so they can be shown. */
  issues?: {
    /** Regions set to fill that ended up with fewer than three nails (rings). */
    small: Pt[][][];
    /** Nails left out for being too close to another. */
    dropped: Pt[];
    /** Filled regions that ran out of distinct lines before reaching the shading. */
    light?: Pt[][][];
  };
}

export type PaperId = "letter" | "legal" | "tabloid" | "a4" | "a3";

export interface PrintSettings {
  paper: PaperId;
  orientation: "auto" | "portrait" | "landscape";
  margin: number;
  overlap: number;
  outline: boolean;
  refs: boolean;
  strings: boolean;
  labels: boolean;
  grid: boolean;
  sequence: boolean;
}

export interface GcodeSettings {
  mode: "plunge" | "laser";
  units: Units;
  origin: "center" | "bottom-left" | "top-left";
  safeZ: number;
  depth: number;
  /** mm per minute */
  plungeFeed: number;
  spindle: number;
  /** seconds */
  dwell: number;
  laserPower: number;
  laserDwell: number;
}

export interface DisplaySettings {
  art: boolean;
  refs: boolean;
  nails: boolean;
  strings: boolean;
  labels: boolean;
  stringColor: string;
  snap: boolean;
}
