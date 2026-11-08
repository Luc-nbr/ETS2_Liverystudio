// Rasterises a TextureDoc onto any 2D canvas context at any resolution.
// The caller sets up the base transform (document px → canvas px).

import { hexToCss } from "../color/color";
import { DEG, localBounds, measureText, offsetPolyline, shapePath, smoothPolyline, stripesTotalWidth, textFont, type Box } from "./geometry";
import type { ColorRef, Layer, Paint, PaletteColor, RasterLayer, Stroke, TextureDoc } from "./types";

type Ctx2D = CanvasRenderingContext2D;

// ---------------------------------------------------------------------------
// Async resource caches. When something finishes loading we call `invalidate`
// so the UI re-renders.
// ---------------------------------------------------------------------------

let invalidate: () => void = () => {};
export function setInvalidateCallback(fn: () => void) {
  invalidate = fn;
}

const imageCache = new Map<string, { img: HTMLImageElement; ready: boolean }>();

export function getImage(src: string): HTMLImageElement | null {
  let entry = imageCache.get(src);
  if (!entry) {
    const img = new Image();
    entry = { img, ready: false };
    imageCache.set(src, entry);
    const e = entry;
    img.onload = () => {
      e.ready = true;
      invalidate();
    };
    img.onerror = () => console.warn("Afbeelding kon niet geladen worden");
    img.src = src;
  }
  return entry.ready ? entry.img : null;
}

/** Wait until every image used by the doc is decoded (needed before exporting). */
export async function preloadDoc(doc: TextureDoc): Promise<void> {
  const waits: Promise<unknown>[] = [];
  for (const l of doc.layers) {
    if (l.type === "image") {
      getImage(l.src);
      const e = imageCache.get(l.src)!;
      if (!e.ready) waits.push(e.img.decode().then(() => (e.ready = true)).catch(() => undefined));
    }
    if (l.type === "raster" && l.src) waits.push(ensureRasterLoaded(l));
  }
  await Promise.all(waits);
}

interface RasterEntry {
  canvas: HTMLCanvasElement;
  src: string;
  loading: string | null;
}
const rasterCache = new Map<string, RasterEntry>();

/** The live, editable canvas backing a raster layer. */
export function getRasterCanvas(layer: RasterLayer): HTMLCanvasElement {
  let e = rasterCache.get(layer.id);
  if (!e || e.canvas.width !== layer.w || e.canvas.height !== layer.h) {
    const canvas = document.createElement("canvas");
    canvas.width = layer.w;
    canvas.height = layer.h;
    e = { canvas, src: "", loading: null };
    rasterCache.set(layer.id, e);
  }
  if (e.src !== layer.src && e.loading !== layer.src) {
    void ensureRasterLoaded(layer);
  }
  return e.canvas;
}

function ensureRasterLoaded(layer: RasterLayer): Promise<void> {
  const e = rasterCache.get(layer.id) ?? (getRasterCanvas(layer), rasterCache.get(layer.id)!);
  if (e.src === layer.src) return Promise.resolve();
  const target = layer.src;
  e.loading = target;
  if (!target) {
    e.canvas.getContext("2d")!.clearRect(0, 0, e.canvas.width, e.canvas.height);
    e.src = "";
    e.loading = null;
    invalidate();
    return Promise.resolve();
  }
  const img = new Image();
  return new Promise((resolve) => {
    img.onload = () => {
      if (e.loading === target) {
        const ctx = e.canvas.getContext("2d")!;
        ctx.clearRect(0, 0, e.canvas.width, e.canvas.height);
        ctx.drawImage(img, 0, 0, e.canvas.width, e.canvas.height);
        e.src = target;
        e.loading = null;
        invalidate();
      }
      resolve();
    };
    img.onerror = () => resolve();
    img.src = target;
  });
}

/** After painting directly into the raster canvas, record the src it now corresponds to. */
export function markRasterSynced(layerId: string, src: string) {
  const e = rasterCache.get(layerId);
  if (e) {
    e.src = src;
    e.loading = null;
  }
}

