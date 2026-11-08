// Freehand painting into raster layers (used by the 2D canvas and by 3D painting).

import { hexToCss } from "../color/color";
import { makeRaster } from "./factory";
import { getRasterCanvas, markRasterSynced, resolveColor } from "./render";
import { activeDoc, useEditor } from "./store";
import type { RasterLayer, V3 } from "./types";
import { getBaker, type Dab } from "../viewport/baker";

/** Returns the selected raster layer, or creates (and selects) a new one. */
export function ensureBrushLayer(): RasterLayer {
  const s = useEditor.getState();
  const doc = activeDoc(s.project);
  const sel = doc.layers.find((l) => s.selection.includes(l.id) && l.type === "raster") as RasterLayer | undefined;
  if (sel) return sel;
  const layer = makeRaster(doc);
  s.addLayer(layer, true);
  return layer;
}

export class BrushStroke {
  private ctx: CanvasRenderingContext2D;
  private last: { x: number; y: number } | null = null;
  private color: string;
  private size: number;
  private hardness: number;
  private opacity: number;
  private erase: boolean;
  private layer: RasterLayer;
  private raf = 0;

  constructor(erase: boolean) {
    const s = useEditor.getState();
    this.layer = ensureBrushLayer();
    s.checkpoint();
    const canvas = getRasterCanvas(this.layer);
    this.ctx = canvas.getContext("2d")!;
    this.erase = erase;
    this.color = resolveColor(s.primary, s.project.palette);
    this.size = s.brush.size;
    this.hardness = s.brush.hardness;
    this.opacity = s.brush.opacity;
  }

  /** Coordinates in document pixels. The raster layer may be transformed. */
  private toLayer(x: number, y: number) {
    const l = this.layer;
    const dx = x - l.x, dy = y - l.y;
    const a = (-l.rotation * Math.PI) / 180;
    const rx = dx * Math.cos(a) - dy * Math.sin(a);
    const ry = dx * Math.sin(a) + dy * Math.cos(a);
    return { x: rx / l.scaleX + l.w / 2, y: ry / l.scaleY + l.h / 2 };
  }

  private stamp(x: number, y: number) {
    const r = this.size / 2;
    const ctx = this.ctx;
    ctx.save();
    ctx.globalCompositeOperation = this.erase ? "destination-out" : "source-over";
    ctx.globalAlpha = this.opacity;
    if (this.hardness >= 0.99) {
      ctx.fillStyle = this.erase ? "#000" : hexToCss(this.color);
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
    } else {
      const g = ctx.createRadialGradient(x, y, 0, x, y, r);
      const solid = this.erase ? "rgba(0,0,0,1)" : hexToCss(this.color);
      const clear = this.erase ? "rgba(0,0,0,0)" : hexToCss(this.color, 0);
      g.addColorStop(0, solid);
      g.addColorStop(Math.max(0, Math.min(0.99, this.hardness)), solid);
      g.addColorStop(1, clear);
      ctx.fillStyle = g;
      ctx.fillRect(x - r, y - r, r * 2, r * 2);
    }
    ctx.restore();
  }

  private scheduleRender() {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      useEditor.getState().bumpRender();
    });
  }

  /** Add a point. `connect=false` starts a new segment (e.g. after jumping across a UV seam). */
  add(docX: number, docY: number, connect = true) {
    const p = this.toLayer(docX, docY);
    if (!this.last || !connect) {
      this.stamp(p.x, p.y);
    } else {
      const dx = p.x - this.last.x, dy = p.y - this.last.y;
      const dist = Math.hypot(dx, dy);
      const step = Math.max(1, this.size * 0.12);
      const n = Math.floor(dist / step);
      for (let i = 1; i <= n; i++) this.stamp(this.last.x + (dx * i) / n, this.last.y + (dy * i) / n);
    }
    this.last = p;
    this.scheduleRender();
  }

  async end() {
    const canvas = this.ctx.canvas;
    const blob: Blob | null = await new Promise((res) => canvas.toBlob(res, "image/png"));
    if (!blob) return;
    const src: string = await new Promise((res) => {
      const fr = new FileReader();
      fr.onload = () => res(fr.result as string);
      fr.readAsDataURL(blob);
    });
    markRasterSynced(this.layer.id, src);
    useEditor.getState().updateLayer(this.layer.id, { src }, false);
  }
}

// ---------------------------------------------------------------------------
// 3D brush: dabs are spheres on the model surface, baked into the raster layer
// through the GPU baker → strokes continue seamlessly across UV seams.
// ---------------------------------------------------------------------------

export class Brush3DStroke {
  private layer: RasterLayer;
  private pending: Dab[] = [];
  private last: V3 | null = null;
  private raf = 0;
  private erase: boolean;
  private radius: number;

  constructor(erase: boolean) {
    const s = useEditor.getState();
    this.layer = ensureBrushLayer();
    s.checkpoint();
    this.erase = erase;
    this.radius = (s.brush.size * 0.001) / 2; // brush size is in millimetres in 3D
  }

  add(p: V3, n: V3) {
    const step = Math.max(0.0005, this.radius * 0.3);
    if (this.last) {
      const d = Math.hypot(p[0] - this.last[0], p[1] - this.last[1], p[2] - this.last[2]);
      if (d < step) return;
      // Interpolate across fast moves (but not across huge jumps, e.g. to another panel).
      if (d < this.radius * 12) {
        const k = Math.floor(d / step);
        for (let i = 1; i < k; i++) {
          const t = i / k;
          this.pending.push({ p: [this.last[0] + (p[0] - this.last[0]) * t, this.last[1] + (p[1] - this.last[1]) * t, this.last[2] + (p[2] - this.last[2]) * t], n, r: this.radius });
        }
      }
    }
    this.pending.push({ p, n, r: this.radius });
    this.last = p;
    this.schedule();
  }

  private schedule() {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      this.flush();
    });
  }

  private flush() {
    if (!this.pending.length) return;
    const s = useEditor.getState();
    const dabs = this.pending;
    this.pending = [];
    const canvas = getRasterCanvas(this.layer);
    getBaker().paintDabs(canvas, this.layer, dabs, resolveColor(s.primary, s.project.palette), s.brush.hardness, s.brush.opacity, this.erase, s.symmetry);
    s.bumpRender();
  }

  async end() {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.flush();
    const canvas = getRasterCanvas(this.layer);
    const blob: Blob | null = await new Promise((res) => canvas.toBlob(res, "image/png"));
    if (!blob) return;
    const src: string = await new Promise((res) => {
      const fr = new FileReader();
      fr.onload = () => res(fr.result as string);
      fr.readAsDataURL(blob);
    });
    markRasterSynced(this.layer.id, src);
    useEditor.getState().updateLayer(this.layer.id, { src }, false);
  }
}
