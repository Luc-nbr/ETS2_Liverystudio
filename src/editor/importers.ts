import { makeImage } from "./factory";
import type { ImageLayer } from "./types";
import { activeDoc, useEditor } from "./store";

export function readAsDataUrl(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result as string);
    fr.onerror = () => reject(fr.error);
    fr.readAsDataURL(file);
  });
}

function svgSize(svgText: string): { w: number; h: number } {
  const doc = new DOMParser().parseFromString(svgText, "image/svg+xml");
  const el = doc.documentElement;
  const num = (v: string | null) => (v && !v.endsWith("%") ? parseFloat(v) : NaN);
  let w = num(el.getAttribute("width")), h = num(el.getAttribute("height"));
  const vb = el.getAttribute("viewBox")?.split(/[\s,]+/).map(Number);
  if ((!Number.isFinite(w) || !Number.isFinite(h)) && vb && vb.length === 4) {
    w = vb[2];
    h = vb[3];
  }
  return { w: Number.isFinite(w) ? w : 1024, h: Number.isFinite(h) ? h : 1024 };
}

/** Make sure an SVG has explicit width/height so browsers rasterise it at any requested size. */
function normaliseSvg(svgText: string): string {
  const doc = new DOMParser().parseFromString(svgText, "image/svg+xml");
  const el = doc.documentElement;
  const { w, h } = svgSize(svgText);
  if (!el.getAttribute("viewBox")) el.setAttribute("viewBox", `0 0 ${w} ${h}`);
  el.setAttribute("width", String(w));
  el.setAttribute("height", String(h));
  el.setAttribute("preserveAspectRatio", "none");
  return new XMLSerializer().serializeToString(el);
}

function imageSize(src: string): Promise<{ w: number; h: number }> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve({ w: img.naturalWidth || 1024, h: img.naturalHeight || 1024 });
    img.onerror = () => reject(new Error("Kan afbeelding niet lezen"));
    img.src = src;
  });
}

/** Reads PNG/JPG/WebP/SVG into an (unplaced) image layer; returns null for unsupported files. */
export async function fileToImageLayer(file: File): Promise<{ layer: ImageLayer; natW: number; natH: number } | null> {
  const s = useEditor.getState();
  const isSvg = file.type === "image/svg+xml" || file.name.toLowerCase().endsWith(".svg");
  let src: string;
  let size: { w: number; h: number };
  if (isSvg) {
    const text = await file.text();
    const svg = normaliseSvg(text);
    size = svgSize(svg);
    src = "data:image/svg+xml;base64," + btoa(unescape(encodeURIComponent(svg)));
  } else if (file.type.startsWith("image/")) {
    src = await readAsDataUrl(file);
    size = await imageSize(src);
  } else {
    s.notify(`Bestandstype niet ondersteund: ${file.name}`, "error");
    return null;
  }
  const layer = makeImage(src, isSvg, size.w, size.h, 0, 0, file.name.replace(/\.[^.]+$/, ""));
  return { layer, natW: size.w, natH: size.h };
}

/** Imports an image directly into texture (UV) space, centred on (x, y) in doc px. */
export async function importImageFile(file: File, x?: number, y?: number): Promise<void> {
  const s = useEditor.getState();
  const doc = activeDoc(s.project);
  const res = await fileToImageLayer(file);
  if (!res) return;
  const { layer, natW, natH } = res;
  // Fit into half of the texture, but never upscale bitmaps by default (keeps them lossless).
  let scale = Math.min((doc.width * 0.5) / natW, (doc.height * 0.5) / natH);
  if (!layer.isSvg) scale = Math.min(1, scale);
  layer.w = natW * scale;
  layer.h = natH * scale;
  layer.x = x ?? doc.width / 2;
  layer.y = y ?? doc.height / 2;
  s.addLayer(layer, true);
  s.set({ tool: "select" });
}

/** Loads an image file as the UV template overlay of the active texture. */
export async function importTemplate(file: File): Promise<void> {
  const s = useEditor.getState();
  const src = await readAsDataUrl(file);
  s.updateTexture(s.project.activeTextureId, { template: src });
  s.set({ showTemplate: true });
}

export function pickFile(accept: string): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = accept;
    input.onchange = () => resolve(input.files?.[0] ?? null);
    input.click();
  });
}