// ---------------------------------------------------------------------------
// Paint helpers
// ---------------------------------------------------------------------------

export function resolveColor(ref: ColorRef, palette: PaletteColor[]): string {
  if (ref.startsWith("pal:")) {
    const p = palette.find((c) => c.id === ref.slice(4));
    return p ? p.hex : "#ff00ff";
  }
  return ref;
}

function makeFillStyle(ctx: Ctx2D, paint: Paint, b: Box, palette: PaletteColor[]): string | CanvasGradient | null {
  switch (paint.type) {
    case "none":
      return null;
    case "solid":
      return hexToCss(resolveColor(paint.color, palette));
    case "linear": {
      const a = paint.angle * DEG;
      const dx = Math.cos(a), dy = Math.sin(a);
      const len = Math.abs(b.w * dx) + Math.abs(b.h * dy);
      const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
      const g = ctx.createLinearGradient(cx - (dx * len) / 2, cy - (dy * len) / 2, cx + (dx * len) / 2, cy + (dy * len) / 2);
      for (const s of paint.stops) g.addColorStop(Math.min(1, Math.max(0, s.offset)), hexToCss(resolveColor(s.color, palette)));
      return g;
    }
    case "radial": {
      const cx = b.x + b.w * paint.cx, cy = b.y + b.h * paint.cy;
      const r = Math.max(1, (Math.max(b.w, b.h) / 2) * paint.radius);
      const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
      for (const s of paint.stops) g.addColorStop(Math.min(1, Math.max(0, s.offset)), hexToCss(resolveColor(s.color, palette)));
      return g;
    }
  }
}

function applyStroke(ctx: Ctx2D, stroke: Stroke, b: Box, palette: PaletteColor[]): boolean {
  const style = makeFillStyle(ctx, stroke.paint, b, palette);
  if (!style || stroke.width <= 0) return false;
  ctx.strokeStyle = style;
  ctx.lineWidth = stroke.width;
  ctx.lineCap = stroke.cap;
  ctx.lineJoin = stroke.join;
  ctx.setLineDash(stroke.dash);
  return true;
}

function deviceScale(ctx: Ctx2D): number {
  const m = ctx.getTransform();
  return Math.sqrt(Math.abs(m.a * m.d - m.b * m.c)) || 1;
}

// ---------------------------------------------------------------------------
// Layer drawing (in local coordinates, transform already applied)
// ---------------------------------------------------------------------------

const tmpCanvases: HTMLCanvasElement[] = [];
function tmpCanvas(w: number, h: number, slot: number): HTMLCanvasElement {
  let c = tmpCanvases[slot];
  if (!c) {
    c = document.createElement("canvas");
    tmpCanvases[slot] = c;
  }
  if (c.width !== w || c.height !== h) {
    c.width = w;
    c.height = h;
  } else {
    c.getContext("2d")!.clearRect(0, 0, w, h);
  }
  return c;
}

