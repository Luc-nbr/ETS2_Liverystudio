// The main editor: every tool works directly on the 3D model.
//
// Mouse: left = active tool (on the model) or orbit (on empty space / Alt held),
// right = orbit, middle = pan, wheel = zoom.

import { useEffect, useRef } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { rgbaToHex } from "../color/color";
import { Brush3DStroke } from "../editor/brush";
import { STRIPE_PRESETS, makeProjection, makeShape, makeSurfaceLine, makeText } from "../editor/factory";
import { DEG, docCorners, hitTest, localBounds, normalizeAngle, recenter, scaleByCorner, smoothPolyline, toDoc, toLocal } from "../editor/geometry";
import { fileToImageLayer } from "../editor/importers";
import { isProjected } from "../editor/render";
import { activeDoc, useEditor, type EditorState } from "../editor/store";
import type { Layer, Projection, ShapeLayer, SurfaceLineLayer, SurfacePoint, TextureDoc, V3, Vec2 } from "../editor/types";
import { getBaker, sampleSurfaceLine } from "./baker";
import { onPreviewUpdated, previewCanvas, renderPreview, samplePreview } from "./composite";
import { defaultUp, frameOf, fromPlane, mirrorFrame, mirrorPoint, rayToPlane, toPlane, type Frame } from "./frame";
import { currentMesh, rebuildMesh } from "./state";

interface Hit {
  p: V3;
  n: V3;
  /** texture coordinate in doc orientation (0..1, y down) */
  t: Vec2;
}

type Drag =
  | { kind: "move3d"; id: string; grab: Vec2; orig: Layer; slide: boolean; moved: boolean }
  | { kind: "moveUv"; id: string; start: Vec2; orig: Vec2; moved: boolean }
  | { kind: "moveLine"; id: string; start: V3; orig: SurfacePoint[]; moved: boolean }
  | { kind: "scale"; id: string; corner: number; orig: Layer; moved: boolean }
  | { kind: "rotate"; id: string; startAngle: number; orig: Layer; moved: boolean }
  | { kind: "create"; id: string; frame: Frame }
  | { kind: "node3d"; id: string; index: number; moved: boolean }
  | { kind: "nodePlane"; id: string; index: number; moved: boolean }
  | { kind: "brush"; stroke: Brush3DStroke };

type Draft = { kind: "path"; proj: Projection; frame: Frame; points: Vec2[] } | { kind: "line"; points: SurfacePoint[] };

const HANDLE = 7;
const lineCache = new WeakMap<SurfaceLineLayer, V3[]>();
function linePts(l: SurfaceLineLayer): V3[] {
  let c = lineCache.get(l);
  if (!c) {
    c = sampleSurfaceLine(l, 400).map((q) => q.p);
    lineCache.set(l, c);
  }
  return c;
}
function distToPolyline(p: V3, pts: V3[]): number {
  let best = Infinity;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    const ab: V3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const l2 = ab[0] ** 2 + ab[1] ** 2 + ab[2] ** 2 || 1e-12;
    const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * ab[0] + (p[1] - a[1]) * ab[1] + (p[2] - a[2]) * ab[2]) / l2));
    best = Math.min(best, Math.hypot(p[0] - a[0] - ab[0] * t, p[1] - a[1] - ab[1] * t, p[2] - a[2] - ab[2] * t));
  }
  return pts.length === 1 ? Math.hypot(p[0] - pts[0][0], p[1] - pts[0][1], p[2] - pts[0][2]) : best;
}
const lineHalfWidth = (l: SurfaceLineLayer) => ((l.stripes.reduce((s, b) => s + b.width, 0) + l.gap * Math.max(0, l.stripes.length - 1)) * 0.001) / 2;

class ViewportController {
  renderer: THREE.WebGLRenderer;
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(40, 1, 0.05, 200);
  controls: OrbitControls;
  texture: THREE.CanvasTexture;
  paintObj: THREE.Mesh | null = null;
  others: THREE.Mesh[] = [];
  paintMat: THREE.MeshPhysicalMaterial;
  raycaster = new THREE.Raycaster();
  overlayCtx: CanvasRenderingContext2D;
  w = 1;
  h = 1;
  dirty = true;
  overlayDirty = true;
  raf = 0;
  drag: Drag | null = null;
  draft: Draft | null = null;
  hover: Hit | null = null;
  pointer: { x: number; y: number } | null = null;
  unsub: (() => void)[] = [];
  previewScheduled = 0;
  lastMeshVersion = -1;
  ro: ResizeObserver;

  constructor(
    public host: HTMLDivElement,
    public overlay: HTMLCanvasElement,
  ) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(window.devicePixelRatio || 1);
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    host.prepend(this.renderer.domElement);
    this.overlayCtx = overlay.getContext("2d")!;

    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.background = new THREE.Color(0x23262c);
    const sun = new THREE.DirectionalLight(0xffffff, 1.6);
    sun.position.set(-4, 8, -6);
    this.scene.add(sun, new THREE.HemisphereLight(0xdde8ff, 0x303030, 0.5));
    const grid = new THREE.GridHelper(20, 40, 0x3a3f48, 0x2c3037);
    this.scene.add(grid);

    this.texture = new THREE.CanvasTexture(previewCanvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
    this.texture.flipY = useEditor.getState().uv.flipV;
    this.paintMat = new THREE.MeshPhysicalMaterial({ map: this.texture, roughness: 0.32, metalness: 0.05, clearcoat: 1, clearcoatRoughness: 0.08, side: THREE.DoubleSide });

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.ROTATE };
    this.controls.addEventListener("change", () => this.invalidate());
    this.camera.position.set(-6, 4, -6);

