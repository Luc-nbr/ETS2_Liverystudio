import { create } from "zustand";
import type { GameIndex, Installation, ModelData } from "../lib/api";
import { cloneLayer, newProject, uid } from "./factory";
import type { ColorRef, Layer, Paint, PaletteColor, Project, TextureDoc } from "./types";

export type Tool =
  | "select"
  | "nodes"
  | "hand"
  | "rect"
  | "ellipse"
  | "polygon"
  | "star"
  | "path"
  | "stripes"
  | "text"
  | "brush"
  | "eraser"
  | "eyedropper";

export type ViewportMode = "orbit" | "paint" | "place";
export type Layout = "split" | "3d";

export interface UvState {
  channel: number;
  channelsAvailable: number;
  flipV: boolean;
  /** Line segments (x1,y1,x2,y2 …) in UV space 0..1 of the paintable parts. */
  segments: Float32Array | null;
}

export interface GameState {
  installations: Installation[];
  index: GameIndex | null;
  loading: string | null;
  error: string | null;
  model: ModelData | null;
}

export interface EditorState {
  project: Project;
  projectPath: string | null;
  dirty: boolean;
  past: Project[];
  future: Project[];
  selection: string[];
  tool: Tool;
  primary: ColorRef;
  secondary: ColorRef;
  recent: string[];
  brush: { size: number; hardness: number; opacity: number };
  shapeOpts: { sides: number; points: number; inner: number; radius: number; strokeWidth: number; withStroke: boolean };
  stripePreset: number;
  view: { zoom: number; panX: number; panY: number; fitRequest: number };
  showUv: boolean;
  showTemplate: boolean;
  showGrid: boolean;
  snap: boolean;
  gridSize: number;
  uv: UvState;
  viewportMode: ViewportMode;
  layout: Layout;
  /** Mirror new 3D layers and brush strokes to the other (left/right) side. */
  symmetry: boolean;
  /** Orientation of new decals: surface normal, or the camera's viewing direction. */
  projectFrom: "surface" | "view";
  /** Changes whenever the 3D paint mesh is replaced (see viewport/state.ts). */
  meshVersion: number;
  /** Material indices treated as paintable (null = auto-detect "truckpaint"). */
  paintableOverride: number[] | null;
  renderVersion: number;
  game: GameState;
  toast: { text: string; kind: "info" | "error" } | null;

  // --- actions -----------------------------------------------------------
  setProject: (p: Project, path?: string | null) => void;
  checkpoint: () => void;
  undo: () => void;
  redo: () => void;
  updateLayer: (id: string, patch: Partial<Layer>, history?: boolean) => void;
  mapLayers: (ids: string[], fn: (l: Layer) => Layer, history?: boolean) => void;
  addLayer: (layer: Layer, select?: boolean) => void;
  removeLayers: (ids: string[]) => void;
  duplicateLayers: (ids: string[]) => void;
  moveLayer: (id: string, toIndex: number) => void;
  shiftLayers: (ids: string[], dir: "up" | "down" | "top" | "bottom") => void;
  select: (ids: string[], additive?: boolean) => void;
  setActiveTexture: (id: string) => void;
  addTexture: (doc: TextureDoc) => void;
  updateTexture: (id: string, patch: Partial<TextureDoc>, history?: boolean) => void;
  removeTexture: (id: string) => void;
  updateProject: (patch: Partial<Project>, history?: boolean) => void;
  addPaletteColor: (hex: string, name?: string) => string;
  updatePaletteColor: (id: string, patch: Partial<PaletteColor>) => void;
  removePaletteColor: (id: string) => void;
  replaceColor: (from: string, to: ColorRef, allTextures: boolean) => number;
  setPrimary: (c: ColorRef) => void;
  setSecondary: (c: ColorRef) => void;
  swapColors: () => void;
  applyColorToSelection: (c: ColorRef, target: "fill" | "stroke") => void;
  set: (patch: Partial<EditorState>) => void;
  setGame: (patch: Partial<GameState>) => void;
  notify: (text: string, kind?: "info" | "error") => void;
  bumpRender: () => void;
}

