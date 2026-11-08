import { useState } from "react";
import { contrastText, harmony, normalizeHex } from "../color/color";
import { resolveColor } from "../editor/render";
import { useEditor } from "../editor/store";
import type { ColorRef } from "../editor/types";
import { ColorPicker } from "./ColorPicker";

/** Primary/secondary colour, picker, linked palette, recent colours and global recolour. */
export function ColorPanel() {
  const primary = useEditor((s) => s.primary);
  const secondary = useEditor((s) => s.secondary);
  const palette = useEditor((s) => s.project.palette);
  const recent = useEditor((s) => s.recent);
  const selection = useEditor((s) => s.selection);
  const st = useEditor.getState;
  const [editing, setEditing] = useState<"primary" | "secondary">("primary");
  const [renaming, setRenaming] = useState<string | null>(null);
  const [replaceFrom, setReplaceFrom] = useState("");
  const [replaceTo, setReplaceTo] = useState("");

  const current = editing === "primary" ? primary : secondary;
  const currentHex = resolveColor(current, palette);
  const linkedId = current.startsWith("pal:") ? current.slice(4) : null;
  const linked = linkedId ? palette.find((p) => p.id === linkedId) : null;

  const setCurrent = (c: ColorRef) => (editing === "primary" ? st().setPrimary(c) : st().setSecondary(c));

  const onPick = (hex: string, final: boolean) => {
    if (linked) {
      // Editing a linked palette colour recolours every layer that uses it.
      if (final) st().checkpoint();
      st().updatePaletteColor(linked.id, { hex });
    } else if (editing === "primary") {
      if (final) st().setPrimary(hex);
      else st().set({ primary: hex });
    } else st().setSecondary(hex);
  };

  return (
    <div className="panel color-panel">
      <div className="panel-title">Kleur</div>
      <div className="row">
        <div className="dual-swatch">
          <button
            className={"swatch primary" + (editing === "primary" ? " active" : "")}
            style={{ background: resolveColor(primary, palette) }}
            onClick={() => setEditing("primary")}
            title="Primaire kleur (vulling)"
          />
          <button
            className={"swatch secondary" + (editing === "secondary" ? " active" : "")}
            style={{ background: resolveColor(secondary, palette) }}
            onClick={() => setEditing("secondary")}
            title="Secundaire kleur (rand)"
          />
          <button className="swap" onClick={() => st().swapColors()} title="Wissel (X)">
            ⇄
          </button>
        </div>
        <div className="col grow">
          {linked ? (
            <div className="linked">
              🔗 Gekoppeld aan <b>{linked.name}</b> — wijzigen past alle lagen aan
              <button className="link-btn" onClick={() => setCurrent(linked.hex)}>
                ontkoppel
              </button>
            </div>
          ) : (
            <div className="linked muted">Losse kleur</div>
          )}
          <div className="row gap">
            <button disabled={!selection.length} onClick={() => st().applyColorToSelection(current, "fill")} title="Zet als vulling van de selectie">
              Vulling ▸
            </button>
            <button disabled={!selection.length} onClick={() => st().applyColorToSelection(current, "stroke")} title="Zet als rand van de selectie">
              Rand ▸
            </button>
          </div>
        </div>
      </div>

      <ColorPicker hex={currentHex} onChange={onPick} />

      {recent.length > 0 && (
        <div className="swatch-row" title="Recent gebruikt">
          {recent.map((c) => (
            <button key={c} className="swatch small" style={{ background: resolveColor(c, palette) }} onClick={() => setCurrent(c)} title={resolveColor(c, palette)} />
          ))}
        </div>
      )}

      <div className="panel-subtitle">
        Palet
        <span className="muted"> — klik = kiezen (gekoppeld), dubbelklik = hernoemen</span>
      </div>
      <div className="palette">
        {palette.map((p) => (
          <div key={p.id} className={"pal-item" + (current === `pal:${p.id}` ? " active" : "")}>
            <button
              className="swatch pal"
              style={{ background: p.hex, color: contrastText(p.hex) }}
              onClick={() => setCurrent(`pal:${p.id}`)}
              onDoubleClick={() => setRenaming(p.id)}
              title={`${p.name} ${p.hex}`}
            >
              {p.hex.slice(1, 7)}
            </button>
            {renaming === p.id ? (
              <input
                autoFocus
                defaultValue={p.name}
                onBlur={(e) => {
                  st().updatePaletteColor(p.id, { name: e.target.value || p.name });
                  setRenaming(null);
                }}
                onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
              />
            ) : (
              <span className="pal-name">{p.name}</span>
            )}
            <button className="x" title="Verwijder (lagen houden de kleur)" onClick={() => st().removePaletteColor(p.id)}>
              ×
            </button>
          </div>
        ))}
      </div>
      <div className="row gap wrap">
        <button
          onClick={() => {
            const id = st().addPaletteColor(currentHex);
            setCurrent(`pal:${id}`);
          }}
        >
          + Huidige kleur
        </button>
        <select
          value=""
          onChange={(e) => {
            const kind = e.target.value as Parameters<typeof harmony>[1];
            if (!kind) return;
            harmony(currentHex, kind).forEach((h, i) => st().addPaletteColor(h, `${kind} ${i + 1}`));
          }}
        >
          <option value="">Genereer harmonie…</option>
          <option value="complementary">Complementair</option>
          <option value="triadic">Triade</option>
          <option value="analogous">Analoog</option>
          <option value="shades">Tinten</option>
        </select>
      </div>

      <details className="recolor">
        <summary>Kleur vervangen in ontwerp</summary>
        <div className="row gap">
          <input placeholder="van #hex" value={replaceFrom} onChange={(e) => setReplaceFrom(e.target.value)} />
          <span>→</span>
          <input placeholder="naar #hex" value={replaceTo} onChange={(e) => setReplaceTo(e.target.value)} />
        </div>
        <div className="row gap">
          <button onClick={() => setReplaceTo(currentHex)}>Huidige als doel</button>
          <button
            onClick={() => {
              const from = normalizeHex(replaceFrom), to = normalizeHex(replaceTo);
              if (!from || !to) return st().notify("Ongeldige hex-kleur", "error");
              const n = st().replaceColor(from, to, true);
              st().notify(n ? `${n} kleurverwijzing(en) vervangen` : "Kleur niet gevonden (alleen losse kleuren worden vervangen)");
            }}
          >
            Vervang overal
          </button>
        </div>
      </details>
    </div>
  );
}
