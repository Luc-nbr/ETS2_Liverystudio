// GPU texture-space baker.
//
// The paintable mesh is rasterised in UV space (gl_Position = uv). Every fragment
// therefore corresponds to one texel and knows its 3D position + normal. Decals,
// surface lines and brush dabs are evaluated in 3D and written to that texel.
// Result: designs flow across UV seams and around corners without breaks.
// A few offset passes dilate UV islands so mip-mapping never shows seams.

import * as THREE from "three";
import { parseColor } from "../color/color";
import { docCorners } from "../editor/geometry";
import { drawLayer, resolveColor, setProjectionHook } from "../editor/render";
import type { Layer, PaletteColor, RasterLayer, SurfaceLineLayer, TextureDoc, V3 } from "../editor/types";
import { frameOf, mirrorDir, mirrorFrame, mirrorPoint, norm, type Frame } from "./frame";
import type { PaintMesh } from "./mesh";

const VERT = /* glsl */ `
uniform vec2 uOffset;
uniform float uZ;
uniform float uFlipV;
varying vec3 vPos;
varying vec3 vNrm;
void main() {
  vPos = position;
  vNrm = normal;
  float y = uFlipV > 0.5 ? uv.y * 2.0 - 1.0 : 1.0 - uv.y * 2.0;
  gl_Position = vec4(uv.x * 2.0 - 1.0 + uOffset.x, y + uOffset.y, uZ, 1.0);
}`;

const COMMON = /* glsl */ `
varying vec3 vPos;
varying vec3 vNrm;
vec3 safeNormal(vec3 n) { float l = length(n); return l > 1e-6 ? n / l : vec3(0.0, 1.0, 0.0); }
vec4 over(vec4 top, vec4 bot) {
  float a = top.a + bot.a * (1.0 - top.a);
  if (a <= 0.0) return vec4(0.0);
  return vec4((top.rgb * top.a + bot.rgb * bot.a * (1.0 - top.a)) / a, a);
}
`;

const DECAL_FRAG = /* glsl */ `
${COMMON}
uniform sampler2D uTex;
uniform vec3 uO; uniform vec3 uU; uniform vec3 uD; uniform vec3 uN;
uniform vec3 uO2; uniform vec3 uU2; uniform vec3 uD2; uniform vec3 uN2;
uniform float uUpp;
uniform float uMirror;
uniform vec4 uRect;
uniform float uDepth;
uniform float uCos;
vec4 samp(vec3 O, vec3 U, vec3 D, vec3 N) {
  vec3 d = vPos - O;
  if (abs(dot(d, N)) > uDepth) return vec4(0.0);
  float f = dot(safeNormal(vNrm), N);
  float fade = smoothstep(uCos - 0.04, uCos + 0.04, f);
  if (fade <= 0.0) return vec4(0.0);
  vec2 q = vec2(dot(d, U), dot(d, D)) / uUpp;
  vec2 t = (q - uRect.xy) / uRect.zw;
  if (t.x < 0.0 || t.y < 0.0 || t.x > 1.0 || t.y > 1.0) return vec4(0.0);
  vec4 c = texture2D(uTex, t);
  if (c.a <= 0.0) return vec4(0.0);
  c.rgb /= c.a; // texture is uploaded premultiplied for correct filtering
  c.a *= fade;
  return c;
}
void main() {
  vec4 c = samp(uO, uU, uD, uN);
  if (uMirror > 0.5) c = over(c, samp(uO2, uU2, uD2, uN2));
  gl_FragColor = c;
}`;

