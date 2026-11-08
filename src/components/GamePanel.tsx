import { useMemo, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { api, isTauri, type VehicleInfo } from "../lib/api";
import { makeTexture } from "../editor/factory";
import { importTemplate, pickFile } from "../editor/importers";
import { useEditor } from "../editor/store";
import { rebuildMesh, setFlipV } from "../viewport/state";

export async function loadModel(pmdPath: string) {
  const s = useEditor.getState();
  s.setGame({ loading: `Model laden: ${pmdPath}`, error: null });
  try {
    const model = await api.loadModel(pmdPath, 0);
    const st = useEditor.getState();
    st.setGame({ model, loading: null });
    st.set({ paintableOverride: null, uv: { ...st.uv, channel: 0 } });
    if (st.project.vehicle) st.updateProject({ vehicle: { ...st.project.vehicle, modelPath: pmdPath } });
    rebuildMesh();
    const paintable = model.materials.filter((m) => m.paintable).length;
    st.notify(paintable ? `Model geladen — ${paintable} lakbare materia(a)l(en)` : "Model geladen — geen 'truckpaint'-materiaal gevonden; kies hieronder welke materialen lakbaar zijn", paintable ? "info" : "error");
  } catch (e) {
    useEditor.getState().setGame({ loading: null, error: String(e) });
  }
}

export function GamePanel() {
  const game = useEditor((s) => s.game);
  const vehicle = useEditor((s) => s.project.vehicle);
  const uv = useEditor((s) => s.uv);
  const override = useEditor((s) => s.paintableOverride);
  const textures = useEditor((s) => s.project.textures);
  const st = useEditor.getState;
  const [manualDir, setManualDir] = useState("");
  const [query, setQuery] = useState("");
  const tauri = isTauri();

  const vehicles = useMemo(() => {
    const q = query.toLowerCase();
    return (game.index?.vehicles ?? []).filter((v) => !q || v.id.toLowerCase().includes(q) || v.name.toLowerCase().includes(q));
  }, [game.index, query]);
  const selected: VehicleInfo | undefined = game.index?.vehicles.find((v) => v.id === vehicle?.id && v.vehicleType === vehicle?.vehicleType);

  const detect = async () => {
    st().setGame({ loading: "Installaties zoeken…", error: null });
    try {
      const installations = await api.detectInstallations();
      st().setGame({ installations, loading: null });
      if (!installations.length) st().notify("Geen installatie gevonden — kies de spelmap handmatig", "error");
      const modDir = installations.find((i) => i.modDir)?.modDir;
      if (modDir && !st().project.mod.outputDir) st().updateProject({ mod: { ...st().project.mod, outputDir: modDir } });
    } catch (e) {
      st().setGame({ loading: null, error: String(e) });
    }
  };

  const openGame = async (dir: string) => {
    st().setGame({ loading: "Spelbestanden indexeren… (kan even duren)", error: null });
    try {
      const index = await api.openGame(dir);
      st().setGame({ index, loading: null });
      st().notify(`${index.vehicles.length} voertuigen gevonden in ${index.archives.length} archieven`);
    } catch (e) {
      st().setGame({ loading: null, error: String(e) });
    }
  };

  const browseDir = async () => {
    const dir = await open({ directory: true, title: "Kies de map van Euro Truck Simulator 2" });
    if (typeof dir === "string") {
      setManualDir(dir);
      await openGame(dir);
    }
  };

  const mountExtra = async () => {
    const p = await open({ title: "Kies een truck-mod (.scs/.zip)", filters: [{ name: "Mod", extensions: ["scs", "zip"] }] });
    if (typeof p !== "string") return;
    st().setGame({ loading: "Mod koppelen…" });
    try {
      st().setGame({ index: await api.mountExtra(p), loading: null });
    } catch (e) {
      st().setGame({ loading: null, error: String(e) });
    }
  };

  const chooseVehicle = (v: VehicleInfo) => {
    st().updateProject({ vehicle: { id: v.id, vehicleType: v.vehicleType, name: v.name, modelPath: null } }, true);
    const firstModel = v.cabins.find((c) => c.models.length)?.models[0] ?? v.otherModels[0];
    if (firstModel) void loadModel(firstModel);
  };

  return (
    <div className="panel game-panel">
      <div className="panel-title">Euro Truck Simulator 2</div>
      {!tauri && <p className="warn small">Spelbestanden lezen en mods installeren werkt alleen in de desktop-app (Tauri). In de browser kun je met de demo-cabine ontwerpen.</p>}
      {game.loading && <p className="loading small">⏳ {game.loading}</p>}
      {game.error && <p className="error small">⚠ {game.error}</p>}

      {tauri && !game.index && (
        <>
          <div className="row gap wrap">
            <button className="primary" onClick={() => void detect()}>
              Zoek installatie
            </button>
            <button onClick={() => void browseDir()}>Spelmap kiezen…</button>
          </div>
          {game.installations.map((i) => (
            <div key={i.gameDir} className="install">
              <div className="small">{i.gameDir}</div>
              <div className="muted small">Mods: {i.modDir ?? "?"}</div>
              <button onClick={() => void openGame(i.gameDir)}>Openen</button>
            </div>
          ))}
          {manualDir && <div className="muted small">{manualDir}</div>}
        </>
      )}

      {game.index && (
        <>
          <div className="muted small">
            {game.index.gameDir} · {game.index.archives.length} archieven
            {game.index.warnings.length > 0 && <span title={game.index.warnings.join("\n")}> · {game.index.warnings.length} waarschuwingen</span>}
          </div>
          <div className="row gap">
            <input placeholder="Zoek truck/trailer…" value={query} onChange={(e) => setQuery(e.target.value)} />
            <button onClick={() => void mountExtra()} title="Truck-mod koppelen (bv. een modded truck)">
              + Mod
            </button>
          </div>
          <div className="vehicle-list">
            {vehicles.map((v) => (
              <button key={v.vehicleType + v.id} className={"vehicle" + (selected === v ? " on" : "")} onClick={() => chooseVehicle(v)}>
                <b>{v.name}</b> <span className="muted">{v.id}</span>
                <span className="muted small">
                  {" "}
                  · {v.vehicleType === "truck" ? `${v.cabins.length} cabines` : "trailer"} · {v.paintJobs.length} paintjobs
                </span>
              </button>
            ))}
          </div>
        </>
      )}

      {selected && (
        <div className="section">
          <div className="panel-subtitle">{selected.name} – cabines / modellen</div>
          {selected.cabins.map((c) => (
            <div key={c.unitName} className="cabin">
              <div>
                <b>{c.name || c.unitName}</b> <span className="muted small">{c.unitName}</span>
              </div>
              <div className="row gap wrap">
                {c.models.slice(0, 3).map((m) => (
                  <button key={m} className={game.model?.path === m ? "on" : ""} onClick={() => void loadModel(m)} title={m}>
                    {m.split("/").pop()}
                  </button>
                ))}
                <button
                  title="Maak een aparte textuur die alleen voor deze cabine geëxporteerd wordt (suitable_for)"
                  onClick={() => {
                    const name = c.unitName.split(".")[0].replace(/[^a-z0-9_]/g, "_").slice(0, 12) || "cab";
                    const doc = makeTexture(name, 4096, 4096);
                    doc.cabinUnits = [c.unitName];
                    st().addTexture(doc);
                    if (c.models[0]) void loadModel(c.models[0]);
                  }}
                >
                  + Textuur voor cabine
                </button>
              </div>
            </div>
          ))}
          {selected.otherModels.length > 0 && (
            <details>
              <summary>Overige modellen ({selected.otherModels.length})</summary>
              {selected.otherModels.map((m) => (
                <button key={m} className="link-btn block" onClick={() => void loadModel(m)}>
                  {m}
                </button>
              ))}
            </details>
          )}
          {selected.paintJobs.length > 0 && (
            <details>
              <summary>Bestaande paintjobs ({selected.paintJobs.length})</summary>
              {selected.paintJobs.map((p) => (
                <div key={p.unitName} className="small">
                  {p.name || p.unitName} <span className="muted">{p.airbrush ? "airbrush" : ""} {p.alternateUvset ? "altuv" : ""}</span>
                </div>
              ))}
            </details>
          )}
        </div>
      )}

      <div className="section">
        <div className="panel-subtitle">Model & UV</div>
        <div className="muted small">{game.model ? game.model.path : "Demo-cabine (geen spelmodel geladen)"}</div>
        <div className="row gap wrap">
          <label className="field">
            <span>UV-kanaal</span>
            <select
              value={uv.channel}
              onChange={(e) => {
                st().set({ uv: { ...uv, channel: Number(e.target.value) } });
                rebuildMesh();
              }}
            >
              {Array.from({ length: Math.max(1, uv.channelsAvailable) }, (_, i) => (
                <option key={i} value={i}>
                  UV {i}
                </option>
              ))}
            </select>
          </label>
          <label className="field check">
            <input type="checkbox" checked={uv.flipV} onChange={(e) => setFlipV(e.target.checked)} />
            <span>V omkeren</span>
          </label>
          {game.model && (
            <button
              onClick={() => {
                st().setGame({ model: null });
                rebuildMesh();
              }}
            >
              Demo-cabine
            </button>
          )}
        </div>
        <p className="muted small">Tip: kies het UV-kanaal waarbij de cyaan UV-lijnen in de 2D-hulpweergave één nette uitslag van de cabine tonen.</p>
        {game.model && (
          <details>
            <summary>Lakbare materialen</summary>
            {game.model.materials.map((m, i) => {
              const on = override ? override.includes(i) : m.paintable;
              return (
                <label key={i} className="field check small">
                  <input
                    type="checkbox"
                    checked={on}
                    onChange={() => {
                      const base = override ?? game.model!.materials.map((x, j) => (x.paintable ? j : -1)).filter((j) => j >= 0);
                      st().set({ paintableOverride: on ? base.filter((j) => j !== i) : [...base, i] });
                      rebuildMesh();
                    }}
                  />
                  <span title={m.path}>
                    {m.path.split("/").pop()} <em className="muted">{m.effect}</em>
                  </span>
                </label>
              );
            })}
          </details>
        )}
        <div className="row gap wrap">
          <button
            onClick={async () => {
              const f = await pickFile("image/*");
              if (f) await importTemplate(f);
            }}
            title="Laad een officiële SCS-paintjob-template (PNG) als hulplaag in de 2D-weergave"
          >
            UV-template laden…
          </button>
          <span className="muted small">{textures.length} textuur/texturen in project</span>
        </div>
      </div>
    </div>
  );
}