function drawLayerContent(ctx: Ctx2D, layer: Layer, doc: TextureDoc, palette: PaletteColor[]) {
  const b = localBounds(layer, doc.width, doc.height);
  switch (layer.type) {
    case "fill": {
      const style = makeFillStyle(ctx, layer.fill, b, palette);
      if (style) {
        ctx.fillStyle = style;
        ctx.fillRect(b.x, b.y, b.w, b.h);
      }
      break;
    }
    case "shape": {
      const path = shapePath(layer.geometry);
      const fillable = !(layer.geometry.kind === "path" && !layer.geometry.closed);
      const style = fillable ? makeFillStyle(ctx, layer.fill, b, palette) : null;
      if (style) {
        ctx.fillStyle = style;
        ctx.fill(path, "nonzero");
      }
      if (layer.stroke && applyStroke(ctx, layer.stroke, b, palette)) {
        ctx.shadowColor = "transparent";
        ctx.stroke(path);
      }
      break;
    }
    case "stripes": {
      const center = layer.smooth ? smoothPolyline(layer.points, layer.closed, 16) : layer.points;
      if (center.length < 2) break;
      const total = stripesTotalWidth(layer.stripes, layer.gap);
      let cursor = -total / 2;
      ctx.lineJoin = "round";
      ctx.lineCap = layer.cap;
      ctx.setLineDash(layer.dash);
      for (const st of layer.stripes) {
        const off = cursor + st.width / 2;
        cursor += st.width + layer.gap;
        if (st.width <= 0) continue;
        const pts = offsetPolyline(center, off, layer.closed);
        ctx.beginPath();
        pts.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
        if (layer.closed) ctx.closePath();
        ctx.strokeStyle = hexToCss(resolveColor(st.color, palette));
        ctx.lineWidth = st.width + 0.75; // tiny overlap → no hairline gaps between stripes
        ctx.stroke();
      }
      ctx.setLineDash([]);
      break;
    }
    case "text": {
      const m = measureText(layer);
      ctx.font = textFont(layer);
      (ctx as unknown as { letterSpacing: string }).letterSpacing = `${layer.letterSpacing}px`;
      ctx.textAlign = layer.align;
      ctx.textBaseline = "middle";
      const lh = layer.fontSize * layer.lineHeight;
      const fillStyle = makeFillStyle(ctx, layer.fill, b, palette);
      m.lines.forEach((line, i) => {
        const y = -m.h / 2 + lh / 2 + i * lh;
        if (layer.stroke && applyStroke(ctx, layer.stroke, b, palette)) ctx.strokeText(line, 0, y);
        if (fillStyle) {
          ctx.fillStyle = fillStyle;
          ctx.fillText(line, 0, y);
        }
      });
      (ctx as unknown as { letterSpacing: string }).letterSpacing = "0px";
      break;
    }
    case "image": {
      const img = getImage(layer.src);
      if (!img) break;
      if (layer.tint) {
        const s = deviceScale(ctx);
        const tw = Math.max(1, Math.min(8192, Math.round(Math.abs(layer.w * s))));
        const th = Math.max(1, Math.min(8192, Math.round(Math.abs(layer.h * s))));
        const c = tmpCanvas(tw, th, 0);
        const tctx = c.getContext("2d")!;
        tctx.globalCompositeOperation = "source-over";
        tctx.drawImage(img, 0, 0, tw, th);
        tctx.globalCompositeOperation = "source-in";
        tctx.fillStyle = hexToCss(resolveColor(layer.tint, palette));
        tctx.fillRect(0, 0, tw, th);
        tctx.globalCompositeOperation = "source-over";
        ctx.drawImage(c, -layer.w / 2, -layer.h / 2, layer.w, layer.h);
      } else {
        ctx.drawImage(img, -layer.w / 2, -layer.h / 2, layer.w, layer.h);
      }
      break;
    }
    case "surfaceLine":
      break; // only drawn through the 3D baker
    case "raster": {
      if (!layer.src && !rasterCache.has(layer.id)) break;
      const c = getRasterCanvas(layer);
      ctx.drawImage(c, -layer.w / 2, -layer.h / 2, layer.w, layer.h);
      break;
    }
  }
}

/** Draws a layer's 2D content with its own transform (UV space, or plane space for decals). */
export function drawLayer(ctx: Ctx2D, layer: Layer, doc: TextureDoc, palette: PaletteColor[], alpha: number, blend: GlobalCompositeOperation) {
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.globalCompositeOperation = blend;
  if (layer.shadow) {
    const s = deviceScale(ctx);
    ctx.shadowColor = hexToCss(resolveColor(layer.shadow.color, palette));
    ctx.shadowBlur = layer.shadow.blur * s;
    ctx.shadowOffsetX = layer.shadow.offsetX * s;
    ctx.shadowOffsetY = layer.shadow.offsetY * s;
  }
  ctx.translate(layer.x, layer.y);
  ctx.rotate(layer.rotation * DEG);
  ctx.scale(layer.scaleX, layer.scaleY);
  drawLayerContent(ctx, layer, doc, palette);
  ctx.restore();
}

