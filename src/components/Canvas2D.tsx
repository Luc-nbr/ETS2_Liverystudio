// 2D texture (UV-space) editor: pan/zoom, selection & transform handles,
// shape/path/line-design/text creation, node editing, brush and eyedropper.

import { useCallback, useEffect, useRef, useState } from "react";
import { rgbaToHex } from "../color/color";
import { BrushStroke } from "../editor/brush";
import { STRIPE_PRESETS, makeShape, makeStripes, makeText } from "../editor/factory";
import { DEG, docCorners, hitTest, localBounds, recenter, smoothPolyline, toDoc, toLocal } from "../editor/geometry";
import { importImageFile } from "../editor/importers";
import { getImage, renderDoc } from "../editor/render";
import { activeDoc, useEditor } from "../editor/store";
import type { Layer, ShapeLayer, StripesLayer, TextureDoc, Vec2 } from "../editor/types";

type Drag =
  | { kind: "pan"; sx: number; sy: number; panX: number; panY: number }
  | { kind: "move"; start: Vec2; orig: Map<string, Vec2>; moved: boolean }
  | { kind: "scale"; layer: Layer; corner: number; moved: boolean }
  | { kind: "rotate"; layer: Layer; startAngle: number; moved: boolean }
  | { kind: "create"; id: string; start: Vec2 }
  | { kind: "node"; id: string; index: number; moved: boolean }
  | { kind: "brush"; stroke: BrushStroke };

const HANDLE = 7;

function layerPoints(l: Layer): Vec2[] | null {
  if (l.type === "stripes") return l.points;
  if (l.type === "shape" && l.geometry.kind === "path") return l.geometry.points;
  return null;
}

function withPoints(l: Layer, pts: Vec2[]): Partial<Layer> {
  if (l.type === "stripes") return { points: pts } as Partial<StripesLayer>;
  if (l.type === "shape" && l.geometry.kind === "path") return { geometry: { ...l.geometry, points: pts } } as Partial<ShapeLayer>;
  return {};
}

