// Document model of a livery project.
//
// All coordinates are in *document pixels* of the texture the layer belongs to.
// Every layer has an origin (x, y) = its centre; its content is defined in local
// coordinates around (0, 0) and transformed by rotation and scale. Vector content
// is re-rasterised at whatever resolution is requested, so exports are lossless.

/** "#rrggbb", "#rrggbbaa" or "pal:<paletteId>" (linked palette colour). */
export type ColorRef = string;

export interface GradientStop {
  offset: number; // 0..1
  color: ColorRef;
}

export type Paint =
  | { type: "none" }
  | { type: "solid"; color: ColorRef }
  | { type: "linear"; angle: number; stops: GradientStop[] }
  | { type: "radial"; cx: number; cy: number; radius: number; stops: GradientStop[] };

export interface Stroke {
  paint: Paint;
  width: number;
  dash: number[];
  cap: CanvasLineCap;
  join: CanvasLineJoin;
}

export interface Shadow {
  color: ColorRef;
  blur: number;
  offsetX: number;
  offsetY: number;
}

export type BlendMode =
  | "source-over"
  | "multiply"
  | "screen"
  | "overlay"
  | "darken"
  | "lighten"
  | "color-dodge"
  | "color-burn"
  | "hard-light"
  | "soft-light"
  | "difference"
  | "exclusion"
  | "hue"
  | "saturation"
  | "color"
  | "luminosity";

export interface Vec2 {
  x: number;
  y: number;
}

/** World-space vector (model units = metres, SCS axes: +X right, +Y up, -Z forward). */
export type V3 = [number, number, number];

/**
 * 3D projection (decal) placement of a layer. The layer's 2D content and its
 * x/y/rotation/scale live on a "projector plane" through `origin`, facing `normal`.
 * Plane pixels map to world units through `unitsPerPx` (default 1 px = 1 mm).
 * Every texel of the texture is evaluated at its 3D surface position, so the decal
 * crosses UV seams and (rounded) corners without breaks.
 */
export interface Projection {
  origin: V3;
  normal: V3;
  /** Image "up" direction on the plane (orthogonal to normal). */
  up: V3;
  unitsPerPx: number;
  /** Max distance (m) in front of / behind the plane that receives the decal. */
  depth: number;
  /** Surfaces turned further than this (degrees) from the projector are left untouched. */
  maxAngle: number;
  /** Also apply on the opposite (left/right) side through the symmetry plane. */
  mirror: boolean;
  /** Keep text/logos readable on the mirrored side (instead of a mirror image). */
  mirrorReadable: boolean;
}

export interface LayerBase {
  id: string;
  name: string;
  visible: boolean;
  locked: boolean;
  opacity: number; // 0..1
  blend: BlendMode;
  x: number;
  y: number;
  rotation: number; // degrees
  scaleX: number;
  scaleY: number;
  shadow: Shadow | null;
  /** Clip to the nearest non-clipping layer below (like Photoshop clipping masks). */
  clip: boolean;
  /** null = placed directly in UV/texture space (2D); otherwise projected from 3D. */
  projection: Projection | null;
}

export type ShapeGeometry =
  | { kind: "rect"; w: number; h: number; radius: number }
  | { kind: "ellipse"; w: number; h: number }
  | { kind: "polygon"; w: number; h: number; sides: number }
  | { kind: "star"; w: number; h: number; points: number; inner: number }
  | { kind: "path"; points: Vec2[]; closed: boolean; smooth: boolean };

export interface ShapeLayer extends LayerBase {
  type: "shape";
  geometry: ShapeGeometry;
  fill: Paint;
  stroke: Stroke | null;
}

export interface StripeDef {
  color: ColorRef;
  width: number;
}

/** Line design: several parallel coloured stripes following one (smoothed) path. */
export interface StripesLayer extends LayerBase {
  type: "stripes";
  points: Vec2[];
  closed: boolean;
  smooth: boolean;
  stripes: StripeDef[];
  gap: number;
  cap: CanvasLineCap;
  /** Optional dash pattern applied to every stripe. */
  dash: number[];
}

export interface TextLayer extends LayerBase {
  type: "text";
  text: string;
  fontFamily: string;
  fontSize: number;
  bold: boolean;
  italic: boolean;
  letterSpacing: number;
  lineHeight: number;
  align: CanvasTextAlign;
  fill: Paint;
  stroke: Stroke | null;
}

export interface ImageLayer extends LayerBase {
  type: "image";
  /** data: URL (PNG/JPEG/WebP/SVG). SVG is rasterised at render resolution → stays sharp. */
  src: string;
  isSvg: boolean;
  w: number;
  h: number;
  /** Recolour every opaque pixel to this colour (logos). */
  tint: ColorRef | null;
}

export interface SurfacePoint {
  p: V3;
  n: V3;
}

/**
 * Line design drawn *on the 3D surface*: parallel stripes follow a path of surface
 * points. Baked as a distance field around the path, so it wraps around corners
 * and across UV seams. Widths are in millimetres.
 */
export interface SurfaceLineLayer extends LayerBase {
  type: "surfaceLine";
  points: SurfacePoint[];
  smooth: boolean;
  stripes: StripeDef[];
  gap: number;
  cap: "butt" | "round";
  /** [dash, gap] in mm; empty = solid */
  dash: number[];
  mirror: boolean;
}

/** Freehand pixels (brush / 3D painting). Always covers the whole texture. */
export interface RasterLayer extends LayerBase {
  type: "raster";
  /** PNG data URL at the texture's resolution, or "" when empty. */
  src: string;
  w: number;
  h: number;
}

/** Fills the whole texture (background colour or gradient). */
export interface FillLayer extends LayerBase {
  type: "fill";
  fill: Paint;
}

export type Layer = ShapeLayer | StripesLayer | TextLayer | ImageLayer | RasterLayer | FillLayer | SurfaceLineLayer;
export type LayerType = Layer["type"];

export interface TextureDoc {
  id: string;
  name: string; // also the file stem on export
  width: number;
  height: number;
  /** Cabin unit names this texture is meant for (suitable_for[]); empty = all cabins. */
  cabinUnits: string[];
  layers: Layer[];
  /** Optional UV template image (shown as overlay only, never exported). */
  template: string | null;
}

export interface PaletteColor {
  id: string;
  name: string;
  hex: string;
}

export interface ModSettings {
  modId: string;
  displayName: string;
  author: string;
  version: string;
  description: string;
  price: number;
  unlockLevel: number;
  baseColor: string;
  baseColorLocked: boolean;
  alternateUvset: boolean;
  format: "rgba8" | "bc3";
  mipmaps: boolean;
  packaging: "folder" | "scs";
  outputDir: string;
}

export interface VehicleRef {
  id: string;
  vehicleType: string;
  name: string;
  /** Model shown in the 3D viewport */
  modelPath: string | null;
}

export interface Project {
  version: 1;
  name: string;
  textures: TextureDoc[];
  activeTextureId: string;
  palette: PaletteColor[];
  vehicle: VehicleRef | null;
  mod: ModSettings;
}