const HISTORY_LIMIT = 150;

export const activeDoc = (p: Project): TextureDoc => p.textures.find((t) => t.id === p.activeTextureId) ?? p.textures[0];

function withDoc(p: Project, fn: (d: TextureDoc) => TextureDoc): Project {
  return { ...p, textures: p.textures.map((t) => (t.id === p.activeTextureId ? fn(t) : t)) };
}

function mapPaintColors(paint: Paint, fn: (c: ColorRef) => ColorRef): Paint {
  switch (paint.type) {
    case "none":
      return paint;
    case "solid":
      return { ...paint, color: fn(paint.color) };
    default:
      return { ...paint, stops: paint.stops.map((s) => ({ ...s, color: fn(s.color) })) };
  }
}

/** Applies fn to every colour reference inside a layer. */
export function mapLayerColors(l: Layer, fn: (c: ColorRef) => ColorRef): Layer {
  const shadow = l.shadow ? { ...l.shadow, color: fn(l.shadow.color) } : null;
  switch (l.type) {
    case "fill":
      return { ...l, shadow, fill: mapPaintColors(l.fill, fn) };
    case "shape":
    case "text":
      return {
        ...l,
        shadow,
        fill: mapPaintColors(l.fill, fn),
        stroke: l.stroke ? { ...l.stroke, paint: mapPaintColors(l.stroke.paint, fn) } : null,
      } as Layer;
    case "stripes":
      return { ...l, shadow, stripes: l.stripes.map((s) => ({ ...s, color: fn(s.color) })) };
    case "image":
      return { ...l, shadow, tint: l.tint ? fn(l.tint) : null };
    case "raster":
      return { ...l, shadow };
    case "surfaceLine":
      return { ...l, shadow, stripes: l.stripes.map((s) => ({ ...s, color: fn(s.color) })) };
  }
}