export function Canvas2D() {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const dragRef = useRef<Drag | null>(null);
  const draftRef = useRef<Vec2[]>([]);
  const hoverRef = useRef<Vec2 | null>(null);
  const spaceRef = useRef(false);
  const [size, setSize] = useState({ w: 800, h: 600 });
  const [cursor, setCursor] = useState("default");
  const rafRef = useRef(0);
  const uvPathRef = useRef<{ seg: Float32Array | null; w: number; h: number; flip: boolean; path: Path2D | null }>({ seg: null, w: 0, h: 0, flip: false, path: null });

  // ---------------------------------------------------------------- helpers
  const screenToDoc = useCallback((sx: number, sy: number): Vec2 => {
    const { zoom, panX, panY } = useEditor.getState().view;
    return { x: (sx - panX) / zoom, y: (sy - panY) / zoom };
  }, []);
  const docToScreen = (p: Vec2): Vec2 => {
    const { zoom, panX, panY } = useEditor.getState().view;
    return { x: p.x * zoom + panX, y: p.y * zoom + panY };
  };
  const snapPt = (p: Vec2): Vec2 => {
    const s = useEditor.getState();
    if (!s.snap) return p;
    const g = s.gridSize;
    return { x: Math.round(p.x / g) * g, y: Math.round(p.y / g) * g };
  };

  // ---------------------------------------------------------------- drawing
  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d")!;
    const s = useEditor.getState();
    const doc = activeDoc(s.project);
    const dpr = window.devicePixelRatio || 1;
    const { zoom, panX, panY } = s.view;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = "#16181d";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // document area + checkerboard
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const tl = docToScreen({ x: 0, y: 0 });
    const dw = doc.width * zoom, dh = doc.height * zoom;
    ctx.save();
    ctx.beginPath();
    ctx.rect(tl.x, tl.y, dw, dh);
    ctx.clip();
    const cs = 12;
    ctx.fillStyle = "#3a3d44";
    ctx.fillRect(tl.x, tl.y, dw, dh);
    ctx.fillStyle = "#2b2e34";
    for (let y = Math.max(0, Math.floor(-tl.y / cs)) * cs; y < Math.min(dh, size.h - tl.y); y += cs)
      for (let x = Math.max(0, Math.floor(-tl.x / cs)) * cs + (((y / cs) & 1) ? cs : 0); x < Math.min(dw, size.w - tl.x); x += cs * 2)
        ctx.fillRect(tl.x + x, tl.y + y, cs, cs);

    ctx.setTransform(dpr * zoom, 0, 0, dpr * zoom, dpr * panX, dpr * panY);
    ctx.imageSmoothingQuality = "high";
    renderDoc(ctx, doc, s.project.palette);

    if (doc.template && s.showTemplate) {
      const img = getImage(doc.template);
      if (img) {
        ctx.globalAlpha = 0.55;
        ctx.drawImage(img, 0, 0, doc.width, doc.height);
        ctx.globalAlpha = 1;
      }
    }

    if (s.showUv && s.uv.segments) {
      const cache = uvPathRef.current;
      if (cache.seg !== s.uv.segments || cache.w !== doc.width || cache.h !== doc.height || cache.flip !== s.uv.flipV) {
        const p = new Path2D();
        const seg = s.uv.segments;
        for (let i = 0; i < seg.length; i += 4) {
          const v1 = s.uv.flipV ? 1 - seg[i + 1] : seg[i + 1];
          const v2 = s.uv.flipV ? 1 - seg[i + 3] : seg[i + 3];
          p.moveTo(seg[i] * doc.width, v1 * doc.height);
          p.lineTo(seg[i + 2] * doc.width, v2 * doc.height);
        }
        uvPathRef.current = { seg, w: doc.width, h: doc.height, flip: s.uv.flipV, path: p };
      }
      ctx.lineWidth = 1 / zoom;
      ctx.strokeStyle = "rgba(0, 230, 190, 0.55)";
      ctx.stroke(uvPathRef.current.path!);
    }

    if (s.showGrid) {
      ctx.lineWidth = 1 / zoom;
      ctx.strokeStyle = "rgba(255,255,255,0.12)";
      ctx.beginPath();
      for (let x = 0; x <= doc.width; x += s.gridSize) {
        ctx.moveTo(x, 0);
        ctx.lineTo(x, doc.height);
      }
      for (let y = 0; y <= doc.height; y += s.gridSize) {
        ctx.moveTo(0, y);
        ctx.lineTo(doc.width, y);
      }
      ctx.stroke();
    }
    ctx.restore();

    // ---- overlays in screen space
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.strokeStyle = "#555a66";
    ctx.lineWidth = 1;
    ctx.strokeRect(tl.x - 0.5, tl.y - 0.5, dw + 1, dh + 1);

    const selected = doc.layers.filter((l) => s.selection.includes(l.id));
    for (const l of selected) {
      // projected layers / surface lines are edited in 3D; their UV footprint is shown baked
      if (l.type === "fill" || l.type === "surfaceLine" || l.projection) continue;
      const corners = docCorners(l, doc.width, doc.height).map(docToScreen);
      ctx.strokeStyle = "#4da3ff";
      ctx.setLineDash([5, 4]);
      ctx.beginPath();
      corners.forEach((c, i) => (i ? ctx.lineTo(c.x, c.y) : ctx.moveTo(c.x, c.y)));
      ctx.closePath();
      ctx.stroke();
      ctx.setLineDash([]);
      if (selected.length === 1 && s.tool === "select" && !l.locked) {
        ctx.fillStyle = "#fff";
        for (const c of corners) {
          ctx.fillRect(c.x - HANDLE / 2, c.y - HANDLE / 2, HANDLE, HANDLE);
          ctx.strokeRect(c.x - HANDLE / 2, c.y - HANDLE / 2, HANDLE, HANDLE);
        }
        const rh = rotateHandle(l, doc);
        const lb = localBounds(l, doc.width, doc.height);
        const top = docToScreen(toDoc(l, { x: lb.x + lb.w / 2, y: lb.y }));
        ctx.beginPath();
        ctx.moveTo(top.x, top.y);
        ctx.lineTo(rh.x, rh.y);
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(rh.x, rh.y, HANDLE / 1.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }
      if (s.tool === "nodes") {
        const pts = layerPoints(l);
        if (pts) {
          const ctl = pts.map((p) => docToScreen(toDoc(l, p)));
          ctx.strokeStyle = "rgba(255,200,0,0.6)";
          ctx.beginPath();
          ctl.forEach((c, i) => (i ? ctx.lineTo(c.x, c.y) : ctx.moveTo(c.x, c.y)));
          ctx.stroke();
          for (const c of ctl) {
            ctx.fillStyle = "#ffc400";
            ctx.beginPath();
            ctx.arc(c.x, c.y, 5, 0, Math.PI * 2);
            ctx.fill();
          }
        }
      }
    }

    // path / stripes draft
    const draft = draftRef.current;
    if (draft.length) {
      const pts = hoverRef.current ? [...draft, hoverRef.current] : draft;
      const smooth = s.tool === "stripes" ? smoothPolyline(pts, false) : pts;
      ctx.strokeStyle = "#ffc400";
      ctx.lineWidth = 2;
      ctx.beginPath();
      smooth.map(docToScreen).forEach((c, i) => (i ? ctx.lineTo(c.x, c.y) : ctx.moveTo(c.x, c.y)));
      ctx.stroke();
      for (const p of draft.map(docToScreen)) {
        ctx.fillStyle = "#ffc400";
        ctx.fillRect(p.x - 4, p.y - 4, 8, 8);
      }
    }

    // brush cursor
    if ((s.tool === "brush" || s.tool === "eraser") && hoverRef.current) {
      const c = docToScreen(hoverRef.current);
      ctx.strokeStyle = "rgba(255,255,255,0.8)";
      ctx.beginPath();
      ctx.arc(c.x, c.y, (s.brush.size / 2) * zoom, 0, Math.PI * 2);
      ctx.stroke();
    }
  }, [size]); // eslint-disable-line react-hooks/exhaustive-deps

  const requestDraw = useCallback(() => {
    if (rafRef.current) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = 0;
      draw();
    });
  }, [draw]);

  function rotateHandle(l: Layer, doc: TextureDoc): Vec2 {
    const b = localBounds(l, doc.width, doc.height);
    const top = docToScreen(toDoc(l, { x: b.x + b.w / 2, y: b.y }));
    const center = docToScreen(toDoc(l, { x: b.x + b.w / 2, y: b.y + b.h / 2 }));
    const dx = top.x - center.x, dy = top.y - center.y;
    const len = Math.hypot(dx, dy) || 1;
    return { x: top.x + (dx / len) * 28, y: top.y + (dy / len) * 28 };
  }

  // ---------------------------------------------------------------- resize / subscriptions
  useEffect(() => {
    const el = wrapRef.current!;
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect();
      setSize({ w: Math.max(50, r.width), h: Math.max(50, r.height) });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const c = canvasRef.current!;
    const dpr = window.devicePixelRatio || 1;
    c.width = Math.round(size.w * dpr);
    c.height = Math.round(size.h * dpr);
    draw();
  }, [size, draw]);

  useEffect(() => useEditor.subscribe(() => requestDraw()), [requestDraw]);

  // zoom-to-fit requests
  const fitRequest = useEditor((s) => s.view.fitRequest);
  useEffect(() => {
    const s = useEditor.getState();
    const doc = activeDoc(s.project);
    const zoom = Math.min((size.w - 40) / doc.width, (size.h - 40) / doc.height);
    s.set({ view: { ...s.view, zoom, panX: (size.w - doc.width * zoom) / 2, panY: (size.h - doc.height * zoom) / 2 } });
  }, [fitRequest, size.w, size.h]);

  // tool → cursor; finishing drafts when the tool changes
  const tool = useEditor((s) => s.tool);
  useEffect(() => {
    draftRef.current = [];
    setCursor(
      tool === "hand" ? "grab" : tool === "select" ? "default" : tool === "text" ? "text" : tool === "brush" || tool === "eraser" ? "none" : "crosshair",
    );
    requestDraw();
  }, [tool, requestDraw]);

  // ---------------------------------------------------------------- draft finishing
  const finishDraft = useCallback((closed = false) => {
    const s = useEditor.getState();
    const pts = draftRef.current;
    draftRef.current = [];
    hoverRef.current = null;
    if (pts.length < 2) return requestDraw();
    const { points, cx, cy } = recenter(pts);
    if (s.tool === "stripes") {
      const preset = STRIPE_PRESETS[s.stripePreset] ?? STRIPE_PRESETS[0];
      const layer = makeStripes(points, cx, cy, preset.stripes);
      layer.gap = preset.gap;
      layer.closed = closed;
      s.addLayer(layer);
    } else {
      const layer = makeShape({ kind: "path", points, closed, smooth: false }, cx, cy, s.primary);
      if (!closed) {
        layer.fill = { type: "none" };
        layer.stroke = { paint: { type: "solid", color: s.primary }, width: s.shapeOpts.strokeWidth, dash: [], cap: "round", join: "round" };
      } else if (s.shapeOpts.withStroke) {
        layer.stroke = { paint: { type: "solid", color: s.secondary }, width: s.shapeOpts.strokeWidth, dash: [], cap: "round", join: "round" };
      }
      s.addLayer(layer);
    }
    requestDraw();
  }, [requestDraw]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable) return;
      if (e.code === "Space") spaceRef.current = e.type === "keydown";
      if (e.type !== "keydown") return;
      if (draftRef.current.length) {
        if (e.key === "Enter") finishDraft(false);
        else if (e.key === "Escape") {
          draftRef.current = [];
          requestDraw();
        } else if (e.key === "Backspace") {
          draftRef.current.pop();
          requestDraw();
        }
      }
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("keyup", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keyup", onKey);
    };
  }, [finishDraft, requestDraw]);

  // ---------------------------------------------------------------- pointer handling
  const localPos = (e: React.PointerEvent | React.MouseEvent | React.DragEvent) => {
    const r = canvasRef.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  const onPointerDown = (e: React.PointerEvent) => {
    const s = useEditor.getState();
    const doc = activeDoc(s.project);
    const sp = localPos(e);
    const p = screenToDoc(sp.x, sp.y);
    canvasRef.current!.setPointerCapture(e.pointerId);

    if (e.button === 1 || s.tool === "hand" || spaceRef.current) {
      dragRef.current = { kind: "pan", sx: sp.x, sy: sp.y, panX: s.view.panX, panY: s.view.panY };
      setCursor("grabbing");
      return;
    }
    if (e.button !== 0) return;

    switch (s.tool) {
      case "select": {
        const sel = doc.layers.filter((l) => s.selection.includes(l.id));
        if (sel.length === 1 && !sel[0].locked && sel[0].type !== "fill") {
          const l = sel[0];
          const rh = rotateHandle(l, doc);
          if (Math.hypot(rh.x - sp.x, rh.y - sp.y) < HANDLE + 3) {
            const c = docToScreen({ x: l.x, y: l.y });
            dragRef.current = { kind: "rotate", layer: l, startAngle: Math.atan2(sp.y - c.y, sp.x - c.x), moved: false };
            return;
          }
          const corners = docCorners(l, doc.width, doc.height).map(docToScreen);
          const ci = corners.findIndex((c) => Math.abs(c.x - sp.x) <= HANDLE && Math.abs(c.y - sp.y) <= HANDLE);
          if (ci >= 0) {
            dragRef.current = { kind: "scale", layer: l, corner: ci, moved: false };
            return;
          }
        }
        const tol = 4 / s.view.zoom;
        const hit = [...doc.layers].reverse().find((l) => l.visible && !l.locked && hitTest(l, p, doc.width, doc.height, tol));
        if (hit) {
          if (e.shiftKey || e.ctrlKey) s.select([hit.id], true);
          else if (!s.selection.includes(hit.id)) s.select([hit.id]);
          const ids = useEditor.getState().selection;
          const orig = new Map<string, Vec2>();
          for (const l of doc.layers) if (ids.includes(l.id) && !l.locked) orig.set(l.id, { x: l.x, y: l.y });
          dragRef.current = { kind: "move", start: p, orig, moved: false };
        } else if (!e.shiftKey) {
          s.select([]);
        }
        return;
      }
      case "nodes": {
        const sel = doc.layers.filter((l) => s.selection.includes(l.id));
        for (const l of sel) {
          const pts = layerPoints(l);
          if (!pts) continue;
          const idx = pts.findIndex((q) => {
            const sc = docToScreen(toDoc(l, q));
            return Math.hypot(sc.x - sp.x, sc.y - sp.y) < 8;
          });
          if (idx >= 0) {
            if (e.altKey && pts.length > 2) {
              s.updateLayer(l.id, withPoints(l, pts.filter((_, i) => i !== idx)));
            } else {
              dragRef.current = { kind: "node", id: l.id, index: idx, moved: false };
            }
            return;
          }
          if (e.ctrlKey) {
            s.updateLayer(l.id, withPoints(l, [...pts, toLocal(l, snapPt(p))]));
            return;
          }
        }
        const hit = [...doc.layers].reverse().find((l) => l.visible && !l.locked && layerPoints(l) && hitTest(l, p, doc.width, doc.height, 6 / s.view.zoom));
        s.select(hit ? [hit.id] : []);
        return;
      }
      case "rect":
      case "ellipse":
      case "polygon":
      case "star": {
        const o = s.shapeOpts;
        const start = snapPt(p);
        const geometry =
          s.tool === "rect"
            ? { kind: "rect" as const, w: 1, h: 1, radius: o.radius }
            : s.tool === "ellipse"
              ? { kind: "ellipse" as const, w: 1, h: 1 }
              : s.tool === "polygon"
                ? { kind: "polygon" as const, w: 1, h: 1, sides: o.sides }
                : { kind: "star" as const, w: 1, h: 1, points: o.points, inner: o.inner };
        const layer = makeShape(geometry, start.x, start.y, s.primary);
        if (o.withStroke) layer.stroke = { paint: { type: "solid", color: s.secondary }, width: o.strokeWidth, dash: [], cap: "round", join: "round" };
        s.addLayer(layer);
        dragRef.current = { kind: "create", id: layer.id, start };
        return;
      }
      case "path":
      case "stripes": {
        const q = snapPt(p);
        const d = draftRef.current;
        if (s.tool === "path" && d.length >= 3) {
          const first = docToScreen(d[0]);
          if (Math.hypot(first.x - sp.x, first.y - sp.y) < 10) return finishDraft(true);
        }
        if (e.detail >= 2) return finishDraft(false);
        d.push(q);
        requestDraw();
        return;
      }
      case "text": {
        const layer = makeText("TEKST", p.x, p.y, s.primary, Math.round(Math.max(48, doc.height / 16)));
        s.addLayer(layer);
        s.set({ tool: "select" });
        return;
      }
      case "brush":
      case "eraser": {
        const stroke = new BrushStroke(s.tool === "eraser");
        stroke.add(p.x, p.y, false);
        dragRef.current = { kind: "brush", stroke };
        return;
      }
      case "eyedropper": {
        const c = document.createElement("canvas");
        c.width = c.height = 1;
        const ctx = c.getContext("2d", { willReadFrequently: true })!;
        ctx.setTransform(1, 0, 0, 1, -p.x, -p.y);
        renderDoc(ctx, doc, s.project.palette);
        const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
        const hex = rgbaToHex({ r, g, b, a: a / 255 });
        if (e.altKey) s.setSecondary(hex);
        else s.setPrimary(hex);
        s.notify(`Kleur opgepikt: ${hex}`);
        return;
      }
    }
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const s = useEditor.getState();
    const doc = activeDoc(s.project);
    const sp = localPos(e);
    const p = screenToDoc(sp.x, sp.y);
    hoverRef.current = s.tool === "path" || s.tool === "stripes" ? snapPt(p) : p;
    const d = dragRef.current;
    if (!d) {
      if (s.tool === "brush" || s.tool === "eraser" || draftRef.current.length) requestDraw();
      return;
    }
    switch (d.kind) {
      case "pan":
        s.set({ view: { ...s.view, panX: d.panX + sp.x - d.sx, panY: d.panY + sp.y - d.sy } });
        return;
      case "move": {
        if (!d.moved) {
          s.checkpoint();
          d.moved = true;
        }
        let dx = p.x - d.start.x, dy = p.y - d.start.y;
        if (e.shiftKey) Math.abs(dx) > Math.abs(dy) ? (dy = 0) : (dx = 0);
        s.mapLayers([...d.orig.keys()], (l) => {
          const o = d.orig.get(l.id)!;
          const np = snapPt({ x: o.x + dx, y: o.y + dy });
          return { ...l, x: np.x, y: np.y };
        }, false);
        return;
      }
      case "scale": {
        if (!d.moved) {
          s.checkpoint();
          d.moved = true;
        }
        const l = d.layer;
        const b = localBounds(l, doc.width, doc.height);
        const cornersL = [
          { x: b.x, y: b.y },
          { x: b.x + b.w, y: b.y },
          { x: b.x + b.w, y: b.y + b.h },
          { x: b.x, y: b.y + b.h },
        ];
        const C = cornersL[d.corner], A = cornersL[(d.corner + 2) % 4];
        const Lp = toLocal(l, p);
        let fx = (Lp.x - A.x) / (C.x - A.x || 1);
        let fy = (Lp.y - A.y) / (C.y - A.y || 1);
        if (e.shiftKey || l.type === "text" || l.type === "image") {
          if (!e.altKey) {
            const f = Math.max(Math.abs(fx), Math.abs(fy));
            fx = Math.sign(fx || 1) * f;
            fy = Math.sign(fy || 1) * f;
          }
        }
        const sx = l.scaleX * fx, sy = l.scaleY * fy;
        const anchorDoc = toDoc(l, A);
        const c = Math.cos(l.rotation * DEG), sn = Math.sin(l.rotation * DEG);
        const ax = A.x * sx, ay = A.y * sy;
        s.updateLayer(l.id, { scaleX: sx, scaleY: sy, x: anchorDoc.x - (ax * c - ay * sn), y: anchorDoc.y - (ax * sn + ay * c) }, false);
        return;
      }
      case "rotate": {
        if (!d.moved) {
          s.checkpoint();
          d.moved = true;
        }
        const c = docToScreen({ x: d.layer.x, y: d.layer.y });
        let rot = d.layer.rotation + (Math.atan2(sp.y - c.y, sp.x - c.x) - d.startAngle) / DEG;
        if (e.shiftKey) rot = Math.round(rot / 15) * 15;
        rot = ((rot % 360) + 540) % 360 - 180;
        s.updateLayer(d.layer.id, { rotation: rot }, false);
        return;
      }
      case "create": {
        const q = snapPt(p);
        let w = q.x - d.start.x, h = q.y - d.start.y;
        if (e.shiftKey) {
          const m = Math.max(Math.abs(w), Math.abs(h));
          w = Math.sign(w || 1) * m;
          h = Math.sign(h || 1) * m;
        }
        const layer = doc.layers.find((l) => l.id === d.id) as ShapeLayer | undefined;
        if (!layer || layer.geometry.kind === "path") return;
        const cx = e.altKey ? d.start.x : d.start.x + w / 2;
        const cy = e.altKey ? d.start.y : d.start.y + h / 2;
        const gw = Math.max(1, Math.abs(e.altKey ? w * 2 : w)), gh = Math.max(1, Math.abs(e.altKey ? h * 2 : h));
        s.updateLayer(d.id, { x: cx, y: cy, geometry: { ...layer.geometry, w: gw, h: gh } } as Partial<Layer>, false);
        return;
      }
      case "node": {
        const l = doc.layers.find((x) => x.id === d.id);
        if (!l) return;
        const pts = layerPoints(l);
        if (!pts) return;
        if (!d.moved) {
          s.checkpoint();
          d.moved = true;
        }
        const next = pts.slice();
        next[d.index] = toLocal(l, snapPt(p));
        s.updateLayer(l.id, withPoints(l, next), false);
        return;
      }
      case "brush":
        d.stroke.add(p.x, p.y, true);
        return;
    }
  };

  const onPointerUp = () => {
    const d = dragRef.current;
    dragRef.current = null;
    const s = useEditor.getState();
    if (d?.kind === "pan") setCursor(s.tool === "hand" ? "grab" : "default");
    if (d?.kind === "brush") void d.stroke.end();
    if (d?.kind === "create") {
      const doc = activeDoc(s.project);
      const l = doc.layers.find((x) => x.id === d.id) as ShapeLayer | undefined;
      if (l && l.geometry.kind !== "path" && l.geometry.w * s.view.zoom < 4 && l.geometry.h * s.view.zoom < 4) {
        const def = Math.round(doc.width / 8);
        s.updateLayer(l.id, { geometry: { ...l.geometry, w: def, h: def } } as Partial<Layer>, false);
      }
    }
  };

  const onWheel = (e: React.WheelEvent) => {
    const s = useEditor.getState();
    const sp = localPos(e);
    const factor = Math.exp(-e.deltaY * 0.0015);
    const zoom = Math.min(16, Math.max(0.02, s.view.zoom * factor));
    const before = screenToDoc(sp.x, sp.y);
    s.set({ view: { ...s.view, zoom, panX: sp.x - before.x * zoom, panY: sp.y - before.y * zoom } });
  };

  const onDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    const sp = localPos(e);
    const p = screenToDoc(sp.x, sp.y);
    for (const f of Array.from(e.dataTransfer.files)) await importImageFile(f, p.x, p.y);
  };

  const onLeave = () => {
    hoverRef.current = null;
    requestDraw();
  };

  return (
    <div
      ref={wrapRef}
      className="canvas2d"
      onDragOver={(e) => e.preventDefault()}
      onDrop={onDrop}
      onContextMenu={(e) => e.preventDefault()}
    >
      <canvas
        ref={canvasRef}
        style={{ width: size.w, height: size.h, cursor }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onPointerLeave={onLeave}
        onWheel={onWheel}
      />
      <CanvasHud />
    </div>
  );
}

