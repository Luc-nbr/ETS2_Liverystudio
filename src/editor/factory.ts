import type {
  FillLayer,
  ImageLayer,
  Layer,
  LayerBase,
  ModSettings,
  Paint,
  PaletteColor,
  Projection,
  SurfaceLineLayer,
  SurfacePoint,
  V3,
  Project,
  RasterLayer,
  ShapeGeometry,
  ShapeLayer,
  StripeDef,
  StripesLayer,
  TextLayer,
  TextureDoc,
  Vec2,
} from "./types";

let counter = 0;
export const uid = (prefix = "id"): string =>
  `${prefix}_${Date.now().toString(36)}${(counter++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;

export const solid = (color: string): Paint => ({ type: "solid", color });

function base(name: string, x: number, y: number): LayerBase {
  return {
    id: uid("layer"),
    name,
    visible: true,
    locked: false,
    opacity: 1,
    blend: "source-over",
    x,
    y,
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
    shadow: null,
    clip: false,
    projection: null,
  };
}

/** Default projection settings for a decal placed at a surface point. */
export function makeProjection(origin: V3, normal: V3, up: V3, mirror: boolean): Projection {
  return { origin, normal, up, unitsPerPx: 0.001, depth: 0.35, maxAngle: 80, mirror, mirrorReadable: true };
}

export function makeSurfaceLine(points: SurfacePoint[], stripes: StripeDef[], gap: number, mirror: boolean): SurfaceLineLayer {
  return {
    ...base("Lijnontwerp 3D", 0, 0),
    type: "surfaceLine",
    points,
    smooth: true,
    stripes: stripes.map((s) => ({ ...s })),
    gap,
    cap: "butt",
    dash: [],
    mirror,
  };
}

const SHAPE_NAMES: Record<ShapeGeometry["kind"], string> = {
  rect: "Rechthoek",
  ellipse: "Ellips",
  polygon: "Veelhoek",
  star: "Ster",
  path: "Vorm",
};

export function makeShape(geometry: ShapeGeometry, x: number, y: number, fill: string): ShapeLayer {
  return {
    ...base(SHAPE_NAMES[geometry.kind], x, y),
    type: "shape",
    geometry,
    fill: solid(fill),
    stroke: null,
  };
}

export function makeStripes(points: Vec2[], x: number, y: number, stripes: StripeDef[]): StripesLayer {
  return {
    ...base("Lijnontwerp", x, y),
    type: "stripes",
    points,
    closed: false,
    smooth: true,
    stripes: stripes.map((s) => ({ ...s })),
    gap: 0,
    cap: "butt",
    dash: [],
  };
}

export function makeText(text: string, x: number, y: number, color: string, fontSize: number): TextLayer {
  return {
    ...base("Tekst", x, y),
    type: "text",
    text,
    fontFamily: "Arial Black, Arial, sans-serif",
    fontSize,
    bold: true,
    italic: false,
    letterSpacing: 0,
    lineHeight: 1.15,
    align: "center",
    fill: solid(color),
    stroke: null,
  };
}

export function makeImage(src: string, isSvg: boolean, w: number, h: number, x: number, y: number, name: string): ImageLayer {
  return { ...base(name, x, y), type: "image", src, isSvg, w, h, tint: null };
}

export function makeRaster(doc: TextureDoc, name = "Penseel"): RasterLayer {
  return { ...base(name, doc.width / 2, doc.height / 2), type: "raster", src: "", w: doc.width, h: doc.height };
}

export function makeFill(color: string, doc: TextureDoc): FillLayer {
  return { ...base("Achtergrond", doc.width / 2, doc.height / 2), type: "fill", fill: solid(color) };
}

export function makeTexture(name: string, width: number, height: number, background = "#ffffff"): TextureDoc {
  const doc: TextureDoc = {
    id: uid("tex"),
    name,
    width,
    height,
    cabinUnits: [],
    layers: [],
    template: null,
  };
  doc.layers.push(makeFill(background, doc));
  return doc;
}

export const DEFAULT_PALETTE: PaletteColor[] = [
  { id: "p_primary", name: "Primair", hex: "#0b3d91" },
  { id: "p_secondary", name: "Secundair", hex: "#f2a900" },
  { id: "p_accent", name: "Accent", hex: "#d7263d" },
  { id: "p_white", name: "Wit", hex: "#ffffff" },
  { id: "p_black", name: "Zwart", hex: "#111111" },
  { id: "p_silver", name: "Zilver", hex: "#c0c4c8" },
];

export const DEFAULT_MOD: ModSettings = {
  modId: "my_livery",
  displayName: "Mijn Livery",
  author: "",
  version: "1.0",
  description: "Gemaakt met ETS2 Livery Studio",
  price: 5000,
  unlockLevel: 0,
  baseColor: "#ffffff",
  baseColorLocked: true,
  alternateUvset: false,
  format: "rgba8",
  mipmaps: true,
  packaging: "scs",
  outputDir: "",
};

export function newProject(name = "Nieuw project", size = 4096): Project {
  const tex = makeTexture("cab_a", size, size);
  return {
    version: 1,
    name,
    textures: [tex],
    activeTextureId: tex.id,
    palette: DEFAULT_PALETTE.map((p) => ({ ...p })),
    vehicle: null,
    mod: { ...DEFAULT_MOD },
  };
}

/** Deep clone a layer and give it a new id. */
export function cloneLayer<T extends Layer>(layer: T): T {
  const copy = JSON.parse(JSON.stringify(layer)) as T;
  copy.id = uid("layer");
  copy.name = layer.name + " kopie";
  return copy;
}

export const STRIPE_PRESETS: { name: string; stripes: StripeDef[]; gap: number }[] = [
  { name: "Enkel", stripes: [{ color: "pal:p_primary", width: 60 }], gap: 0 },
  {
    name: "Duo",
    stripes: [
      { color: "pal:p_primary", width: 60 },
      { color: "pal:p_secondary", width: 30 },
    ],
    gap: 12,
  },
  {
    name: "Trio",
    stripes: [
      { color: "pal:p_primary", width: 50 },
      { color: "pal:p_secondary", width: 25 },
      { color: "pal:p_accent", width: 12 },
    ],
    gap: 10,
  },
  {
    name: "Racing",
    stripes: [
      { color: "pal:p_white", width: 14 },
      { color: "pal:p_accent", width: 80 },
      { color: "pal:p_white", width: 14 },
    ],
    gap: 0,
  },
  {
    name: "Regenboog",
    stripes: ["#e53935", "#fb8c00", "#fdd835", "#43a047", "#1e88e5", "#8e24aa"].map((c) => ({ color: c, width: 24 })),
    gap: 0,
  },
];