const MAX_BANDS = 16;
const LINE_FRAG = /* glsl */ `
${COMMON}
uniform sampler2D uPts;
uniform sampler2D uNrms;
uniform float uCount;
uniform float uTexW;
uniform vec4 uSphere;
uniform float uHalf;
uniform vec4 uBandColor[${MAX_BANDS}];
uniform vec2 uBand[${MAX_BANDS}];
uniform float uBands;
uniform float uRound;
uniform vec2 uDash;
uniform float uMirror;
uniform float uSymX;
vec4 P(float i) { return texture2D(uPts, vec2((i + 0.5) / uTexW, 0.5)); }
vec3 NR(float i) { return texture2D(uNrms, vec2((i + 0.5) / uTexW, 0.5)).xyz; }
vec4 lineAt(vec3 p, vec3 n) {
  if (distance(p, uSphere.xyz) > uSphere.w + uHalf) return vec4(0.0);
  float best = 1e9; vec3 bc = vec3(0.0); vec3 bdir = vec3(1.0, 0.0, 0.0);
  float balong = 0.0; float braw = 0.0; float bi = 0.0; float bt = 0.0;
  for (int i = 0; i < 4096; i++) {
    float fi = float(i);
    if (fi >= uCount - 1.0) break;
    vec4 A = P(fi); vec4 B = P(fi + 1.0);
    vec3 ab = B.xyz - A.xyz;
    float L2 = max(dot(ab, ab), 1e-12);
    float tr = dot(p - A.xyz, ab) / L2;
    float t = clamp(tr, 0.0, 1.0);
    vec3 c = A.xyz + ab * t;
    float d = distance(p, c);
    if (d < best) { best = d; bc = c; bdir = ab / sqrt(L2); balong = A.w + t * sqrt(L2); braw = tr; bi = fi; bt = t; }
  }
  if (best > uHalf) return vec4(0.0);
  vec3 bn = safeNormal(mix(NR(bi), NR(bi + 1.0), bt));
  if (dot(safeNormal(n), bn) < 0.2) return vec4(0.0);
  if (abs(dot(p - bc, bn)) > max(uHalf, 0.03)) return vec4(0.0);
  vec3 side = safeNormal(cross(bn, bdir));
  float lat = dot(p - bc, side);
  bool cap = (bi < 0.5 && braw < 0.0) || (bi > uCount - 2.5 && braw > 1.0);
  if (cap) { if (uRound < 0.5) return vec4(0.0); lat = (lat < 0.0 ? -1.0 : 1.0) * best; }
  if (uDash.x > 0.0 && mod(balong, uDash.x + uDash.y) > uDash.x) return vec4(0.0);
  for (int k = 0; k < ${MAX_BANDS}; k++) {
    if (float(k) >= uBands) break;
    vec2 r = uBand[k];
    if (lat >= r.x && lat < r.y) return uBandColor[k];
  }
  return vec4(0.0);
}
void main() {
  vec3 n = safeNormal(vNrm);
  vec4 c = lineAt(vPos, n);
  if (uMirror > 0.5) c = over(c, lineAt(vec3(2.0 * uSymX - vPos.x, vPos.yz), vec3(-n.x, n.yz)));
  gl_FragColor = c;
}`;

const MAX_DABS = 96;
const DAB_FRAG = /* glsl */ `
${COMMON}
uniform vec4 uDab[${MAX_DABS}];
uniform vec3 uDabN[${MAX_DABS}];
uniform float uDabCount;
uniform float uHard;
uniform vec4 uColor;
void main() {
  vec3 n = safeNormal(vNrm);
  float cov = 0.0;
  for (int i = 0; i < ${MAX_DABS}; i++) {
    if (float(i) >= uDabCount) break;
    vec4 d = uDab[i];
    float dist = distance(vPos, d.xyz);
    if (dist > d.w || dot(n, uDabN[i]) < 0.1) continue;
    float c = uHard >= 0.99 ? 1.0 : 1.0 - smoothstep(d.w * uHard, d.w, dist);
    cov = max(cov, c);
  }
  gl_FragColor = vec4(uColor.rgb, uColor.a * cov);
}`;

// Dilation offsets in pixels (ring 1 wins over ring 2 through the depth test).
const RINGS: { r: number; z: number }[] = [
  { r: 2, z: 0.3 },
  { r: 5, z: 0.6 },
];
const DIRS = [
  [1, 0], [-1, 0], [0, 1], [0, -1],
  [0.7071, 0.7071], [-0.7071, 0.7071], [0.7071, -0.7071], [-0.7071, -0.7071],
];

function baseUniforms() {
  return { uOffset: { value: new THREE.Vector2() }, uZ: { value: 0 }, uFlipV: { value: 0 } };
}

function material(frag: string, uniforms: Record<string, THREE.IUniform>) {
  return new THREE.ShaderMaterial({
    vertexShader: VERT,
    fragmentShader: frag,
    uniforms: { ...baseUniforms(), ...uniforms },
    side: THREE.DoubleSide,
    blending: THREE.NoBlending,
    depthTest: true,
    depthWrite: true,
    depthFunc: THREE.LessDepth,
  });
}

const v3 = (a: V3) => new THREE.Vector3(a[0], a[1], a[2]);