function CanvasHud() {
  const zoom = useEditor((s) => s.view.zoom);
  const doc = useEditor((s) => activeDoc(s.project));
  const tool = useEditor((s) => s.tool);
  const hint: Record<string, string> = {
    select: "Klik om te selecteren · sleep om te verplaatsen · hoeken schalen (Shift = proportioneel) · bol = draaien",
    nodes: "Sleep punten · Alt+klik verwijdert punt · Ctrl+klik voegt punt toe",
    path: "Klik punten · dubbelklik/Enter = open lijn · klik op eerste punt = gesloten vorm · Backspace = punt terug",
    stripes: "Klik punten voor het lijnontwerp · dubbelklik/Enter om af te ronden",
    brush: "Schilder op een penseellaag (wordt automatisch gemaakt)",
    eraser: "Gum op de geselecteerde penseellaag",
    eyedropper: "Klik = primaire kleur · Alt+klik = secundaire kleur",
    hand: "Sleep om te verschuiven (of spatie/middelste muisknop)",
  };
  return (
    <div className="canvas-hud">
      <span>
        {doc.name} · {doc.width}×{doc.height}px · {Math.round(zoom * 100)}%
      </span>
      {hint[tool] && <span className="hint">{hint[tool]}</span>}
    </div>
  );
}
