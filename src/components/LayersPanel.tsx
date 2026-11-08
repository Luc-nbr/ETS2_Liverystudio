import { useState } from "react";
import { makeFill, makeRaster } from "../editor/factory";
import { isProjected } from "../editor/render";
import { activeDoc, useEditor } from "../editor/store";
import type { Layer } from "../editor/types";

const ICON: Record<Layer["type"], string> = {
  shape: "▭",
  stripes: "≋",
  surfaceLine: "≋",
  text: "T",
  image: "🖼",
  raster: "🖌",
  fill: "■",
};

export function LayersPanel() {
  const doc = useEditor((s) => activeDoc(s.project));
  const selection = useEditor((s) => s.selection);
  const st = useEditor.getState;
  const [renaming, setRenaming] = useState<string | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const layers = [...doc.layers].reverse();

  return (
    <div className="panel layers-panel">
      <div className="panel-title">
        Lagen <span className="muted">({doc.layers.length})</span>
      </div>
      <div className="layer-list">
        {layers.map((l) => {
          const idx = doc.layers.indexOf(l);
          return (
            <div
              key={l.id}
              className={"layer-row" + (selection.includes(l.id) ? " sel" : "") + (l.clip ? " clipped" : "") + (dragId === l.id ? " dragging" : "")}
              onClick={(e) => st().select([l.id], e.shiftKey || e.ctrlKey)}
              draggable
              onDragStart={() => setDragId(l.id)}
              onDragEnd={() => setDragId(null)}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                if (dragId && dragId !== l.id) st().moveLayer(dragId, idx);
                setDragId(null);
              }}
            >
              <button
                className="eye"
                title="Zichtbaar"
                onClick={(e) => {
                  e.stopPropagation();
                  st().updateLayer(l.id, { visible: !l.visible });
                }}
              >
                {l.visible ? "👁" : "–"}
              </button>
              <span className="ltype" title={l.type}>
                {ICON[l.type]}
              </span>
              {isProjected(l) && (
                <span className="badge" title={l.type === "surfaceLine" ? "Lijn op het 3D-oppervlak" : "Geprojecteerd vanuit 3D (decal)"}>
                  3D
                </span>
              )}
              {((l.projection?.mirror ?? false) || (l.type === "surfaceLine" && l.mirror)) && <span className="badge mirror">⇋</span>}
              {renaming === l.id ? (
                <input
                  autoFocus
                  defaultValue={l.name}
                  onClick={(e) => e.stopPropagation()}
                  onBlur={(e) => {
                    st().updateLayer(l.id, { name: e.target.value || l.name });
                    setRenaming(null);
                  }}
                  onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
                />
              ) : (
                <span className="lname" onDoubleClick={() => setRenaming(l.id)}>
                  {l.name}
                </span>
              )}
              <button
                className="lock"
                title="Vergrendelen"
                onClick={(e) => {
                  e.stopPropagation();
                  st().updateLayer(l.id, { locked: !l.locked });
                }}
              >
                {l.locked ? "🔒" : "🔓"}
              </button>
            </div>
          );
        })}
      </div>
      <div className="row gap wrap layer-actions">
        <button title="Nieuwe penseellaag" onClick={() => st().addLayer(makeRaster(doc))}>
          + Penseel
        </button>
        <button title="Nieuwe vullaag (kleur/verloop over de hele textuur)" onClick={() => st().addLayer(makeFill("#ffffff", doc))}>
          + Vulling
        </button>
        <button disabled={!selection.length} onClick={() => st().duplicateLayers(selection)} title="Dupliceren (Ctrl+D)">
          ⧉
        </button>
        <button disabled={!selection.length} onClick={() => st().shiftLayers(selection, "up")} title="Omhoog">
          ▲
        </button>
        <button disabled={!selection.length} onClick={() => st().shiftLayers(selection, "down")} title="Omlaag">
          ▼
        </button>
        <button
          disabled={!selection.length}
          onClick={() => st().mapLayers(selection, (l) => ({ ...l, clip: !l.clip }))}
          title="Uitknipmasker: alleen zichtbaar binnen de laag eronder"
        >
          ⤓ Clip
        </button>
        <button className="danger" disabled={!selection.length} onClick={() => st().removeLayers(selection)} title="Verwijderen (Del)">
          🗑
        </button>
      </div>
    </div>
  );
}
