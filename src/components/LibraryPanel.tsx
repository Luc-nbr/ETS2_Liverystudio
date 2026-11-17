import { useMemo, useState } from "react";
import { makeImage } from "../editor/factory";
import { LIBRARY, svgSize, svgToDataUrl, type LibraryItem } from "../editor/library";
import { activeDoc, useEditor } from "../editor/store";
import { viewport } from "../viewport/Viewport3D";

/** Grid of built-in vector elements; click = place on the model at the view centre. */
export function LibraryPanel() {
  const [cat, setCat] = useState<string>("Alle");
  const [sizeMm, setSizeMm] = useState(800);
  const items = useMemo(() => LIBRARY.map((it) => ({ ...it, url: svgToDataUrl(it.svg) })), []);
  const cats = ["Alle", ...Array.from(new Set(LIBRARY.map((i) => i.category)))];

  const place = (it: LibraryItem & { url: string }) => {
    const s = useEditor.getState();
    const { w, h } = svgSize(it.svg);
    const layer = makeImage(it.url, true, w, h, 0, 0, it.name);
    layer.tint = s.primary;
    if (viewport()?.placeLayer(layer, sizeMm)) return;
    // No model under the view centre → put it in texture space.
    const doc = activeDoc(s.project);
    const k = Math.min((doc.width * 0.4) / w, (doc.height * 0.4) / h);
    layer.w = w * k;
    layer.h = h * k;
    layer.x = doc.width / 2;
    layer.y = doc.height / 2;
    s.addLayer(layer, true);
  };

  return (
    <div className="panel library-panel">
      <div className="panel-title">Bibliotheek</div>
      <p className="muted small">Klik om een element midden in beeld op het model te plaatsen (in de primaire kleur, lossless vector). Daarna verplaatsen/schalen met ➤.</p>
      <div className="row gap wrap">
        {cats.map((c) => (
          <button key={c} className={cat === c ? "on" : ""} onClick={() => setCat(c)}>
            {c}
          </button>
        ))}
      </div>
      <label className="field">
        <span>Grootte</span>
        <input type="number" value={sizeMm} min={20} onChange={(e) => setSizeMm(Math.max(20, Number(e.target.value) || 800))} />
        <em>mm (langste zijde)</em>
      </label>
      <div className="library-grid">
        {items
          .filter((i) => cat === "Alle" || i.category === cat)
          .map((it) => (
            <button key={it.id} className="lib-item" onClick={() => place(it)} title={it.name}>
              <img src={it.url} alt={it.name} />
              <span>{it.name}</span>
            </button>
          ))}
      </div>
    </div>
  );
}
