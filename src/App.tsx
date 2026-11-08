import { useEffect, useState } from "react";
import { Canvas2D } from "./components/Canvas2D";
import { ColorPanel } from "./components/ColorPanel";
import { ExportDialog } from "./components/ExportDialog";
import { GamePanel } from "./components/GamePanel";
import { LayersPanel } from "./components/LayersPanel";
import { PropertiesPanel } from "./components/PropertiesPanel";
import { TOOL_KEYS, Toolbar, ToolOptions } from "./components/Toolbar";
import { makeTexture, newProject } from "./editor/factory";
import { setInvalidateCallback } from "./editor/render";
import { activeDoc, useEditor } from "./editor/store";
import { exportPng, openProject, saveProject } from "./lib/projectIO";
import { Viewport3D } from "./viewport/Viewport3D";

setInvalidateCallback(() => useEditor.getState().bumpRender());
// Debug/automation hook (dev builds, or append ?debug to the URL).
if (import.meta.env.DEV || location.search.includes("debug")) (window as unknown as { __livery: typeof useEditor }).__livery = useEditor;

const SIZES = [1024, 2048, 4096, 8192];

function TextureTabs() {
  const textures = useEditor((s) => s.project.textures);
  const activeId = useEditor((s) => s.project.activeTextureId);
  const st = useEditor.getState;
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("cab_b");
  const [size, setSize] = useState(4096);
  const active = textures.find((t) => t.id === activeId);
  return (
    <div className="tex-tabs">
      {textures.map((t) => (
        <button key={t.id} className={"tab" + (t.id === activeId ? " on" : "")} onClick={() => st().setActiveTexture(t.id)} title={t.cabinUnits.join(", ") || "alle cabines"}>
          {t.name} <span className="muted">{t.width}</span>
        </button>
      ))}
      {adding ? (
        <span className="row gap">
          <input value={name} onChange={(e) => setName(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, "_"))} style={{ width: 90 }} />
          <select value={size} onChange={(e) => setSize(Number(e.target.value))}>
            {SIZES.map((s) => (
              <option key={s} value={s}>
                {s}²
              </option>
            ))}
          </select>
          <button
            className="primary"
            onClick={() => {
              st().addTexture(makeTexture(name || "tex", size, size));
              setAdding(false);
            }}
          >
            OK
          </button>
          <button onClick={() => setAdding(false)}>×</button>
        </span>
      ) : (
        <button className="tab add" onClick={() => setAdding(true)} title="Extra textuur (bv. per cabine)">
          +
        </button>
      )}
      {active && textures.length > 1 && (
        <button className="tab x" title="Textuur verwijderen" onClick={() => confirm(`Textuur '${active.name}' verwijderen?`) && st().removeTexture(active.id)}>
          🗑
        </button>
      )}
    </div>
  );
}

function TopBar({ onExport }: { onExport: () => void }) {
  const project = useEditor((s) => s.project);
  const dirty = useEditor((s) => s.dirty);
  const canUndo = useEditor((s) => s.past.length > 0);
  const canRedo = useEditor((s) => s.future.length > 0);
  const layout = useEditor((s) => s.layout);
  const st = useEditor.getState;
  return (
    <header className="topbar">
      <span className="brand">🚚 ETS2 Livery Studio</span>
      <input className="proj-name" value={project.name} onChange={(e) => st().updateProject({ name: e.target.value })} />
      {dirty && <span className="muted">●</span>}
      <div className="menu">
        <button
          onClick={() => {
            if (dirty && !confirm("Niet-opgeslagen wijzigingen gaan verloren. Doorgaan?")) return;
            const sizeStr = prompt("Textuurgrootte (1024, 2048, 4096 of 8192):", "4096");
            const size = SIZES.includes(Number(sizeStr)) ? Number(sizeStr) : 4096;
            st().setProject(newProject("Nieuw project", size));
          }}
        >
          Nieuw
        </button>
        <button onClick={() => void openProject()}>Openen</button>
        <button onClick={() => void saveProject()}>Opslaan</button>
        <button onClick={() => void saveProject(true)}>Opslaan als</button>
        <span className="sep" />
        <button disabled={!canUndo} onClick={() => st().undo()} title="Ongedaan maken (Ctrl+Z)">
          ↶
        </button>
        <button disabled={!canRedo} onClick={() => st().redo()} title="Opnieuw (Ctrl+Y)">
          ↷
        </button>
        <span className="sep" />
        <button className={layout === "split" ? "on" : ""} onClick={() => st().set({ layout: layout === "split" ? "3d" : "split" })} title="2D-hulpweergave (UV-textuur) tonen/verbergen">
          ▦ 2D-hulp
        </button>
      </div>
      <TextureTabs />
      <div className="menu right">
        <button onClick={() => void exportPng()}>PNG</button>
        <button className="primary" onClick={onExport}>
          Exporteer mod ▸
        </button>
      </div>
    </header>
  );
}

