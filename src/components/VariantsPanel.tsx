import { useState } from "react";
import { useEditor, variantPalette } from "../editor/store";

/** Colour variants: the same design in different palettes, exported as separate paint jobs. */
export function VariantsPanel() {
  const project = useEditor((s) => s.project);
  const st = useEditor.getState;
  const [renaming, setRenaming] = useState<string | null>(null);
  const variants = project.variants ?? [];
  return (
    <details className="variants" open={variants.length > 0}>
      <summary>Kleurvarianten {variants.length > 0 && <span className="muted">({variants.length})</span>}</summary>
      <p className="muted small">Zelfde ontwerp, andere paletkleuren. Elke variant wordt een eigen paintjob in dezelfde mod. Alleen gekoppelde (🔗) paletkleuren wisselen mee.</p>
      {variants.map((v) => (
        <div key={v.id} className={"variant-row" + (v.id === project.activeVariantId ? " on" : "")}>
          <button className="variant-swatches" onClick={() => st().switchVariant(v.id)} title="Activeren">
            {variantPalette(project, v.id)
              .slice(0, 6)
              .map((c) => (
                <i key={c.id} style={{ background: c.hex }} />
              ))}
          </button>
          {renaming === v.id ? (
            <input
              autoFocus
              defaultValue={v.name}
              onBlur={(e) => {
                st().renameVariant(v.id, e.target.value || v.name);
                setRenaming(null);
              }}
              onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
            />
          ) : (
            <span className="grow" onDoubleClick={() => setRenaming(v.id)} onClick={() => st().switchVariant(v.id)}>
              {v.name}
            </span>
          )}
          <button className="x" title="Verwijderen" onClick={() => st().removeVariant(v.id)} disabled={variants.length <= 1}>
            ×
          </button>
        </div>
      ))}
      <button onClick={() => st().addVariant(`Variant ${Math.max(1, variants.length)}`)}>+ Variant (kopie van huidige kleuren)</button>
    </details>
  );
}