function colorVec(hex: string): THREE.Vector4 {
  const c = parseColor(hex) ?? { r: 255, g: 0, b: 255, a: 1 };
  return new THREE.Vector4(c.r / 255, c.g / 255, c.b / 255, c.a);
}

interface CacheEntry {
  layer: Layer;
  paletteKey: string;
  w: number;
  h: number;
  epoch: number;
  canvas: HTMLCanvasElement;
}

export interface Dab {
  p: V3;
  n: V3;
  r: number;
}

export class Baker {
  readonly canvas = document.createElement("canvas");
  readonly renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private mesh: THREE.Mesh | null = null;
  private pm: PaintMesh | null = null;
  private flipV = false;
  private epoch = 1;
  private cache = new Map<string, CacheEntry>();
  private decalMat = material(DECAL_FRAG, {
    uTex: { value: null },
    uO: { value: new THREE.Vector3() }, uU: { value: new THREE.Vector3() }, uD: { value: new THREE.Vector3() }, uN: { value: new THREE.Vector3() },
    uO2: { value: new THREE.Vector3() }, uU2: { value: new THREE.Vector3() }, uD2: { value: new THREE.Vector3() }, uN2: { value: new THREE.Vector3() },
    uUpp: { value: 0.001 }, uMirror: { value: 0 }, uRect: { value: new THREE.Vector4() }, uDepth: { value: 0.3 }, uCos: { value: 0.2 },
  });
  private lineMat = material(LINE_FRAG, {
    uPts: { value: null }, uNrms: { value: null }, uCount: { value: 0 }, uTexW: { value: 1 },
    uSphere: { value: new THREE.Vector4() }, uHalf: { value: 0 },
    uBandColor: { value: Array.from({ length: MAX_BANDS }, () => new THREE.Vector4()) },
    uBand: { value: Array.from({ length: MAX_BANDS }, () => new THREE.Vector2()) },
    uBands: { value: 0 }, uRound: { value: 0 }, uDash: { value: new THREE.Vector2() }, uMirror: { value: 0 }, uSymX: { value: 0 },
  });
  private dabMat = material(DAB_FRAG, {
    uDab: { value: Array.from({ length: MAX_DABS }, () => new THREE.Vector4()) },
    uDabN: { value: Array.from({ length: MAX_DABS }, () => new THREE.Vector3()) },
    uDabCount: { value: 0 }, uHard: { value: 1 }, uColor: { value: new THREE.Vector4() },
  });
  private decalTexture: THREE.CanvasTexture | null = null;
  private decalCanvas = document.createElement("canvas");
  readonly maxSize: number;