export const useEditor = create<EditorState>((set, get) => {
  /** Replace the project, optionally recording an undo step. */
  const commit = (next: Project, history: boolean) => {
    const { project, past } = get();
    if (history) {
      const np = past.length >= HISTORY_LIMIT ? past.slice(1) : past.slice();
      np.push(project);
      set({ project: next, past: np, future: [], dirty: true });
    } else {
      set({ project: next, dirty: true });
    }
  };

  return {
    project: newProject(),
    projectPath: null,
    dirty: false,
    past: [],
    future: [],
    selection: [],
    tool: "select",
    primary: "pal:p_primary",
    secondary: "pal:p_secondary",
    recent: [],
    brush: { size: 40, hardness: 0.8, opacity: 1 },
    shapeOpts: { sides: 6, points: 5, inner: 0.45, radius: 0, strokeWidth: 12, withStroke: false },
    stripePreset: 2,
    view: { zoom: 0.2, panX: 40, panY: 40, fitRequest: 1 },
    showUv: true,
    showTemplate: true,
    showGrid: false,
    snap: false,
    gridSize: 64,
    uv: { channel: 0, channelsAvailable: 1, flipV: false, segments: null },
    viewportMode: "orbit",
    layout: "split",
    symmetry: false,
    projectFrom: "surface",
    meshVersion: 0,
    paintableOverride: null,
    renderVersion: 0,
    game: { installations: [], index: null, loading: null, error: null, model: null },
    toast: null,

    setProject: (p, path = null) =>
      set((s) => ({ project: p, projectPath: path, past: [], future: [], selection: [], dirty: false, view: { ...s.view, fitRequest: s.view.fitRequest + 1 } })),

    checkpoint: () => commit(get().project, true),

    undo: () => {
      const { past, future, project } = get();
      if (!past.length) return;
      const prev = past[past.length - 1];
      set({ project: prev, past: past.slice(0, -1), future: [project, ...future], dirty: true });
    },
    redo: () => {
      const { past, future, project } = get();
      if (!future.length) return;
      set({ project: future[0], past: [...past, project], future: future.slice(1), dirty: true });
    },

    updateLayer: (id, patch, history = true) => {
      const next = withDoc(get().project, (d) => ({
        ...d,
        layers: d.layers.map((l) => (l.id === id ? ({ ...l, ...patch } as Layer) : l)),
      }));
      commit(next, history);
    },

    mapLayers: (ids, fn, history = true) => {
      const set_ = new Set(ids);
      const next = withDoc(get().project, (d) => ({ ...d, layers: d.layers.map((l) => (set_.has(l.id) ? fn(l) : l)) }));
      commit(next, history);
    },

    addLayer: (layer, select = true) => {
      const { project, selection } = get();
      const doc = activeDoc(project);
      const idx = doc.layers.reduce((m, l, i) => (selection.includes(l.id) ? Math.max(m, i) : m), -1);
      const at = idx >= 0 ? idx + 1 : doc.layers.length;
      const next = withDoc(project, (d) => {
        const layers = d.layers.slice();
        layers.splice(at, 0, layer);
        return { ...d, layers };
      });
      commit(next, true);
      if (select) set({ selection: [layer.id] });
    },

    removeLayers: (ids) => {
      if (!ids.length) return;
      const s = new Set(ids);
      commit(withDoc(get().project, (d) => ({ ...d, layers: d.layers.filter((l) => !s.has(l.id)) })), true);
      set({ selection: get().selection.filter((x) => !s.has(x)) });
    },

    duplicateLayers: (ids) => {
      if (!ids.length) return;
      const s = new Set(ids);
      const newIds: string[] = [];
      commit(
        withDoc(get().project, (d) => {
          const layers: Layer[] = [];
          for (const l of d.layers) {
            layers.push(l);
            if (s.has(l.id)) {
              const c = cloneLayer(l);
              if (c.type !== "fill" && c.type !== "raster") {
                c.x += 40;
                c.y += 40;
              }
              newIds.push(c.id);
              layers.push(c);
            }
          }
          return { ...d, layers };
        }),
        true,
      );
      set({ selection: newIds });
    },

    moveLayer: (id, toIndex) => {
      commit(
        withDoc(get().project, (d) => {
          const from = d.layers.findIndex((l) => l.id === id);
          if (from < 0) return d;
          const layers = d.layers.slice();
          const [l] = layers.splice(from, 1);
          layers.splice(Math.max(0, Math.min(layers.length, toIndex)), 0, l);
          return { ...d, layers };
        }),
        true,
      );
    },

    shiftLayers: (ids, dir) => {
      const s = new Set(ids);
      commit(
        withDoc(get().project, (d) => {
          let layers = d.layers.slice();
          if (dir === "top") layers = [...layers.filter((l) => !s.has(l.id)), ...layers.filter((l) => s.has(l.id))];
          else if (dir === "bottom") layers = [...layers.filter((l) => s.has(l.id)), ...layers.filter((l) => !s.has(l.id))];
          else if (dir === "up") {
            for (let i = layers.length - 2; i >= 0; i--)
              if (s.has(layers[i].id) && !s.has(layers[i + 1].id)) [layers[i], layers[i + 1]] = [layers[i + 1], layers[i]];
          } else {
            for (let i = 1; i < layers.length; i++)
              if (s.has(layers[i].id) && !s.has(layers[i - 1].id)) [layers[i], layers[i - 1]] = [layers[i - 1], layers[i]];
          }
          return { ...d, layers };
        }),
        true,
      );
    },

    select: (ids, additive = false) => {
      if (!additive) return set({ selection: ids });
      const cur = new Set(get().selection);
      for (const id of ids) {
        if (cur.has(id)) cur.delete(id);
        else cur.add(id);
      }
      set({ selection: [...cur] });
    },

    setActiveTexture: (id) =>
      set((s) => ({ project: { ...s.project, activeTextureId: id }, selection: [], view: { ...s.view, fitRequest: s.view.fitRequest + 1 } })),

    addTexture: (doc) => {
      const p = get().project;
      commit({ ...p, textures: [...p.textures, doc], activeTextureId: doc.id }, true);
      set((s) => ({ selection: [], view: { ...s.view, fitRequest: s.view.fitRequest + 1 } }));
    },

    updateTexture: (id, patch, history = true) => {
      const p = get().project;
      commit({ ...p, textures: p.textures.map((t) => (t.id === id ? { ...t, ...patch } : t)) }, history);
    },

    removeTexture: (id) => {
      const p = get().project;
      if (p.textures.length <= 1) return;
      const textures = p.textures.filter((t) => t.id !== id);
      commit({ ...p, textures, activeTextureId: p.activeTextureId === id ? textures[0].id : p.activeTextureId }, true);
      set({ selection: [] });
    },

    updateProject: (patch, history = false) => commit({ ...get().project, ...patch }, history),

    addPaletteColor: (hex, name) => {
      const p = get().project;
      const id = uid("pal");
      commit({ ...p, palette: [...p.palette, { id, name: name ?? `Kleur ${p.palette.length + 1}`, hex }] }, true);
      return id;
    },

    updatePaletteColor: (id, patch) => {
      const p = get().project;
      commit({ ...p, palette: p.palette.map((c) => (c.id === id ? { ...c, ...patch } : c)) }, false);
    },

    removePaletteColor: (id) => {
      const p = get().project;
      const color = p.palette.find((c) => c.id === id);
      if (!color) return;
      const ref = `pal:${id}`;
      const unlink = (c: ColorRef) => (c === ref ? color.hex : c);
      commit(
        {
          ...p,
          palette: p.palette.filter((c) => c.id !== id),
          textures: p.textures.map((t) => ({ ...t, layers: t.layers.map((l) => mapLayerColors(l, unlink)) })),
        },
        true,
      );
      const s = get();
      if (s.primary === ref) set({ primary: color.hex });
      if (s.secondary === ref) set({ secondary: color.hex });
    },

    replaceColor: (from, to, allTextures) => {
      const p = get().project;
      const norm = from.toLowerCase();
      let count = 0;
      const fn = (c: ColorRef) => {
        if (c.toLowerCase() === norm) {
          count++;
          return to;
        }
        return c;
      };
      const textures = p.textures.map((t) =>
        allTextures || t.id === p.activeTextureId ? { ...t, layers: t.layers.map((l) => mapLayerColors(l, fn)) } : t,
      );
      if (count) commit({ ...p, textures }, true);
      return count;
    },

    setPrimary: (c) => {
      const recent = [c, ...get().recent.filter((x) => x !== c)].slice(0, 16);
      set({ primary: c, recent });
    },
    setSecondary: (c) => set({ secondary: c }),
    swapColors: () => set((s) => ({ primary: s.secondary, secondary: s.primary })),

    applyColorToSelection: (c, target) => {
      const { selection } = get();
      if (!selection.length) return;
      get().mapLayers(selection, (l) => {
        if (target === "stroke") {
          if (l.type === "shape" || l.type === "text") {
            const stroke = l.stroke ?? { paint: { type: "solid", color: c }, width: 8, dash: [], cap: "round", join: "round" };
            return { ...l, stroke: { ...stroke, paint: { type: "solid", color: c } } } as Layer;
          }
          return l;
        }
        switch (l.type) {
          case "shape":
          case "text":
          case "fill":
            return { ...l, fill: { type: "solid", color: c } } as Layer;
          case "image":
            return { ...l, tint: c };
          case "stripes":
          case "surfaceLine":
            return { ...l, stripes: l.stripes.map((s, i) => (i === 0 ? { ...s, color: c } : s)) } as Layer;
          default:
            return l;
        }
      });
    },

    set: (patch) => set(patch),
    setGame: (patch) => set((s) => ({ game: { ...s.game, ...patch } })),
    notify: (text, kind = "info") => {
      set({ toast: { text, kind } });
      window.setTimeout(() => {
        if (get().toast?.text === text) set({ toast: null });
      }, kind === "error" ? 8000 : 3500);
    },
    bumpRender: () => set((s) => ({ renderVersion: s.renderVersion + 1 })),
  };
});

export const useActiveDoc = () => useEditor((s) => activeDoc(s.project));
