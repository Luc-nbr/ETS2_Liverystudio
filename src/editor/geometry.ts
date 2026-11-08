import type { Layer, ShapeGeometry, TextLayer, Vec2 } from "./types";

export const DEG = Math.PI / 180;

/** Catmull-Rom → dense polyline. */
export function smoothPolyline(pts: Vec2[], closed: boolean, segments = 12): Vec2[] {
  if (pts.length < 3) return pts.slice();
  const out: Vec2[] = [];
  const n = pts.length;
  const get = (i: number) => {
    if (closed) return pts[(i + n) % n];
    return pts[Math.max(0, Math.min(n - 1, i))];
  };
  const last = closed ? n : n - 1;
  for (let i = 0; i < last; i++) {
    const p0 = get(i - 1), p1 = get(i), p2 = get(i + 1), p3 = get(i + 2);
    for (let s = 0; s < segments; s++) {
      const t = s / segments, t2 = t * t, t3 = t2 * t;
      out.push({
        x: 0.5 * (2 * p1.x + (-p0.x + p2.x) * t + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3),
        y: 0.5 * (2 * p1.y + (-p0.y + p2.y) * t + (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 + (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3),
      });
    }
  }
  if (!closed) out.push(pts[n - 1]);
  return out;
}

/** Offsets a polyline sideways by `d` (positive = left of travel direction) with mitre joins. */
export function offsetPolyline(pts: Vec2[], d: number, closed: boolean): Vec2[] {
  const n = pts.length;
  if (n < 2 || d === 0) return pts.slice();
  const normals: Vec2[] = [];
  const segCount = closed ? n : n - 1;
  for (let i = 0; i < segCount; i++) {
    const a = pts[i], b = pts[(i + 1) % n];
    const dx = b.x - a.x, dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    normals.push({ x: -dy / len, y: dx / len });
  }
  const out: Vec2[] = [];
  for (let i = 0; i < n; i++) {
    let nPrev: Vec2 | undefined, nNext: Vec2 | undefined;
    if (closed) {
      nPrev = normals[(i - 1 + segCount) % segCount];
      nNext = normals[i % segCount];
    } else {
      nPrev = i > 0 ? normals[i - 1] : undefined;
      nNext = i < segCount ? normals[i] : undefined;
    }
    const a = nPrev ?? nNext!, b = nNext ?? nPrev!;
    let mx = a.x + b.x, my = a.y + b.y;
    const ml = Math.hypot(mx, my);
    if (ml < 1e-6) {
      mx = b.x;
      my = b.y;
    } else {
      mx /= ml;
      my /= ml;
    }
    const cos = mx * b.x + my * b.y;
    const scale = 1 / Math.max(cos, 0.25); // limit mitre length
    out.push({ x: pts[i].x + mx * d * scale, y: pts[i].y + my * d * scale });
  }
  return out;
}

/** Build a Path2D for a shape in local coordinates. */
export function shapePath(g: ShapeGeometry): Path2D {
  const p = new Path2D();
  switch (g.kind) {
    case "rect": {
      const r = Math.max(0, Math.min(g.radius, Math.abs(g.w) / 2, Math.abs(g.h) / 2));
      if (r > 0 && "roundRect" in p) p.roundRect(-g.w / 2, -g.h / 2, g.w, g.h, r);
      else p.rect(-g.w / 2, -g.h / 2, g.w, g.h);
      break;
    }
    case "ellipse":
      p.ellipse(0, 0, Math.abs(g.w / 2), Math.abs(g.h / 2), 0, 0, Math.PI * 2);
      break;
    case "polygon": {
      const n = Math.max(3, Math.round(g.sides));
      for (let i = 0; i < n; i++) {
        const a = -Math.PI / 2 + (i / n) * Math.PI * 2;
        const x = Math.cos(a) * g.w / 2, y = Math.sin(a) * g.h / 2;
        if (i === 0) p.moveTo(x, y);
        else p.lineTo(x, y);
      }
      p.closePath();
      break;
    }
    case "star": {
      const n = Math.max(3, Math.round(g.points));
      for (let i = 0; i < n * 2; i++) {
        const a = -Math.PI / 2 + (i / (n * 2)) * Math.PI * 2;
        const f = i % 2 === 0 ? 1 : g.inner;
        const x = Math.cos(a) * g.w / 2 * f, y = Math.sin(a) * g.h / 2 * f;
        if (i === 0) p.moveTo(x, y);
        else p.lineTo(x, y);
      }
      p.closePath();
      break;
    }
    case "path": {
      const pts = g.smooth ? smoothPolyline(g.points, g.closed) : g.points;
      pts.forEach((pt, i) => (i === 0 ? p.moveTo(pt.x, pt.y) : p.lineTo(pt.x, pt.y)));
      if (g.closed) p.closePath();
      break;
    }
  }
  return p;
}

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

function pointsBox(pts: Vec2[], pad = 0): Box {
  if (!pts.length) return { x: -1, y: -1, w: 2, h: 2 };
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of pts) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  return { x: minX - pad, y: minY - pad, w: maxX - minX + pad * 2, h: maxY - minY + pad * 2 };
}

let measureCtx: CanvasRenderingContext2D | null = null;
export function textFont(l: TextLayer): string {
  return `${l.italic ? "italic " : ""}${l.bold ? "700 " : "400 "}${l.fontSize}px ${l.fontFamily}`;
}
export function measureText(l: TextLayer): { w: number; h: number; lines: string[] } {
  if (!measureCtx) measureCtx = document.createElement("canvas").getContext("2d");
  const ctx = measureCtx!;
  ctx.font = textFont(l);
  (ctx as unknown as { letterSpacing: string }).letterSpacing = `${l.letterSpacing}px`;
  const lines = l.text.split("\n");
  const w = Math.max(1, ...lines.map((ln) => ctx.measureText(ln).width));
  const h = lines.length * l.fontSize * l.lineHeight;
  return { w, h, lines };
}

/** Local (untransformed) bounding box of a layer's content. */
export function localBounds(layer: Layer, docW: number, docH: number): Box {
  switch (layer.type) {
    case "shape": {
      const g = layer.geometry;
      const sw = layer.stroke ? layer.stroke.width / 2 : 0;
      if (g.kind === "path") return pointsBox(g.smooth ? smoothPolyline(g.points, g.closed) : g.points, sw);
      return { x: -Math.abs(g.w) / 2 - sw, y: -Math.abs(g.h) / 2 - sw, w: Math.abs(g.w) + sw * 2, h: Math.abs(g.h) + sw * 2 };
    }
    case "stripes": {
      const total = stripesTotalWidth(layer.stripes, layer.gap);
      return pointsBox(layer.smooth ? smoothPolyline(layer.points, layer.closed) : layer.points, total / 2);
    }
    case "text": {
      const m = measureText(layer);
      const x = layer.align === "left" || layer.align === "start" ? 0 : layer.align === "right" || layer.align === "end" ? -m.w : -m.w / 2;
      return { x, y: -m.h / 2, w: m.w, h: m.h };
    }
    case "image":
    case "raster":
      return { x: -layer.w / 2, y: -layer.h / 2, w: layer.w, h: layer.h };
    case "fill":
      return { x: -docW / 2, y: -docH / 2, w: docW, h: docH };
    case "surfaceLine":
      return { x: -1, y: -1, w: 2, h: 2 };
  }
}

export function stripesTotalWidth(stripes: { width: number }[], gap: number): number {
  return stripes.reduce((s, st) => s + st.width, 0) + gap * Math.max(0, stripes.length - 1);
}

/** document → local coordinates of a layer */
export function toLocal(layer: Layer, p: Vec2): Vec2 {
  const dx = p.x - layer.x, dy = p.y - layer.y;
  const c = Math.cos(-layer.rotation * DEG), s = Math.sin(-layer.rotation * DEG);
  const rx = dx * c - dy * s, ry = dx * s + dy * c;
  return { x: rx / (layer.scaleX || 1e-6), y: ry / (layer.scaleY || 1e-6) };
}

/** local → document coordinates of a layer */
export function toDoc(layer: Layer, p: Vec2): Vec2 {
  const sx = p.x * layer.scaleX, sy = p.y * layer.scaleY;
  const c = Math.cos(layer.rotation * DEG), s = Math.sin(layer.rotation * DEG);
  return { x: layer.x + sx * c - sy * s, y: layer.y + sx * s + sy * c };
}

export function hitTest(layer: Layer, p: Vec2, docW: number, docH: number, tolerance = 0): boolean {
  // backgrounds are selected via the layer panel; projected layers are picked in 3D
  if (layer.type === "fill" || layer.type === "surfaceLine" || layer.projection) return false;
  const l = toLocal(layer, p);
  const b = localBounds(layer, docW, docH);
  const tx = tolerance / Math.abs(layer.scaleX || 1), ty = tolerance / Math.abs(layer.scaleY || 1);
  return l.x >= b.x - tx && l.x <= b.x + b.w + tx && l.y >= b.y - ty && l.y <= b.y + b.h + ty;
}

/** Four corners of the layer's bounds in document coordinates (tl, tr, br, bl). */
export function docCorners(layer: Layer, docW: number, docH: number): Vec2[] {
  const b = localBounds(layer, docW, docH);
  return [
    { x: b.x, y: b.y },
    { x: b.x + b.w, y: b.y },
    { x: b.x + b.w, y: b.y + b.h },
    { x: b.x, y: b.y + b.h },
  ].map((p) => toDoc(layer, p));
}

/** Re-centre a point list around its centroid; returns new points + centroid offset. */
export function recenter(points: Vec2[]): { points: Vec2[]; cx: number; cy: number } {
  const b = pointsBox(points);
  const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
  return { points: points.map((p) => ({ x: p.x - cx, y: p.y - cy })), cx, cy };
}

export const isPow2 = (n: number) => n > 0 && (n & (n - 1)) === 0;

/**
 * Scale a layer by dragging one of its bound corners (0=tl,1=tr,2=br,3=bl) to point p,
 * keeping the opposite corner fixed. Works in doc space and in decal plane space.
 */
export function scaleByCorner(layer: Layer, docW: number, docH: number, corner: number, p: Vec2, uniform: boolean): Partial<Layer> {
  const b = localBounds(layer, docW, docH);
  const cs = [
    { x: b.x, y: b.y },
    { x: b.x + b.w, y: b.y },
    { x: b.x + b.w, y: b.y + b.h },
    { x: b.x, y: b.y + b.h },
  ];
  const C = cs[corner], A = cs[(corner + 2) % 4];
  const Lp = toLocal(layer, p);
  let fx = (Lp.x - A.x) / (C.x - A.x || 1);
  let fy = (Lp.y - A.y) / (C.y - A.y || 1);
  if (uniform) {
    const f = Math.max(Math.abs(fx), Math.abs(fy));
    fx = Math.sign(fx || 1) * f;
    fy = Math.sign(fy || 1) * f;
  }
  const sx = layer.scaleX * fx, sy = layer.scaleY * fy;
  const anchor = toDoc(layer, A);
  const c = Math.cos(layer.rotation * DEG), s = Math.sin(layer.rotation * DEG);
  const ax = A.x * sx, ay = A.y * sy;
  return { scaleX: sx, scaleY: sy, x: anchor.x - (ax * c - ay * s), y: anchor.y - (ax * s + ay * c) };
}

export function normalizeAngle(deg: number) {
  return ((deg % 360) + 540) % 360 - 180;
}