  constructor() {
    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, alpha: true, premultipliedAlpha: false, preserveDrawingBuffer: true, antialias: false });
    this.renderer.autoClear = false;
    this.renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
    this.renderer.setPixelRatio(1);
    this.maxSize = Math.min(8192, this.renderer.capabilities.maxTextureSize);
  }

  get ready() {
    return !!this.mesh;
  }
  get paintMesh() {
    return this.pm;
  }

  setMesh(pm: PaintMesh | null, flipV: boolean) {
    if (this.mesh) this.scene.remove(this.mesh);
    this.pm = pm;
    this.flipV = flipV;
    this.mesh = pm && pm.paint.getAttribute("position") ? new THREE.Mesh(pm.paint, this.decalMat) : null;
    if (this.mesh) {
      this.mesh.frustumCulled = false;
      this.scene.add(this.mesh);
    }
    this.invalidate();
  }

  invalidate() {
    this.epoch++;
  }

  /** Texels per metre at the given bake width/height. */
  texelsPerMeter(w: number, h: number): number {
    const pm = this.pm;
    if (!pm || pm.worldArea <= 0 || pm.uvArea <= 0) return 1000;
    return Math.sqrt((pm.uvArea * w * h) / pm.worldArea);
  }

  /** Full dilation for exports; a single ring is enough for the interactive preview. */
  private exportPasses = false;

  private draw(mat: THREE.ShaderMaterial, w: number, h: number): HTMLCanvasElement {
    const r = this.renderer;
    r.setSize(w, h, false);
    r.setClearColor(0x000000, 0);
    r.clear(true, true, true);
    if (!this.mesh) return this.canvas;
    this.mesh.material = mat;
    mat.uniforms.uFlipV.value = this.flipV ? 1 : 0;
    mat.uniforms.uOffset.value.set(0, 0);
    mat.uniforms.uZ.value = 0;
    r.render(this.scene, this.camera);
    for (const ring of this.exportPasses ? RINGS : RINGS.slice(0, 1)) {
      for (const [dx, dy] of DIRS) {
        mat.uniforms.uOffset.value.set((dx * ring.r * 2) / w, (dy * ring.r * 2) / h);
        mat.uniforms.uZ.value = ring.z;
        r.render(this.scene, this.camera);
      }
    }
    return this.canvas;
  }

  // ------------------------------------------------------------------ decals
  private bakeDecal(layer: Layer, doc: TextureDoc, palette: PaletteColor[], w: number, h: number, exportQuality: boolean): HTMLCanvasElement | null {
    const proj = layer.projection!;
    const f = frameOf(proj);
    // Bounds of the layer on the projector plane (plane px), padded for strokes/shadows.
    const corners = docCorners(layer, doc.width, doc.height);
    let pad = 2;
    if ((layer.type === "shape" || layer.type === "text") && layer.stroke) pad += layer.stroke.width * Math.max(Math.abs(layer.scaleX), Math.abs(layer.scaleY));
    if (layer.shadow) pad += layer.shadow.blur * 2 + Math.max(Math.abs(layer.shadow.offsetX), Math.abs(layer.shadow.offsetY));
    const minX = Math.min(...corners.map((c) => c.x)) - pad, maxX = Math.max(...corners.map((c) => c.x)) + pad;
    const minY = Math.min(...corners.map((c) => c.y)) - pad, maxY = Math.max(...corners.map((c) => c.y)) + pad;
    const bw = Math.max(1, maxX - minX), bh = Math.max(1, maxY - minY);
    // Rasterise the vector content at (at least) the texel density of the bake.
    const maxDim = exportQuality ? this.maxSize : Math.min(this.maxSize, 2048);
    let k = this.texelsPerMeter(w, h) * f.upp * (exportQuality ? 2 : 1.25);
    k = Math.min(k, maxDim / Math.max(bw, bh));
    const cw = Math.max(2, Math.ceil(bw * k)), ch = Math.max(2, Math.ceil(bh * k));
    const dc = this.decalCanvas;
    dc.width = cw;
    dc.height = ch;
    const ctx = dc.getContext("2d")!;
    ctx.setTransform(k, 0, 0, k, -minX * k, -minY * k);
    ctx.imageSmoothingQuality = "high";
    drawLayer(ctx, layer, doc, palette, 1, "source-over");

    if (!this.decalTexture) {
      this.decalTexture = new THREE.CanvasTexture(dc);
      this.decalTexture.flipY = false;
      this.decalTexture.premultiplyAlpha = true;
      this.decalTexture.colorSpace = THREE.NoColorSpace;
      this.decalTexture.generateMipmaps = false;
      this.decalTexture.minFilter = THREE.LinearFilter;
      this.decalTexture.wrapS = this.decalTexture.wrapT = THREE.ClampToEdgeWrapping;
    }
    // Recreate the GL texture when the canvas size changes.
    const img = this.decalTexture.image as HTMLCanvasElement;
    if (img.width !== cw || img.height !== ch || this.decalTexture.userData.w !== cw || this.decalTexture.userData.h !== ch) {
      this.decalTexture.dispose();
      this.decalTexture.userData = { w: cw, h: ch };
    }
    this.decalTexture.needsUpdate = true;

    const u = this.decalMat.uniforms;
    const setFrame = (fr: Frame, suffix: string) => {
      u["uO" + suffix].value.copy(v3(fr.O));
      u["uU" + suffix].value.copy(v3(fr.U));
      u["uD" + suffix].value.copy(v3(fr.D));
      u["uN" + suffix].value.copy(v3(fr.N));
    };
    setFrame(f, "");
    const sym = this.pm?.symmetryX ?? 0;
    setFrame(mirrorFrame(f, sym, proj.mirrorReadable), "2");
    u.uTex.value = this.decalTexture;
    u.uUpp.value = f.upp;
    u.uMirror.value = proj.mirror ? 1 : 0;
    u.uRect.value.set(minX, minY, cw / k, ch / k);
    u.uDepth.value = proj.depth;
    u.uCos.value = Math.cos((Math.min(89, Math.max(1, proj.maxAngle)) * Math.PI) / 180);
    return this.draw(this.decalMat, w, h);
  }

  // ------------------------------------------------------------------ surface lines
  private pointsTex: THREE.DataTexture | null = null;
  private normalsTex: THREE.DataTexture | null = null;

  private bakeLine(layer: SurfaceLineLayer, palette: PaletteColor[], w: number, h: number): HTMLCanvasElement | null {
    const pts = sampleSurfaceLine(layer);
    if (pts.length < 2 || !layer.stripes.length) return null;
    const n = pts.length;
    const pd = new Float32Array(n * 4), nd = new Float32Array(n * 4);
    let along = 0;
    const center = [0, 0, 0];
    for (let i = 0; i < n; i++) {
      if (i > 0) along += Math.hypot(pts[i].p[0] - pts[i - 1].p[0], pts[i].p[1] - pts[i - 1].p[1], pts[i].p[2] - pts[i - 1].p[2]);
      pd.set([...pts[i].p, along], i * 4);
      nd.set([...pts[i].n, 0], i * 4);
      for (let k = 0; k < 3; k++) center[k] += pts[i].p[k] / n;
    }
    let radius = 0;
    for (const q of pts) radius = Math.max(radius, Math.hypot(q.p[0] - center[0], q.p[1] - center[1], q.p[2] - center[2]));
    this.pointsTex?.dispose();
    this.normalsTex?.dispose();
    const mk = (d: Float32Array) => {
      const t = new THREE.DataTexture(d, n, 1, THREE.RGBAFormat, THREE.FloatType);
      t.minFilter = t.magFilter = THREE.NearestFilter;
      t.needsUpdate = true;
      return t;
    };
    this.pointsTex = mk(pd);
    this.normalsTex = mk(nd);

    const mm = 0.001;
    const bands = layer.stripes.slice(0, MAX_BANDS);
    const total = (bands.reduce((s, b) => s + b.width, 0) + layer.gap * Math.max(0, bands.length - 1)) * mm;
    const u = this.lineMat.uniforms;
    let cursor = -total / 2;
    bands.forEach((b, i) => {
      u.uBand.value[i].set(cursor, cursor + b.width * mm);
      u.uBandColor.value[i].copy(colorVec(resolveColor(b.color, palette)));
      cursor += (b.width + layer.gap) * mm;
    });
    u.uBands.value = bands.length;
    u.uPts.value = this.pointsTex;
    u.uNrms.value = this.normalsTex;
    u.uCount.value = n;
    u.uTexW.value = n;
    u.uSphere.value.set(center[0], center[1], center[2], radius);
    u.uHalf.value = total / 2;
    u.uRound.value = layer.cap === "round" ? 1 : 0;
    u.uDash.value.set((layer.dash[0] ?? 0) * mm, (layer.dash[1] ?? layer.dash[0] ?? 0) * mm);
    u.uMirror.value = layer.mirror ? 1 : 0;
    u.uSymX.value = this.pm?.symmetryX ?? 0;
    return this.draw(this.lineMat, w, h);
  }

  // ------------------------------------------------------------------ public API
  /**
   * Bakes a projected layer / surface line into UV space at w×h.
   * `cache` keeps a copy per layer for the interactive preview; exports pass false
   * and must use the returned (shared) canvas immediately.
   */
  bake(layer: Layer, doc: TextureDoc, palette: PaletteColor[], w: number, h: number, cache: boolean): HTMLCanvasElement | null {
    if (!this.mesh) return null;
    const paletteKey = palette.map((p) => p.hex).join();
    if (cache) {
      const e = this.cache.get(layer.id);
      if (e && e.layer === layer && e.paletteKey === paletteKey && e.w === w && e.h === h && e.epoch === this.epoch) return e.canvas;
    }
    this.exportPasses = !cache;
    const out = layer.type === "surfaceLine" ? this.bakeLine(layer, palette, w, h) : layer.projection ? this.bakeDecal(layer, doc, palette, w, h, !cache) : null;
    if (!out || !cache) return out;
    let e = this.cache.get(layer.id);
    if (!e) {
      e = { layer, paletteKey, w, h, epoch: this.epoch, canvas: document.createElement("canvas") };
      this.cache.set(layer.id, e);
    }
    Object.assign(e, { layer, paletteKey, w, h, epoch: this.epoch });
    if (e.canvas.width !== w || e.canvas.height !== h) {
      e.canvas.width = w;
      e.canvas.height = h;
    }
    const ctx = e.canvas.getContext("2d")!;
    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(out, 0, 0);
    return e.canvas;
  }

  /** Drop cache entries of layers that no longer exist. */
  prune(liveIds: Set<string>) {
    for (const id of this.cache.keys()) if (!liveIds.has(id)) this.cache.delete(id);
  }

  /** Paints (or erases) brush dabs into a raster layer, evaluated on the 3D surface. */
  paintDabs(target: HTMLCanvasElement, layer: RasterLayer, dabs: Dab[], color: string, hardness: number, opacity: number, erase: boolean, mirror: boolean) {
    if (!this.mesh || !dabs.length) return;
    const sym = this.pm?.symmetryX ?? 0;
    const all: Dab[] = mirror ? dabs.flatMap((d) => [d, { p: mirrorPoint(d.p, sym), n: mirrorDir(d.n), r: d.r }]) : dabs;
    const ctx = target.getContext("2d")!;
    for (let start = 0; start < all.length; start += MAX_DABS) {
      const chunk = all.slice(start, start + MAX_DABS);
      const u = this.dabMat.uniforms;
      chunk.forEach((d, i) => {
        u.uDab.value[i].set(d.p[0], d.p[1], d.p[2], d.r);
        u.uDabN.value[i].copy(v3(norm(d.n)));
      });
      u.uDabCount.value = chunk.length;
      u.uHard.value = hardness;
      u.uColor.value.copy(colorVec(erase ? "#000000" : color));
      const out = this.draw(this.dabMat, layer.w, layer.h);
      ctx.save();
      ctx.globalAlpha = opacity;
      ctx.globalCompositeOperation = erase ? "destination-out" : "source-over";
      ctx.drawImage(out, 0, 0, target.width, target.height);
      ctx.restore();
    }
  }
}