    const el = this.renderer.domElement;
    el.addEventListener("pointerdown", this.onPointerDown, { capture: true });
    el.addEventListener("pointermove", this.onHoverMove);
    el.addEventListener("pointerleave", () => {
      this.hover = null;
      this.pointer = null;
      this.overlayDirty = true;
    });
    el.addEventListener("dblclick", this.onDblClick);
    el.addEventListener("contextmenu", (e) => e.preventDefault());
    window.addEventListener("keydown", this.onKey);

    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(host);
    this.resize();

    this.unsub.push(onPreviewUpdated(() => {
      // GL texture storage is immutable: re-allocate when the canvas size changes.
      const key = `${previewCanvas.width}x${previewCanvas.height}`;
      if (this.texture.userData.size !== key) {
        this.texture.dispose();
        this.texture.userData.size = key;
      }
      this.texture.needsUpdate = true;
      this.invalidate();
    }));
    this.unsub.push(useEditor.subscribe((s, prev) => this.onStore(s, prev)));
    if (!currentMesh()) rebuildMesh();
    this.syncMesh();
    this.schedulePreview();
    this.loop();
    controller = this;
    if (import.meta.env.DEV || location.search.includes("debug")) (window as unknown as { __vp: ViewportController }).__vp = this;
  }

  dispose() {
    cancelAnimationFrame(this.raf);
    this.ro.disconnect();
    window.removeEventListener("keydown", this.onKey);
    this.unsub.forEach((u) => u());
    this.controls.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
    if (controller === this) controller = null;
  }

  invalidate() {
    this.dirty = true;
    this.overlayDirty = true;
  }

  // ---------------------------------------------------------------- store sync
  onStore(s: EditorState, prev: EditorState) {
    if (s.meshVersion !== this.lastMeshVersion) this.syncMesh();
    if (s.project !== prev.project || s.renderVersion !== prev.renderVersion) this.schedulePreview();
    if (s.uv.flipV !== prev.uv.flipV) {
      this.texture.flipY = s.uv.flipV;
      this.texture.needsUpdate = true;
      this.schedulePreview();
    }
    if (s.selection !== prev.selection || s.tool !== prev.tool || s.project !== prev.project) {
      if (s.tool !== prev.tool) this.draft = null;
      this.overlayDirty = true;
    }
  }

  schedulePreview() {
    if (this.previewScheduled) return;
    this.previewScheduled = requestAnimationFrame(() => {
      this.previewScheduled = 0;
      const s = useEditor.getState();
      getBaker().prune(new Set(s.project.textures.flatMap((t) => t.layers.map((l) => l.id))));
      renderPreview();
    });
  }

  syncMesh() {
    const s = useEditor.getState();
    this.lastMeshVersion = s.meshVersion;
    const m = currentMesh();
    if (this.paintObj) this.scene.remove(this.paintObj);
    for (const o of this.others) {
      this.scene.remove(o);
      (o.material as THREE.Material).dispose();
    }
    this.others = [];
    this.paintObj = null;
    if (!m) return;
    if (m.paint.getAttribute("position")) {
      this.paintObj = new THREE.Mesh(m.paint, this.paintMat);
      this.scene.add(this.paintObj);
    }
    for (const o of m.others) {
      const mesh = new THREE.Mesh(o.geometry, new THREE.MeshStandardMaterial({ color: o.color, roughness: 0.6, metalness: 0.4, side: THREE.DoubleSide }));
      this.others.push(mesh);
      this.scene.add(mesh);
    }
    this.frameAll("left");
    this.schedulePreview();
  }

  frameAll(view: "left" | "right" | "front" | "back" | "top" | "persp") {
    const m = currentMesh();
    if (!m) return;
    const c = new THREE.Vector3((m.bboxMin[0] + m.bboxMax[0]) / 2, (m.bboxMin[1] + m.bboxMax[1]) / 2, (m.bboxMin[2] + m.bboxMax[2]) / 2);
    const paintBox = this.paintObj?.geometry.boundingBox;
    const target = paintBox ? paintBox.getCenter(new THREE.Vector3()) : c;
    const size = paintBox ? paintBox.getSize(new THREE.Vector3()).length() : 6;
    const d = size * 1.7 + 2;
    const dirs: Record<string, [number, number, number]> = {
      left: [-1, 0.25, -0.15],
      right: [1, 0.25, -0.15],
      front: [0, 0.2, -1],
      back: [0, 0.2, 1],
      top: [0, 1, 0.001],
      persp: [-0.8, 0.5, -0.9],
    };
    const v = new THREE.Vector3(...dirs[view]).normalize().multiplyScalar(d);
    this.camera.position.copy(target).add(v);
    this.controls.target.copy(target);
    this.controls.update();
    this.invalidate();
  }

  resize() {
    const r = this.host.getBoundingClientRect();
    this.w = Math.max(10, r.width);
    this.h = Math.max(10, r.height);
    this.renderer.setSize(this.w, this.h);
    this.camera.aspect = this.w / this.h;
    this.camera.updateProjectionMatrix();
    const dpr = window.devicePixelRatio || 1;
    this.overlay.width = Math.round(this.w * dpr);
    this.overlay.height = Math.round(this.h * dpr);
    this.overlay.style.width = `${this.w}px`;
    this.overlay.style.height = `${this.h}px`;
    this.invalidate();
  }

  loop = () => {
    this.raf = requestAnimationFrame(this.loop);
    this.controls.update();
    if (this.dirty) {
      this.dirty = false;
      this.renderer.render(this.scene, this.camera);
    }
    if (this.overlayDirty) {
      this.overlayDirty = false;
      this.drawOverlay();
    }
  };

  // ---------------------------------------------------------------- picking
  setRay(clientX: number, clientY: number) {
    const r = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
  }

  rayV3(): { o: V3; d: V3 } {
    const { origin, direction } = this.raycaster.ray;
    return { o: [origin.x, origin.y, origin.z], d: [direction.x, direction.y, direction.z] };
  }

  /** Raycast the model; returns null when nothing (or a non-paintable part) is hit. */
  pick(clientX: number, clientY: number): Hit | null {
    if (!this.paintObj) return null;
    this.setRay(clientX, clientY);
    const hits = this.raycaster.intersectObjects([this.paintObj, ...this.others], false);
    const h = hits[0];
    if (!h || h.object !== this.paintObj || !h.face) return null;
    const g = this.paintObj.geometry;
    const pos = g.getAttribute("position") as THREE.BufferAttribute;
    const nrm = g.getAttribute("normal") as THREE.BufferAttribute;
    const uv = g.getAttribute("uv") as THREE.BufferAttribute;
    const { a, b, c } = h.face;
    const tri = new THREE.Triangle(new THREE.Vector3().fromBufferAttribute(pos, a), new THREE.Vector3().fromBufferAttribute(pos, b), new THREE.Vector3().fromBufferAttribute(pos, c));
    const bary = tri.getBarycoord(h.point, new THREE.Vector3());
    if (!bary) return null;
    const n = new THREE.Vector3()
      .addScaledVector(new THREE.Vector3().fromBufferAttribute(nrm, a), bary.x)
      .addScaledVector(new THREE.Vector3().fromBufferAttribute(nrm, b), bary.y)
      .addScaledVector(new THREE.Vector3().fromBufferAttribute(nrm, c), bary.z)
      .normalize();
    if (n.dot(this.raycaster.ray.direction) > 0) n.negate();
    const u = uv.getX(a) * bary.x + uv.getX(b) * bary.y + uv.getX(c) * bary.z;
    const v = uv.getY(a) * bary.x + uv.getY(b) * bary.y + uv.getY(c) * bary.z;
    const flip = useEditor.getState().uv.flipV;
    return { p: [h.point.x, h.point.y, h.point.z], n: [n.x, n.y, n.z], t: { x: u, y: flip ? 1 - v : v } };
  }

  /** Snaps a world point onto the paint surface along its normal. */
  snapToSurface(p: V3, n: V3): SurfacePoint {
    if (!this.paintObj) return { p, n };
    const o = new THREE.Vector3(p[0] + n[0] * 0.25, p[1] + n[1] * 0.25, p[2] + n[2] * 0.25);
    this.raycaster.set(o, new THREE.Vector3(-n[0], -n[1], -n[2]));
    this.raycaster.far = 0.6;
    const h = this.raycaster.intersectObject(this.paintObj, false)[0];
    this.raycaster.far = Infinity;
    if (!h) return { p, n };
    return { p: [h.point.x, h.point.y, h.point.z], n };
  }

  toScreen(p: V3): Vec2 & { visible: boolean } {
    const v = new THREE.Vector3(p[0], p[1], p[2]).project(this.camera);
    return { x: ((v.x + 1) / 2) * this.w, y: ((1 - v.y) / 2) * this.h, visible: v.z < 1 };
  }

  viewNormal(): V3 {
    const d = new THREE.Vector3();
    this.camera.getWorldDirection(d);
    return [-d.x, -d.y, -d.z];
  }

  newProjection(hit: Hit): Projection {
    const s = useEditor.getState();
    const N = s.projectFrom === "view" ? this.viewNormal() : hit.n;
    return makeProjection(hit.p, N, defaultUp(N), s.symmetry);
  }

  /** Which layer is under the hit point? (top-most first) */
  pickLayer(hit: Hit, doc: TextureDoc): Layer | null {
    const sym = currentMesh()?.symmetryX ?? 0;
    for (let i = doc.layers.length - 1; i >= 0; i--) {
      const l = doc.layers[i];
      if (!l.visible || l.locked || l.type === "fill") continue;
      if (l.type === "surfaceLine") {
        const pts = linePts(l);
        const tol = lineHalfWidth(l) + 0.01;
        if (distToPolyline(hit.p, pts) <= tol || (l.mirror && distToPolyline(mirrorPoint(hit.p, sym), pts) <= tol)) return l;
        continue;
      }
      if (l.projection) {
        const f = frameOf(l.projection);
        const frames = l.projection.mirror ? [f, mirrorFrame(f, sym, l.projection.mirrorReadable)] : [f];
        for (const fr of frames) {
          const q = toPlane(fr, hit.p);
          if (Math.abs(q.z) > l.projection.depth) continue;
          const loc = toLocal(l, { x: q.x, y: q.y });
          const b = localBounds(l, doc.width, doc.height);
          if (loc.x >= b.x && loc.x <= b.x + b.w && loc.y >= b.y && loc.y <= b.y + b.h) return l;
        }
        continue;
      }
      if (l.type === "raster") continue;
      if (hitTest(l, { x: hit.t.x * doc.width, y: hit.t.y * doc.height }, doc.width, doc.height, 4)) return l;
    }
    return null;
  }

  // ---------------------------------------------------------------- gizmo geometry
  gizmo(l: Layer, doc: TextureDoc): { corners: Vec2[]; rot: Vec2; top: Vec2 } | null {
    if (!l.projection || !isProjected(l)) return null;
    const f = frameOf(l.projection);
    const corners = docCorners(l, doc.width, doc.height).map((c) => this.toScreen(fromPlane(f, c.x, c.y)));
    const b = localBounds(l, doc.width, doc.height);
    const tp = toDoc(l, { x: b.x + b.w / 2, y: b.y });
    const top = this.toScreen(fromPlane(f, tp.x, tp.y));
    const center = this.toScreen(fromPlane(f, l.x, l.y));
    const dx = top.x - center.x, dy = top.y - center.y;
    const len = Math.hypot(dx, dy) || 1;
    return { corners, top, rot: { x: top.x + (dx / len) * 28, y: top.y + (dy / len) * 28 } };
  }

  // ---------------------------------------------------------------- pointer handling
  local(e: PointerEvent | MouseEvent): Vec2 {
    const r = this.renderer.domElement.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  onPointerDown = (e: PointerEvent) => {
    if (e.button !== 0 || e.altKey) return; // orbit / pan through OrbitControls
    const s = useEditor.getState();
    const doc = activeDoc(s.project);
    const sp = this.local(e);
    const hit = this.pick(e.clientX, e.clientY);
    const take = () => {
      e.stopImmediatePropagation();
      e.preventDefault();
      this.controls.enabled = false;
      window.addEventListener("pointermove", this.onDragMove);
      window.addEventListener("pointerup", this.onDragEnd, { once: true });
    };
    const sel = doc.layers.filter((l) => s.selection.includes(l.id));

    switch (s.tool) {
      case "select": {
        // transform handles of a single selected projected layer
        if (sel.length === 1 && !sel[0].locked) {
          const l = sel[0];
          const g = this.gizmo(l, doc);
          if (g) {
            this.setRay(e.clientX, e.clientY);
            const ray = this.rayV3();
            const f = frameOf(l.projection!);
            if (Math.hypot(g.rot.x - sp.x, g.rot.y - sp.y) < HANDLE + 3) {
              const P = rayToPlane(f, ray.o, ray.d);
              if (P) {
                this.drag = { kind: "rotate", id: l.id, startAngle: Math.atan2(P.y - l.y, P.x - l.x), orig: l, moved: false };
                return take();
              }
            }
            const ci = g.corners.findIndex((c) => Math.abs(c.x - sp.x) <= HANDLE && Math.abs(c.y - sp.y) <= HANDLE);
            if (ci >= 0) {
              this.drag = { kind: "scale", id: l.id, corner: ci, orig: l, moved: false };
              return take();
            }
          }
        }
        if (!hit) {
          if (!e.shiftKey) s.select([]);
          return; // orbit
        }
        const l = this.pickLayer(hit, doc);
        if (!l) {
          if (!e.shiftKey) s.select([]);
          return; // orbit
        }
        if (e.shiftKey || e.ctrlKey) s.select([l.id], true);
        else s.select([l.id]);
        if (l.type === "surfaceLine") {
          this.drag = { kind: "moveLine", id: l.id, start: hit.p, orig: l.points, moved: false };
        } else if (l.projection) {
          const f = frameOf(l.projection);
          const q = toPlane(f, hit.p);
          this.drag = { kind: "move3d", id: l.id, grab: { x: q.x - l.x, y: q.y - l.y }, orig: l, slide: e.ctrlKey, moved: false };
        } else {
          this.drag = { kind: "moveUv", id: l.id, start: { x: hit.t.x * doc.width, y: hit.t.y * doc.height }, orig: { x: l.x, y: l.y }, moved: false };
        }
        return take();
      }
      case "nodes": {
        for (const l of sel) {
          if (l.type === "surfaceLine") {
            const idx = l.points.findIndex((q) => {
              const sc = this.toScreen(q.p);
              return Math.hypot(sc.x - sp.x, sc.y - sp.y) < 8;
            });
            if (idx >= 0) {
              if (e.altKey && l.points.length > 2) s.updateLayer(l.id, { points: l.points.filter((_, i) => i !== idx) } as Partial<Layer>);
              else this.drag = { kind: "node3d", id: l.id, index: idx, moved: false };
              return this.drag ? take() : undefined;
            }
            if (e.ctrlKey && hit) {
              s.updateLayer(l.id, { points: [...l.points, { p: hit.p, n: hit.n }] } as Partial<Layer>);
              return take();
            }
          } else if (l.type === "shape" && l.geometry.kind === "path" && l.projection) {
            const f = frameOf(l.projection);
            const pts = l.geometry.points;
            const idx = pts.findIndex((q) => {
              const d = toDoc(l, q);
              const sc = this.toScreen(fromPlane(f, d.x, d.y));
              return Math.hypot(sc.x - sp.x, sc.y - sp.y) < 8;
            });
            if (idx >= 0) {
              if (e.altKey && pts.length > 3) s.updateLayer(l.id, { geometry: { ...l.geometry, points: pts.filter((_, i) => i !== idx) } } as Partial<Layer>);
              else {
                this.drag = { kind: "nodePlane", id: l.id, index: idx, moved: false };
                return take();
              }
              return;
            }
          }
        }
        if (hit) {
          const l = this.pickLayer(hit, doc);
          if (l) {
            s.select([l.id]);
            e.stopImmediatePropagation();
          }
        }
        return;
      }
      case "rect":
      case "ellipse":
      case "polygon":
      case "star": {
        if (!hit) return;
        const o = s.shapeOpts;
        const geometry =
          s.tool === "rect"
            ? { kind: "rect" as const, w: 1, h: 1, radius: o.radius }
            : s.tool === "ellipse"
              ? { kind: "ellipse" as const, w: 1, h: 1 }
              : s.tool === "polygon"
                ? { kind: "polygon" as const, w: 1, h: 1, sides: o.sides }
                : { kind: "star" as const, w: 1, h: 1, points: o.points, inner: o.inner };
        const layer = makeShape(geometry, 0, 0, s.primary);
        if (o.withStroke) layer.stroke = { paint: { type: "solid", color: s.secondary }, width: o.strokeWidth, dash: [], cap: "round", join: "round" };
        layer.projection = this.newProjection(hit);
        s.addLayer(layer);
        this.drag = { kind: "create", id: layer.id, frame: frameOf(layer.projection) };
        return take();
      }
      case "text": {
        if (!hit) return;
        const layer = makeText("TEKST", 0, 0, s.primary, 150);
        layer.projection = this.newProjection(hit);
        s.addLayer(layer);
        s.set({ tool: "select" });
        e.stopImmediatePropagation();
        return;
      }
      case "path": {
        if (!hit && !this.draft) return;
        e.stopImmediatePropagation();
        if (!this.draft || this.draft.kind !== "path") {
          if (!hit) return;
          const proj = this.newProjection(hit);
          this.draft = { kind: "path", proj, frame: frameOf(proj), points: [{ x: 0, y: 0 }] };
        } else {
          this.setRay(e.clientX, e.clientY);
          const ray = this.rayV3();
          const P = rayToPlane(this.draft.frame, ray.o, ray.d);
          if (!P) return;
          const first = this.toScreen(fromPlane(this.draft.frame, 0, 0));
          if (this.draft.points.length >= 3 && Math.hypot(first.x - sp.x, first.y - sp.y) < 10) return this.finishDraft(true);
          if (e.detail < 2) this.draft.points.push(P);
        }
        this.overlayDirty = true;
        return;
      }
      case "stripes": {
        if (!hit) return;
        e.stopImmediatePropagation();
        if (!this.draft || this.draft.kind !== "line") this.draft = { kind: "line", points: [] };
        if (e.detail < 2) this.draft.points.push({ p: hit.p, n: hit.n });
        this.overlayDirty = true;
        return;
      }
      case "brush":
      case "eraser": {
        if (!hit) return;
        const stroke = new Brush3DStroke(s.tool === "eraser");
        stroke.add(hit.p, hit.n);
        this.drag = { kind: "brush", stroke };
        return take();
      }
      case "eyedropper": {
        if (!hit) return;
        e.stopImmediatePropagation();
        const [r, g, b, a] = samplePreview(hit.t.x, hit.t.y);
        const hex = rgbaToHex({ r, g, b, a: a / 255 });
        if (e.shiftKey) s.setSecondary(hex);
        else s.setPrimary(hex);
        s.notify(`Kleur opgepikt: ${hex}`);
        return;
      }
      default:
        return;
    }
  };

  onDragMove = (e: PointerEvent) => {
    const d = this.drag;
    if (!d) return;
    const s = useEditor.getState();
    const doc = activeDoc(s.project);
    const begin = (dd: { moved: boolean }) => {
      if (!dd.moved) {
        s.checkpoint();
        dd.moved = true;
      }
    };
    switch (d.kind) {
      case "brush": {
        const hit = this.pick(e.clientX, e.clientY);
        if (hit) d.stroke.add(hit.p, hit.n);
        this.hover = hit;
        this.overlayDirty = true;
        return;
      }
      case "move3d": {
        const l = d.orig;
        const proj = l.projection!;
        if (d.slide) {
          this.setRay(e.clientX, e.clientY);
          const ray = this.rayV3();
          const P = rayToPlane(frameOf(proj), ray.o, ray.d);
          if (!P) return;
          begin(d);
          s.updateLayer(d.id, { x: P.x - d.grab.x, y: P.y - d.grab.y }, false);
          return;
        }
        const hit = this.pick(e.clientX, e.clientY);
        if (!hit) return;
        begin(d);
        const N = s.projectFrom === "view" ? proj.normal : hit.n;
        const up = defaultUp(N, proj.up);
        const f = frameOf({ ...proj, origin: hit.p, normal: N, up });
        const gx = (l.x + d.grab.x) * f.upp, gy = (l.y + d.grab.y) * f.upp;
        const origin: V3 = [hit.p[0] - f.U[0] * gx - f.D[0] * gy, hit.p[1] - f.U[1] * gx - f.D[1] * gy, hit.p[2] - f.U[2] * gx - f.D[2] * gy];
        s.updateLayer(d.id, { projection: { ...proj, origin, normal: N, up } }, false);
        return;
      }
      case "moveUv": {
        const hit = this.pick(e.clientX, e.clientY);
        if (!hit) return;
        begin(d);
        s.updateLayer(d.id, { x: d.orig.x + hit.t.x * doc.width - d.start.x, y: d.orig.y + hit.t.y * doc.height - d.start.y }, false);
        return;
      }
      case "moveLine": {
        const hit = this.pick(e.clientX, e.clientY);
        if (!hit) return;
        begin(d);
        const dv: V3 = [hit.p[0] - d.start[0], hit.p[1] - d.start[1], hit.p[2] - d.start[2]];
        s.updateLayer(d.id, { points: d.orig.map((q) => ({ p: [q.p[0] + dv[0], q.p[1] + dv[1], q.p[2] + dv[2]] as V3, n: q.n })) } as Partial<Layer>, false);
        return;
      }
      case "scale":
      case "rotate":
      case "create":
      case "nodePlane": {
        const l = doc.layers.find((x) => x.id === d.id);
        if (!l?.projection) return;
        const f = d.kind === "create" ? d.frame : frameOf(l.projection);
        this.setRay(e.clientX, e.clientY);
        const ray = this.rayV3();
        const P = rayToPlane(f, ray.o, ray.d);
        if (!P) return;
        if (d.kind === "scale") {
          begin(d);
          s.updateLayer(d.id, scaleByCorner(d.orig, doc.width, doc.height, d.corner, P, e.shiftKey || d.orig.type === "text" || d.orig.type === "image"), false);
        } else if (d.kind === "rotate") {
          begin(d);
          let rot = d.orig.rotation + (Math.atan2(P.y - d.orig.y, P.x - d.orig.x) - d.startAngle) / DEG;
          if (e.shiftKey) rot = Math.round(rot / 15) * 15;
          s.updateLayer(d.id, { rotation: normalizeAngle(rot) }, false);
        } else if (d.kind === "create") {
          const sh = l as ShapeLayer;
          if (sh.geometry.kind === "path") return;
          let w = P.x, h = P.y;
          if (e.shiftKey) {
            const m = Math.max(Math.abs(w), Math.abs(h));
            w = Math.sign(w || 1) * m;
            h = Math.sign(h || 1) * m;
          }
          const centered = e.altKey;
          s.updateLayer(
            d.id,
            { x: centered ? 0 : w / 2, y: centered ? 0 : h / 2, geometry: { ...sh.geometry, w: Math.max(1, Math.abs(centered ? 2 * w : w)), h: Math.max(1, Math.abs(centered ? 2 * h : h)) } } as Partial<Layer>,
            false,
          );
        } else if (d.kind === "nodePlane" && l.type === "shape" && l.geometry.kind === "path") {
          begin(d);
          const pts = l.geometry.points.slice();
          pts[d.index] = toLocal(l, P);
          s.updateLayer(d.id, { geometry: { ...l.geometry, points: pts } } as Partial<Layer>, false);
        }
        return;
      }
      case "node3d": {
        const hit = this.pick(e.clientX, e.clientY);
        const l = doc.layers.find((x) => x.id === d.id);
        if (!hit || l?.type !== "surfaceLine") return;
        begin(d);
        const pts = l.points.slice();
        pts[d.index] = { p: hit.p, n: hit.n };
        s.updateLayer(d.id, { points: pts } as Partial<Layer>, false);
        return;
      }
    }
  };

  onDragEnd = () => {
    window.removeEventListener("pointermove", this.onDragMove);
    this.controls.enabled = true;
    const d = this.drag;
    this.drag = null;
    if (!d) return;
    const s = useEditor.getState();
    const doc = activeDoc(s.project);
    if (d.kind === "brush") void d.stroke.end();
    if (d.kind === "create") {
      const l = doc.layers.find((x) => x.id === d.id) as ShapeLayer | undefined;
      if (l?.projection && l.geometry.kind !== "path") {
        const tiny = l.geometry.w < 20 && l.geometry.h < 20;
        const g = tiny ? { ...l.geometry, w: 400, h: 400 } : l.geometry;
        // Move the projector origin to the shape centre so later moves re-anchor nicely.
        const origin = fromPlane(frameOf(l.projection), tiny ? 0 : l.x, tiny ? 0 : l.y);
        s.updateLayer(l.id, { geometry: g, x: 0, y: 0, projection: { ...l.projection, origin } } as Partial<Layer>, false);
      }
    }
    if (d.kind === "moveLine" && d.moved) {
      const l = doc.layers.find((x) => x.id === d.id);
      if (l?.type === "surfaceLine") s.updateLayer(l.id, { points: l.points.map((q) => this.snapToSurface(q.p, q.n)) } as Partial<Layer>, false);
    }
    this.overlayDirty = true;
  };

  onHoverMove = (e: PointerEvent) => {
    this.pointer = this.local(e);
    const tool = useEditor.getState().tool;
    if (!this.drag && (tool === "brush" || tool === "eraser" || this.draft || tool === "stripes" || tool === "path")) {
      this.hover = this.pick(e.clientX, e.clientY);
      this.overlayDirty = true;
    }
  };

  onDblClick = () => {
    if (this.draft) this.finishDraft(false);
  };

  onKey = (e: KeyboardEvent) => {
    const t = e.target as HTMLElement;
    if (t.tagName === "INPUT" || t.tagName === "TEXTAREA") return;
    if (!this.draft) return;
    if (e.key === "Enter") this.finishDraft(false);
    else if (e.key === "Escape") this.draft = null;
    else if (e.key === "Backspace") {
      if (this.draft.kind === "path" && this.draft.points.length > 1) this.draft.points.pop();
      else if (this.draft.kind === "line") this.draft.points.pop();
    }
    this.overlayDirty = true;
  };

  finishDraft(closed: boolean) {
    const d = this.draft;
    this.draft = null;
    this.overlayDirty = true;
    if (!d) return;
    const s = useEditor.getState();
    if (d.kind === "line") {
      if (d.points.length < 2) return;
      const preset = STRIPE_PRESETS[s.stripePreset] ?? STRIPE_PRESETS[0];
      s.addLayer(makeSurfaceLine(d.points, preset.stripes, preset.gap, s.symmetry));
      return;
    }
    if (d.points.length < 2) return;
    const { points, cx, cy } = recenter(d.points);
    const layer = makeShape({ kind: "path", points, closed, smooth: false }, 0, 0, s.primary);
    layer.projection = { ...d.proj, origin: fromPlane(d.frame, cx, cy) };
    if (!closed) {
      layer.fill = { type: "none" };
      layer.stroke = { paint: { type: "solid", color: s.primary }, width: s.shapeOpts.strokeWidth, dash: [], cap: "round", join: "round" };
    } else if (s.shapeOpts.withStroke) {
      layer.stroke = { paint: { type: "solid", color: s.secondary }, width: s.shapeOpts.strokeWidth, dash: [], cap: "round", join: "round" };
    }
    s.addLayer(layer);
  }

  // ---------------------------------------------------------------- overlay
  drawOverlay() {
    const ctx = this.overlayCtx;
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.overlay.width, this.overlay.height);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const s = useEditor.getState();
    const doc = activeDoc(s.project);
    const sym = currentMesh()?.symmetryX ?? 0;
    const poly = (pts: Vec2[], close: boolean) => {
      ctx.beginPath();
      pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
      if (close) ctx.closePath();
      ctx.stroke();
    };

    for (const l of doc.layers.filter((x) => s.selection.includes(x.id))) {
      if (l.type === "surfaceLine") {
        const pts = linePts(l);
        ctx.strokeStyle = "#4da3ff";
        ctx.lineWidth = 1.5;
        ctx.setLineDash([5, 4]);
        poly(pts.map((p) => this.toScreen(p)), false);
        if (l.mirror) {
          ctx.strokeStyle = "rgba(77,163,255,0.45)";
          poly(pts.map((p) => this.toScreen(mirrorPoint(p, sym))), false);
        }
        ctx.setLineDash([]);
        if (s.tool === "nodes")
          for (const q of l.points) {
            const c = this.toScreen(q.p);
            ctx.fillStyle = "#ffc400";
            ctx.beginPath();
            ctx.arc(c.x, c.y, 5, 0, Math.PI * 2);
            ctx.fill();
          }
        continue;
      }
      if (!l.projection || !isProjected(l)) continue;
      const g = this.gizmo(l, doc)!;
      ctx.strokeStyle = "#4da3ff";
      ctx.lineWidth = 1.5;
      ctx.setLineDash([5, 4]);
      poly(g.corners, true);
      if (l.projection.mirror) {
        const f2 = mirrorFrame(frameOf(l.projection), sym, l.projection.mirrorReadable);
        ctx.strokeStyle = "rgba(77,163,255,0.45)";
        poly(docCorners(l, doc.width, doc.height).map((c) => this.toScreen(fromPlane(f2, c.x, c.y))), true);
      }
      ctx.setLineDash([]);
      if (s.tool === "select" && s.selection.length === 1 && !l.locked) {
        ctx.strokeStyle = "#4da3ff";
        ctx.fillStyle = "#fff";
        for (const c of g.corners) {
          ctx.fillRect(c.x - HANDLE / 2, c.y - HANDLE / 2, HANDLE, HANDLE);
          ctx.strokeRect(c.x - HANDLE / 2, c.y - HANDLE / 2, HANDLE, HANDLE);
        }
        ctx.beginPath();
        ctx.moveTo(g.top.x, g.top.y);
        ctx.lineTo(g.rot.x, g.rot.y);
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(g.rot.x, g.rot.y, HANDLE / 1.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }
      if (s.tool === "nodes" && l.type === "shape" && l.geometry.kind === "path") {
        const f = frameOf(l.projection);
        for (const q of l.geometry.points) {
          const d = toDoc(l, q);
          const c = this.toScreen(fromPlane(f, d.x, d.y));
          ctx.fillStyle = "#ffc400";
          ctx.beginPath();
          ctx.arc(c.x, c.y, 5, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }

    // drafts
    const d = this.draft;
    if (d) {
      ctx.strokeStyle = "#ffc400";
      ctx.lineWidth = 2;
      let pts: Vec2[];
      if (d.kind === "path") {
        let planePts = d.points;
        if (this.pointer) {
          const r = this.renderer.domElement.getBoundingClientRect();
          this.setRay(this.pointer.x + r.left, this.pointer.y + r.top);
          const ray = this.rayV3();
          const P = rayToPlane(d.frame, ray.o, ray.d);
          if (P) planePts = [...planePts, P];
        }
        pts = planePts.map((p) => this.toScreen(fromPlane(d.frame, p.x, p.y)));
        poly(pts, false);
      } else {
        const all = this.hover ? [...d.points.map((q) => q.p), this.hover.p] : d.points.map((q) => q.p);
        pts = smoothPolyline(all.map((p) => this.toScreen(p)), false);
        poly(pts, false);
        pts = d.points.map((q) => this.toScreen(q.p));
      }
      for (const p of pts) {
        ctx.fillStyle = "#ffc400";
        ctx.fillRect(p.x - 4, p.y - 4, 8, 8);
      }
    }

    // brush cursor
    if ((s.tool === "brush" || s.tool === "eraser") && this.hover) {
      const c = this.toScreen(this.hover.p);
      const dist = this.camera.position.distanceTo(new THREE.Vector3(...this.hover.p));
      const r = ((s.brush.size * 0.001) / 2 / (dist * Math.tan((this.camera.fov * DEG) / 2))) * (this.h / 2);
      ctx.strokeStyle = "rgba(255,255,255,0.9)";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(c.x, c.y, Math.max(2, r), 0, Math.PI * 2);
      ctx.stroke();
      if (s.symmetry) {
        const m = this.toScreen(mirrorPoint(this.hover.p, sym));
        ctx.strokeStyle = "rgba(255,255,255,0.4)";
        ctx.beginPath();
        ctx.arc(m.x, m.y, Math.max(2, r), 0, Math.PI * 2);
        ctx.stroke();
      }
    }
  }

  // ---------------------------------------------------------------- external API
  /** Places an imported image as a decal where the given screen point (default: centre) hits the model. */
  async placeImage(file: File, clientX?: number, clientY?: number): Promise<boolean> {
    const r = this.renderer.domElement.getBoundingClientRect();
    const hit = this.pick(clientX ?? r.left + r.width / 2, clientY ?? r.top + r.height / 2);
    if (!hit) return false;
    const res = await fileToImageLayer(file);
    if (!res) return true;
    const { layer, natW, natH } = res;
    const s = useEditor.getState();
    const scale = Math.min(600 / natW, 600 / natH); // ~60 cm on the longest side
    layer.w = natW * scale;
    layer.h = natH * scale;
    layer.projection = this.newProjection(hit);
    s.addLayer(layer, true);
    s.set({ tool: "select" });
    return true;
  }

  /** Snapshot of the current view, cover-fitted into w×h. */
  capture(w: number, h: number): HTMLCanvasElement {
    this.renderer.render(this.scene, this.camera);
    const src = this.renderer.domElement;
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    const ctx = c.getContext("2d")!;
    const scale = Math.max(w / src.width, h / src.height);
    const sw = w / scale, sh = h / scale;
    ctx.drawImage(src, (src.width - sw) / 2, (src.height - sh) / 2, sw, sh, 0, 0, w, h);
    return c;
  }
}

let controller: ViewportController | null = null;
export const viewport = () => controller;

export function Viewport3D() {
  const hostRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const vc = new ViewportController(hostRef.current!, overlayRef.current!);
    return () => vc.dispose();
  }, []);
  const onDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    for (const f of Array.from(e.dataTransfer.files)) {
      const ok = await controller?.placeImage(f, e.clientX, e.clientY);
      if (!ok) useEditor.getState().notify("Laat de afbeelding op het model los om hem te plaatsen", "error");
    }
  };
  return (
    <div className="viewport3d" ref={hostRef} onDragOver={(e) => e.preventDefault()} onDrop={onDrop}>
      <canvas ref={overlayRef} className="overlay" />
      <ViewportHud />
    </div>
  );
}