function Toast() {
  const toast = useEditor((s) => s.toast);
  if (!toast) return null;
  return (
    <div className={"toast " + toast.kind} onClick={() => useEditor.setState({ toast: null })}>
      {toast.text}
    </div>
  );
}

function View2DOptions() {
  const showUv = useEditor((s) => s.showUv);
  const showGrid = useEditor((s) => s.showGrid);
  const snap = useEditor((s) => s.snap);
  const showTemplate = useEditor((s) => s.showTemplate);
  const hasTemplate = useEditor((s) => !!activeDoc(s.project).template);
  const set = useEditor((s) => s.set);
  const view = useEditor((s) => s.view);
  return (
    <div className="view2d-options">
      <b>2D-hulpweergave</b>
      <label className="check">
        <input type="checkbox" checked={showUv} onChange={(e) => set({ showUv: e.target.checked })} /> UV-lijnen
      </label>
      {hasTemplate && (
        <label className="check">
          <input type="checkbox" checked={showTemplate} onChange={(e) => set({ showTemplate: e.target.checked })} /> Template
        </label>
      )}
      <label className="check">
        <input type="checkbox" checked={showGrid} onChange={(e) => set({ showGrid: e.target.checked })} /> Raster
      </label>
      <label className="check">
        <input type="checkbox" checked={snap} onChange={(e) => set({ snap: e.target.checked })} /> Uitlijnen
      </label>
      <button onClick={() => set({ view: { ...view, fitRequest: view.fitRequest + 1 } })}>Passend</button>
    </div>
  );
}

export default function App() {
  const layout = useEditor((s) => s.layout);
  const [tab, setTab] = useState<"design" | "game">("design");
  const [exporting, setExporting] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable) return;
      const s = useEditor.getState();
      const mod = e.ctrlKey || e.metaKey;
      const k = e.key.toLowerCase();
      if (mod && k === "z") {
        e.preventDefault();
        if (e.shiftKey) s.redo();
        else s.undo();
      } else if (mod && k === "y") {
        e.preventDefault();
        s.redo();
      } else if (mod && k === "s") {
        e.preventDefault();
        void saveProject(e.shiftKey);
      } else if (mod && k === "o") {
        e.preventDefault();
        void openProject();
      } else if (mod && k === "d") {
        e.preventDefault();
        s.duplicateLayers(s.selection);
      } else if (mod && k === "a") {
        e.preventDefault();
        s.select(activeDoc(s.project).layers.filter((l) => !l.locked).map((l) => l.id));
      } else if (e.key === "Delete") {
        s.removeLayers(s.selection);
      } else if (e.key.startsWith("Arrow") && s.selection.length) {
        e.preventDefault();
        const step = e.shiftKey ? 10 : 1;
        const dx = e.key === "ArrowLeft" ? -step : e.key === "ArrowRight" ? step : 0;
        const dy = e.key === "ArrowUp" ? -step : e.key === "ArrowDown" ? step : 0;
        s.mapLayers(s.selection, (l) => (l.type === "fill" || l.type === "raster" || l.type === "surfaceLine" ? l : { ...l, x: l.x + dx, y: l.y + dy }));
      } else if (!mod && k === "x") {
        s.swapColors();
      } else if (!mod && e.key === "[") {
        s.set({ brush: { ...s.brush, size: Math.max(1, Math.round(s.brush.size / 1.2)) } });
      } else if (!mod && e.key === "]") {
        s.set({ brush: { ...s.brush, size: Math.round(s.brush.size * 1.2) + 1 } });
      } else if (!mod && !e.altKey && TOOL_KEYS[k]) {
        s.set({ tool: TOOL_KEYS[k] });
      }
    };
    window.addEventListener("keydown", onKey);
    const beforeUnload = (e: BeforeUnloadEvent) => {
      if (useEditor.getState().dirty) e.preventDefault();
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("beforeunload", beforeUnload);
    };
  }, []);

  return (
    <div className="app">
      <TopBar onExport={() => setExporting(true)} />
      <div className="main">
        <Toolbar />
        <div className="center">
          <ToolOptions />
          <div className={"views layout-" + layout}>
            <div className="view3d-wrap">
              <Viewport3D />
            </div>
            {layout === "split" && (
              <div className="view2d-wrap">
                <View2DOptions />
                <Canvas2D />
              </div>
            )}
          </div>
        </div>
        <aside className="sidebar">
          <div className="side-tabs">
            <button className={tab === "design" ? "on" : ""} onClick={() => setTab("design")}>
              Ontwerp
            </button>
            <button className={tab === "game" ? "on" : ""} onClick={() => setTab("game")}>
              Spel & model
            </button>
          </div>
          <div className="side-scroll">
            {tab === "design" ? (
              <>
                <ColorPanel />
                <PropertiesPanel />
                <LayersPanel />
              </>
            ) : (
              <GamePanel />
            )}
          </div>
        </aside>
      </div>
      {exporting && <ExportDialog onClose={() => setExporting(false)} />}
      <Toast />
    </div>
  );
}