/** Smooths (Catmull-Rom) and resamples a surface line to a dense point list. */
export function sampleSurfaceLine(layer: SurfaceLineLayer, maxPoints = 1024): { p: V3; n: V3 }[] {
  const src = layer.points;
  if (src.length < 2) return src.map((q) => ({ p: q.p, n: q.n }));
  const seg = layer.smooth && src.length > 2 ? Math.max(2, Math.min(24, Math.floor(maxPoints / src.length))) : 1;
  const out: { p: V3; n: V3 }[] = [];
  const get = (i: number) => src[Math.max(0, Math.min(src.length - 1, i))];
  for (let i = 0; i < src.length - 1; i++) {
    const p0 = get(i - 1).p, p1 = get(i).p, p2 = get(i + 1).p, p3 = get(i + 2).p;
    const n1 = get(i).n, n2 = get(i + 1).n;
    for (let s = 0; s < seg; s++) {
      const t = s / seg, t2 = t * t, t3 = t2 * t;
      const cr = (k: number) =>
        seg === 1 ? p1[k] : 0.5 * (2 * p1[k] + (-p0[k] + p2[k]) * t + (2 * p0[k] - 5 * p1[k] + 4 * p2[k] - p3[k]) * t2 + (-p0[k] + 3 * p1[k] - 3 * p2[k] + p3[k]) * t3);
      out.push({ p: [cr(0), cr(1), cr(2)], n: norm([n1[0] * (1 - t) + n2[0] * t, n1[1] * (1 - t) + n2[1] * t, n1[2] * (1 - t) + n2[2] * t]) });
    }
  }
  out.push({ p: src[src.length - 1].p, n: src[src.length - 1].n });
  return out;
}

// ---------------------------------------------------------------------------
// Singleton + hook into the 2D renderer
// ---------------------------------------------------------------------------

let baker: Baker | null = null;
export function getBaker(): Baker {
  if (!baker) baker = new Baker();
  return baker;
}

/** Preview bake resolution (longest side). Exports always bake at full resolution. */
export const PREVIEW_RES = 2048;

setProjectionHook((ctx, layer, doc, palette, bakeWidth, exportQuality) => {
  const b = getBaker();
  if (!b.ready) return false;
  const w = Math.max(64, Math.round(bakeWidth));
  const h = Math.max(64, Math.round((bakeWidth * doc.height) / doc.width));
  const c = b.bake(layer, doc, palette, Math.min(w, b.maxSize), Math.min(h, b.maxSize), !exportQuality);
  if (!c) return true;
  ctx.drawImage(c, 0, 0, doc.width, doc.height);
  return true;
});
