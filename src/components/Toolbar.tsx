import { STRIPE_PRESETS } from "../editor/factory";
import { importImageFile, pickFile } from "../editor/importers";
import { resolveColor } from "../editor/render";
import { useEditor, type Tool } from "../editor/store";
import { viewport } from "../viewport/Viewport3D";
import { NumberField, SliderField } from "./fields";

const TOOLS: { id: Tool; icon: string; label: string; key: string }[] = [
  { id: "select", icon: "➤", label: "Selecteren / verplaatsen / schalen / draaien", key: "V" },
  { id: "nodes", icon: "◇", label: "Knooppunten bewerken", key: "A" },
  { id: "hand", icon: "✋", label: "Camera / navigeren", key: "H" },
  { id: "brush", icon: "🖌", label: "Penseel", key: "B" },
  { id: "eraser", icon: "⌫", label: "Gum", key: "E" },
  { id: "rect", icon: "▭", label: "Rechthoek", key: "R" },
  { id: "ellipse", icon: "◯", label: "Ellips", key: "O" },
  { id: "polygon", icon: "⬡", label: "Veelhoek", key: "G" },
  { id: "star", icon: "☆", label: "Ster", key: "S" },
  { id: "path", icon: "✎", label: "Pad / vrije vorm", key: "P" },
  { id: "stripes", icon: "≋", label: "Lijnontwerp (meerkleurige strepen)", key: "L" },
  { id: "text", icon: "T", label: "Tekst", key: "T" },
  { id: "eyedropper", icon: "💧", label: "Pipet", key: "I" },
];

export const TOOL_KEYS: Record<string, Tool> = Object.fromEntries(TOOLS.map((t) => [t.key.toLowerCase(), t.id]));

export async function importImageSmart() {
  const f = await pickFile("image/png,image/jpeg,image/webp,image/svg+xml,.svg");
  if (!f) return;
  const placed = await viewport()?.placeImage(f);
  if (!placed) await importImageFile(f); // no model under the view centre → place in texture space
}

export function Toolbar() {
  const tool = useEditor((s) => s.tool);
  const set = useEditor((s) => s.set);
  return (
    <div className="toolbar">
      {TOOLS.map((t) => (
        <button key={t.id} className={"tool" + (tool === t.id ? " on" : "")} title={`${t.label} (${t.key})`} onClick={() => set({ tool: t.id })}>
          {t.icon}
        </button>
      ))}
      <div className="sep" />
      <button className="tool" title="PNG / SVG afbeelding importeren (op het model)" onClick={() => void importImageSmart()}>
        🖼
      </button>
    </div>
  );
}

/** Options for the active tool, shown above the main view. */
export function ToolOptions() {
  const tool = useEditor((s) => s.tool);
  const brush = useEditor((s) => s.brush);
  const shape = useEditor((s) => s.shapeOpts);
  const stripePreset = useEditor((s) => s.stripePreset);
  const palette = useEditor((s) => s.project.palette);
  const set = useEditor((s) => s.set);

  if (tool === "brush" || tool === "eraser")
    return (
      <div className="tool-options">
        <NumberField label="Grootte" value={brush.size} min={1} max={2000} onChange={(v) => set({ brush: { ...brush, size: v } })} suffix="mm (3D) / px (2D)" />
        <SliderField label="Hardheid" min={0} max={1} value={brush.hardness} onChange={(v) => set({ brush: { ...brush, hardness: v } })} />
        <SliderField label="Dekking" min={0.02} max={1} value={brush.opacity} onChange={(v) => set({ brush: { ...brush, opacity: v } })} />
      </div>
    );
  if (["rect", "ellipse", "polygon", "star", "path"].includes(tool))
    return (
      <div className="tool-options">
        {tool === "rect" && <NumberField label="Hoekradius" value={shape.radius} min={0} onChange={(v) => set({ shapeOpts: { ...shape, radius: v } })} />}
        {tool === "polygon" && <NumberField label="Zijden" value={shape.sides} min={3} max={64} onChange={(v) => set({ shapeOpts: { ...shape, sides: v } })} />}
        {tool === "star" && (
          <>
            <NumberField label="Punten" value={shape.points} min={3} max={64} onChange={(v) => set({ shapeOpts: { ...shape, points: v } })} />
            <SliderField label="Binnenstraal" min={0.05} max={0.95} value={shape.inner} onChange={(v) => set({ shapeOpts: { ...shape, inner: v } })} />
          </>
        )}
        <label className="field check">
          <input type="checkbox" checked={shape.withStroke} onChange={(e) => set({ shapeOpts: { ...shape, withStroke: e.target.checked } })} />
          <span>Rand (secundaire kleur)</span>
        </label>
        <NumberField label="Lijndikte" value={shape.strokeWidth} min={0.5} onChange={(v) => set({ shapeOpts: { ...shape, strokeWidth: v } })} />
      </div>
    );
  if (tool === "stripes")
    return (
      <div className="tool-options">
        <span className="muted">Voorinstelling:</span>
        {STRIPE_PRESETS.map((p, i) => (
          <button key={p.name} className={"preset" + (i === stripePreset ? " on" : "")} onClick={() => set({ stripePreset: i })} title={p.name}>
            <span className="stripe-preview">
              {p.stripes.map((st, j) => (
                <i key={j} style={{ background: resolveColor(st.color, palette), height: Math.max(2, st.width / 8), marginTop: j ? p.gap / 8 : 0 }} />
              ))}
            </span>
            {p.name}
          </button>
        ))}
      </div>
    );
  return null;
}
