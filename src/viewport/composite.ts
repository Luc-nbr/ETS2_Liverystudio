// The live texture shown on the 3D model: the active texture rendered at preview
// resolution (projected layers come from the baker's per-layer cache).

import { renderToCanvas } from "../editor/render";
import { activeDoc, useEditor } from "../editor/store";

export const PREVIEW_MAX = 2048;
export const previewCanvas = document.createElement("canvas");
let listeners: (() => void)[] = [];

export function previewSize(w: number, h: number) {
  const s = Math.min(1, PREVIEW_MAX / Math.max(w, h));
  return { w: Math.max(1, Math.round(w * s)), h: Math.max(1, Math.round(h * s)) };
}

export function renderPreview() {
  const s = useEditor.getState();
  const doc = activeDoc(s.project);
  const { w, h } = previewSize(doc.width, doc.height);
  renderToCanvas(doc, s.project.palette, w, h, previewCanvas);
  for (const l of listeners) l();
}

export function onPreviewUpdated(fn: () => void) {
  listeners.push(fn);
  return () => {
    listeners = listeners.filter((x) => x !== fn);
  };
}

/** Colour of the composite at texture coordinate (u, v) in 0..1 (doc orientation). */
export function samplePreview(u: number, v: number): [number, number, number, number] {
  const ctx = previewCanvas.getContext("2d", { willReadFrequently: true })!;
  const x = Math.min(previewCanvas.width - 1, Math.max(0, Math.floor(u * previewCanvas.width)));
  const y = Math.min(previewCanvas.height - 1, Math.max(0, Math.floor(v * previewCanvas.height)));
  const d = ctx.getImageData(x, y, 1, 1).data;
  return [d[0], d[1], d[2], d[3]];
}