function ViewportHud() {
  const tool = useEditor((s) => s.tool);
  const symmetry = useEditor((s) => s.symmetry);
  const projectFrom = useEditor((s) => s.projectFrom);
  const set = useEditor((s) => s.set);
  const hints: Record<string, string> = {
    select: "Klik op een ontwerp om te selecteren · sleep = verplaatsen over het oppervlak (Ctrl = in vlak schuiven) · hoeken = schalen · bol = draaien",
    brush: "Schilder direct op het model · Alt/rechts slepen = draaien",
    eraser: "Gum op de penseellaag",
    stripes: "Klik punten óp het model · dubbelklik/Enter = klaar · lijn loopt naadloos om hoeken",
    path: "Klik punten · klik op eerste punt = gesloten vorm · dubbelklik/Enter = open lijn",
    rect: "Sleep op het model (Shift = vierkant, Alt = vanuit midden)",
    ellipse: "Sleep op het model (Shift = cirkel, Alt = vanuit midden)",
    polygon: "Sleep op het model",
    star: "Sleep op het model",
    text: "Klik op het model om tekst te plaatsen",
    eyedropper: "Klik = primaire kleur · Shift+klik = secundaire kleur",
    nodes: "Sleep punten · Alt+klik = verwijderen · Ctrl+klik op model = punt toevoegen",
    hand: "Slepen = draaien · middelste knop = schuiven · scroll = zoomen",
  };
  return (
    <div className="vp-hud">
      <div className="vp-buttons">
        {(["left", "right", "front", "back", "top", "persp"] as const).map((v) => (
          <button key={v} onClick={() => controller?.frameAll(v)}>
            {{ left: "Links", right: "Rechts", front: "Voor", back: "Achter", top: "Boven", persp: "3/4" }[v]}
          </button>
        ))}
        <span className="sep" />
        <button className={symmetry ? "on" : ""} onClick={() => set({ symmetry: !symmetry })} title="Nieuwe ontwerpen en penseelstreken ook gespiegeld op de andere kant">
          ⇋ Spiegelen L/R
        </button>
        <button
          className={projectFrom === "view" ? "on" : ""}
          onClick={() => set({ projectFrom: projectFrom === "view" ? "surface" : "view" })}
          title="Projecteer nieuwe decals vanuit de camera (handig over afgeronde hoeken) i.p.v. loodrecht op het oppervlak"
        >
          ◎ Vanuit camera
        </button>
      </div>
      {hints[tool] && <div className="hint">{hints[tool]}</div>}
    </div>
  );
}