export interface RenderOptions {
  /** Layers to skip (e.g. while previewing a drag). */
  hidden?: Set<string>;
  /** Width (px) at which projected layers are baked (default: preview width). */
  bakeWidth?: number;
  /** Export: re-rasterise vectors at full quality and bypass the preview cache. */
  exportQuality?: boolean;
}

/**
 * Hook installed by the 3D baker: draws a projected layer / surface line (already baked into
 * UV space) onto ctx in document coordinates. Returns false when no 3D model is available.
 */
type ProjectionHook = (ctx: Ctx2D, layer: Layer, doc: TextureDoc, palette: PaletteColor[], bakeWidth: number, exportQuality: boolean) => boolean;
let projectionHook: ProjectionHook | null = null;
export function setProjectionHook(h: ProjectionHook) {
  projectionHook = h;
}

export const isProjected = (l: Layer) => l.type === "surfaceLine" || (!!l.projection && l.type !== "fill" && l.type !== "raster");

/** Default preview bake width for a doc. */
export const previewBakeWidth = (doc: TextureDoc) => Math.min(doc.width, 2048);

function drawAny(ctx: Ctx2D, layer: Layer, doc: TextureDoc, palette: PaletteColor[], alpha: number, blend: GlobalCompositeOperation, opts: RenderOptions) {
  if (isProjected(layer)) {
    if (!projectionHook) return;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.globalCompositeOperation = blend;
    projectionHook(ctx, layer, doc, palette, opts.bakeWidth ?? previewBakeWidth(doc), !!opts.exportQuality);
    ctx.restore();
    return;
  }
  drawLayer(ctx, layer, doc, palette, alpha, blend);
}

/**
 * Renders all visible layers. Clipping layers (layer.clip) are composited onto the
 * nearest non-clipping layer below them through an intermediate canvas.
 */
export function renderDoc(ctx: Ctx2D, doc: TextureDoc, palette: PaletteColor[], opts: RenderOptions = {}) {
  const layers = doc.layers;
  const visible = (l: Layer) => l.visible && !opts.hidden?.has(l.id);
  let i = 0;
  while (i < layers.length) {
    const baseLayer = layers[i];
    let j = i + 1;
    while (j < layers.length && layers[j].clip) j++;
    const clipped = layers.slice(i + 1, j).filter(visible);
    if (!visible(baseLayer)) {
      i = j;
      continue;
    }
    if (clipped.length === 0 || baseLayer.clip) {
      drawAny(ctx, baseLayer, doc, palette, baseLayer.opacity, baseLayer.blend, opts);
    } else {
      const w = ctx.canvas.width, h = ctx.canvas.height;
      const c = tmpCanvas(w, h, 1);
      const g = c.getContext("2d")!;
      g.setTransform(ctx.getTransform());
      drawAny(g, baseLayer, doc, palette, 1, "source-over", opts);
      for (const cl of clipped) drawAny(g, cl, doc, palette, cl.opacity, "source-atop", opts);
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalAlpha = baseLayer.opacity;
      ctx.globalCompositeOperation = baseLayer.blend;
      ctx.drawImage(c, 0, 0);
      ctx.restore();
    }
    i = j;
  }
}

/** Renders a doc into a fresh canvas of the given size (export / thumbnails / 3D texture). */
export function renderToCanvas(doc: TextureDoc, palette: PaletteColor[], width: number, height: number, target?: HTMLCanvasElement, opts: RenderOptions = {}): HTMLCanvasElement {
  const c = target ?? document.createElement("canvas");
  if (c.width !== width) c.width = width;
  if (c.height !== height) c.height = height;
  const ctx = c.getContext("2d")!;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, width, height);
  ctx.setTransform(width / doc.width, 0, 0, height / doc.height, 0, 0);
  ctx.imageSmoothingQuality = "high";
  renderDoc(ctx, doc, palette, { bakeWidth: width, ...opts });
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  return c;
}

export function canvasToPngBlob(c: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => c.toBlob((b) => (b ? resolve(b) : reject(new Error("PNG-encodering mislukt"))), "image/png"));
}
