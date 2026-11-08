import { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { hexToLinear } from "../color/color";
import { canvasToPngBlob } from "../editor/render";
import { useEditor } from "../editor/store";
import { isPow2 } from "../editor/geometry";
import { api, blobToBase64, isTauri, type ExportRequest, type ExportResult } from "../lib/api";
import { renderFull } from "../lib/projectIO";
import { viewport } from "../viewport/Viewport3D";
import { ColorField } from "./fields";

const idOk = (s: string) => /^[a-z0-9_]{1,12}$/.test(s);

export function ExportDialog({ onClose }: { onClose: () => void }) {
  const project = useEditor((s) => s.project);
  const game = useEditor((s) => s.game);
  const st = useEditor.getState;
  const mod = project.mod;
  const [vehicleId, setVehicleId] = useState(project.vehicle?.id ?? "");
  const [vehicleType, setVehicleType] = useState(project.vehicle?.vehicleType ?? "truck");
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<ExportResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const tauri = isTauri();
  const setMod = (patch: Partial<typeof mod>) => st().updateProject({ mod: { ...mod, ...patch } });
  const vehicle = game.index?.vehicles.find((v) => v.id === vehicleId && v.vehicleType === vehicleType);

  useEffect(() => {
    if (tauri && !mod.outputDir)
      api
        .defaultModDir()
        .then((d) => d && setMod({ outputDir: d }))
        .catch(() => undefined);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const problems: string[] = [];
  if (!idOk(mod.modId)) problems.push("Mod-ID: alleen a-z, 0-9 en _ (max. 12 tekens)");
  if (tauri && !vehicleId) problems.push("Kies een voertuig (tabblad Spel) of vul het voertuig-ID in");
  for (const t of project.textures) {
    if (!/^[a-z0-9_]+$/.test(t.name)) problems.push(`Textuurnaam '${t.name}': alleen a-z, 0-9 en _`);
    if (!isPow2(t.width) || !isPow2(t.height)) problems.push(`Textuur '${t.name}' moet een macht van 2 zijn (bv. 4096×4096)`);
  }
  if (tauri && !mod.outputDir) problems.push("Kies een doelmap (de mod-map van ETS2)");

  const run = async () => {
    setBusy("Texturen op volle resolutie renderen…");
    setError(null);
    setResult(null);
    try {
      const textures = [];
      for (const t of project.textures) {
        setBusy(`Textuur '${t.name}' bakken (${t.width}×${t.height})…`);
        const blob = await canvasToPngBlob(await renderFull(t));
        textures.push({ name: t.name, pngBase64: await blobToBase64(blob), cabinUnits: t.cabinUnits });
      }
      if (!tauri) {
        // Browser: hand out the textures as PNG downloads.
        for (const t of textures) {
          const a = document.createElement("a");
          a.href = `data:image/png;base64,${t.pngBase64}`;
          a.download = `${t.name}.png`;
          a.click();
        }
        setBusy(null);
        setResult({ outputPath: "(download)", files: textures.map((t) => `${t.name}.png`), warnings: ["In de browser worden alleen PNG's gedownload. Gebruik de desktop-app voor een complete mod."] });
        return;
      }
      setBusy("Iconen maken…");
      const vp = viewport();
      const icon = vp ? await blobToBase64(await canvasToPngBlob(vp.capture(512, 128))) : null;
      const manager = vp ? await blobToBase64(await canvasToPngBlob(vp.capture(552, 324))) : null;
      const req: ExportRequest = {
        modId: mod.modId,
        displayName: mod.displayName,
        author: mod.author,
        version: mod.version,
        description: mod.description,
        price: mod.price,
        unlockLevel: mod.unlockLevel,
        vehicleType,
        vehicleId,
        textures,
        alternateUvset: mod.alternateUvset,
        baseColor: hexToLinear(mod.baseColor),
        baseColorLocked: mod.baseColorLocked,
        format: mod.format,
        mipmaps: mod.mipmaps,
        iconPngBase64: icon,
        modManagerPngBase64: manager,
        packaging: mod.packaging,
        outputDir: mod.outputDir,
        overwrite: true,
      };
      setBusy("Mod bouwen (DDS, TOBJ, SII)…");
      const res = await api.exportMod(req);
      setResult(res);
      st().notify(`Mod geïnstalleerd: ${res.outputPath}`);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <div className="modal">
        <div className="modal-title">
          Exporteren naar ETS2-mod <button className="x" onClick={onClose} disabled={!!busy}>×</button>
        </div>
        <div className="modal-body grid-form">
          <label>Naam in spel</label>
          <input value={mod.displayName} onChange={(e) => setMod({ displayName: e.target.value })} />
          <label>Mod-ID</label>
          <input value={mod.modId} onChange={(e) => setMod({ modId: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, "_").slice(0, 12) })} />
          <label>Auteur</label>
          <input value={mod.author} onChange={(e) => setMod({ author: e.target.value })} />
          <label>Versie</label>
          <input value={mod.version} onChange={(e) => setMod({ version: e.target.value })} />
          <label>Beschrijving</label>
          <textarea rows={2} value={mod.description} onChange={(e) => setMod({ description: e.target.value })} />
          <label>Prijs / level</label>
          <div className="row gap">
            <input type="number" value={mod.price} onChange={(e) => setMod({ price: Number(e.target.value) || 0 })} />
            <input type="number" value={mod.unlockLevel} onChange={(e) => setMod({ unlockLevel: Number(e.target.value) || 0 })} />
          </div>
          <label>Voertuig</label>
          <div className="row gap">
            <select value={vehicleType} onChange={(e) => setVehicleType(e.target.value)}>
              <option value="truck">truck</option>
              <option value="trailer_owned">trailer_owned</option>
            </select>
            <input placeholder="bv. scania.r_2016" value={vehicleId} onChange={(e) => setVehicleId(e.target.value)} list="vehicle-ids" />
            <datalist id="vehicle-ids">
              {game.index?.vehicles.map((v) => <option key={v.vehicleType + v.id} value={v.id}>{v.name}</option>)}
            </datalist>
          </div>
          <label>Basiskleur</label>
          <div className="row gap">
            <ColorField value={mod.baseColor} onChange={(c) => setMod({ baseColor: c.startsWith("pal:") ? project.palette.find((p) => `pal:${p.id}` === c)?.hex ?? "#ffffff" : c })} />
            <label className="field check">
              <input type="checkbox" checked={!mod.baseColorLocked} onChange={(e) => setMod({ baseColorLocked: !e.target.checked })} />
              <span>Speler mag kleur aanpassen</span>
            </label>
          </div>
          <label>Formaat</label>
          <div className="row gap wrap">
            <select value={mod.format} onChange={(e) => setMod({ format: e.target.value as "rgba8" | "bc3" })}>
              <option value="rgba8">Lossless (RGBA8, groot)</option>
              <option value="bc3">Compact (DXT5/BC3)</option>
            </select>
            <label className="field check">
              <input type="checkbox" checked={mod.mipmaps} onChange={(e) => setMod({ mipmaps: e.target.checked })} />
              <span>Mipmaps</span>
            </label>
            <label className="field check">
              <input type="checkbox" checked={mod.alternateUvset} onChange={(e) => setMod({ alternateUvset: e.target.checked })} />
              <span>alternate_uvset</span>
            </label>
          </div>
          <label>Verpakking</label>
          <select value={mod.packaging} onChange={(e) => setMod({ packaging: e.target.value as "folder" | "scs" })}>
            <option value="scs">.scs-bestand (aanbevolen)</option>
            <option value="folder">Uitgepakte map (om te testen)</option>
          </select>
          <label>Doelmap</label>
          <div className="row gap">
            <input value={mod.outputDir} onChange={(e) => setMod({ outputDir: e.target.value })} placeholder="…\Documents\Euro Truck Simulator 2\mod" />
            {tauri && (
              <button
                onClick={async () => {
                  const d = await open({ directory: true, title: "Kies de mod-map" });
                  if (typeof d === "string") setMod({ outputDir: d });
                }}
              >
                …
              </button>
            )}
          </div>
          <label>Texturen</label>
          <div className="tex-list">
            {project.textures.map((t) => (
              <div key={t.id} className="tex-item">
                <b>{t.name}</b> {t.width}×{t.height}
                <div className="muted small">{t.cabinUnits.length ? `Alleen voor: ${t.cabinUnits.join(", ")}` : "Voor alle cabines"}</div>
                {vehicle && vehicle.cabins.length > 0 && (
                  <div className="cabin-checks">
                    {vehicle.cabins.map((c) => (
                      <label key={c.unitName} className="field check small">
                        <input
                          type="checkbox"
                          checked={t.cabinUnits.includes(c.unitName)}
                          onChange={(e) =>
                            st().updateTexture(t.id, {
                              cabinUnits: e.target.checked ? [...t.cabinUnits, c.unitName] : t.cabinUnits.filter((u) => u !== c.unitName),
                            })
                          }
                        />
                        <span>{c.name || c.unitName}</span>
                      </label>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
        {problems.length > 0 && (
          <ul className="problems">
            {problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        )}
        {busy && <p className="loading">⏳ {busy}</p>}
        {error && <p className="error">⚠ {error}</p>}
        {result && (
          <div className="result">
            <b>✔ Klaar:</b> {result.outputPath}
            <div className="muted small">{result.files.length} bestanden</div>
            {result.warnings.map((w) => (
              <div key={w} className="warn small">
                {w}
              </div>
            ))}
            {tauri && <p className="small">Activeer de mod in ETS2 via Mod Manager en koop de paintjob bij een dealer/werkplaats.</p>}
          </div>
        )}
        <div className="modal-actions">
          <button onClick={onClose} disabled={!!busy}>
            Sluiten
          </button>
          <button className="primary" disabled={!!busy || problems.length > 0} onClick={() => void run()}>
            {tauri ? "Exporteer & installeer mod" : "Download PNG's"}
          </button>
        </div>
      </div>
    </div>
  );
}
