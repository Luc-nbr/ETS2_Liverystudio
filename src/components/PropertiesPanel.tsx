import { useRef } from "react";
import { isProjected } from "../editor/render";
import { activeDoc, useEditor } from "../editor/store";
import type { BlendMode, Layer, Projection, ShapeLayer, StripeDef, Stroke, TextLayer } from "../editor/types";
import { getRasterCanvas, markRasterSynced } from "../editor/render";
import { viewport } from "../viewport/Viewport3D";
import { defaultUp } from "../viewport/frame";
import { ColorField, NumberField, PaintEditor, SliderField } from "./fields";

const BLENDS: [BlendMode, string][] = [
  ["source-over", "Normaal"],
  ["multiply", "Vermenigvuldigen"],
  ["screen", "Bleken"],
  ["overlay", "Bedekken"],
  ["darken", "Donkerder"],
  ["lighten", "Lichter"],
  ["color-dodge", "Kleur tegenhouden"],
  ["color-burn", "Kleur doordrukken"],
  ["hard-light", "Fel licht"],
  ["soft-light", "Zacht licht"],
  ["difference", "Verschil"],
  ["exclusion", "Uitsluiting"],
  ["hue", "Kleurtoon"],
  ["saturation", "Verzadiging"],
  ["color", "Kleur"],
  ["luminosity", "Helderheid"],
];

const FONTS = [
  "Arial Black, Arial, sans-serif",
  "Arial, sans-serif",
  "Impact, sans-serif",
  "Verdana, sans-serif",
  "Tahoma, sans-serif",
  "Trebuchet MS, sans-serif",
  "Segoe UI, sans-serif",
  "Georgia, serif",
  "Times New Roman, serif",
  "Courier New, monospace",
  "Bahnschrift, sans-serif",
];

/** Updates with a single undo step per slider drag / edit session. */
function useEdit(id: string) {
  const session = useRef(false);
  return (patch: Partial<Layer>, final = true) => {
    const s = useEditor.getState();
    if (!final) {
      if (!session.current) {
        s.checkpoint();
        session.current = true;
      }
      s.updateLayer(id, patch, false);
    } else {
      s.updateLayer(id, patch, !session.current);
      session.current = false;
    }
  };
}

export function PropertiesPanel() {
  const doc = useEditor((s) => activeDoc(s.project));
  const selection = useEditor((s) => s.selection);
  const selected = doc.layers.filter((l) => selection.includes(l.id));
  if (!selected.length)
    return (
      <div className="panel props-panel">
        <div className="panel-title">Eigenschappen</div>
        <p className="muted small">Selecteer een laag op het model of in de lagenlijst. Nieuwe ontwerpen maak je met de gereedschappen links, direct op het 3D-model.</p>
      </div>
    );
  if (selected.length > 1) return <MultiProps ids={selection} />;
  return <LayerProps key={selected[0].id} layer={selected[0]} />;
}

function MultiProps({ ids }: { ids: string[] }) {
  const st = useEditor.getState;
  return (
    <div className="panel props-panel">
      <div className="panel-title">{ids.length} lagen geselecteerd</div>
      <div className="row gap wrap">
        <button onClick={() => st().mapLayers(ids, (l) => ({ ...l, visible: !l.visible }))}>Zichtbaarheid</button>
        <button onClick={() => st().duplicateLayers(ids)}>Dupliceren</button>
        <button className="danger" onClick={() => st().removeLayers(ids)}>
          Verwijderen
        </button>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="section">
      <div className="panel-subtitle">{title}</div>
      {children}
    </div>
  );
}

function LayerProps({ layer }: { layer: Layer }) {
  const edit = useEdit(layer.id);
  const doc = useEditor((s) => activeDoc(s.project));
  const projected = isProjected(layer);
  const unit = projected ? "mm" : "px";
  const mm = (v: number) => (layer.projection ? v * layer.projection.unitsPerPx * 1000 : v);

  return (
    <div className="panel props-panel">
      <div className="panel-title">
        <input className="name-input" value={layer.name} onChange={(e) => edit({ name: e.target.value }, false)} onBlur={(e) => edit({ name: e.target.value })} />
      </div>
      <SliderField label="Dekking" min={0} max={1} value={layer.opacity} onChange={(v, f) => edit({ opacity: v }, f)} format={(v) => `${Math.round(v * 100)}%`} />
      <label className="field">
        <span>Overvloei</span>
        <select value={layer.blend} onChange={(e) => edit({ blend: e.target.value as BlendMode })}>
          {BLENDS.map(([v, n]) => (
            <option key={v} value={v}>
              {n}
            </option>
          ))}
        </select>
      </label>

      {layer.type !== "fill" && layer.type !== "raster" && layer.type !== "surfaceLine" && (
        <Section title={projected ? "Transformatie (op projectievlak)" : "Transformatie (textuur)"}>
          <div className="grid2">
            <NumberField label="X" value={mm(layer.x)} onChange={(v) => edit({ x: layer.projection ? v / (layer.projection.unitsPerPx * 1000) : v })} suffix={unit} />
            <NumberField label="Y" value={mm(layer.y)} onChange={(v) => edit({ y: layer.projection ? v / (layer.projection.unitsPerPx * 1000) : v })} suffix={unit} />
            <NumberField label="Schaal X" value={layer.scaleX * 100} step={1} onChange={(v) => edit({ scaleX: v / 100 })} suffix="%" />
            <NumberField label="Schaal Y" value={layer.scaleY * 100} step={1} onChange={(v) => edit({ scaleY: v / 100 })} suffix="%" />
          </div>
          <SliderField label="Rotatie" min={-180} max={180} step={1} value={layer.rotation} onChange={(v, f) => edit({ rotation: v }, f)} format={(v) => `${Math.round(v)}°`} />
          <div className="row gap wrap">
            <button onClick={() => edit({ scaleX: -layer.scaleX })}>⇋ Spiegel H</button>
            <button onClick={() => edit({ scaleY: -layer.scaleY })}>⇵ Spiegel V</button>
            <button onClick={() => edit({ rotation: 0, scaleX: Math.sign(layer.scaleX) || 1, scaleY: Math.sign(layer.scaleY) || 1 })}>Reset</button>
            {!projected && (
              <>
                <button onClick={() => edit({ x: doc.width / 2 })}>Centreer H</button>
                <button onClick={() => edit({ y: doc.height / 2 })}>Centreer V</button>
              </>
            )}
          </div>
        </Section>
      )}

      {layer.projection && projected && <ProjectionProps projection={layer.projection} onChange={(p, f) => edit({ projection: p }, f)} />}
      <TypeProps layer={layer} edit={edit} />
      {layer.type !== "surfaceLine" && <ShadowProps layer={layer} edit={edit} />}
    </div>
  );
}

function ProjectionProps({ projection: p, onChange }: { projection: Projection; onChange: (p: Projection, final: boolean) => void }) {
  return (
    <Section title="3D-projectie (decal)">
      <SliderField label="Schaal" min={0.1} max={10} step={0.05} value={p.unitsPerPx * 1000} onChange={(v, f) => onChange({ ...p, unitsPerPx: v / 1000 }, f)} format={(v) => `${v.toFixed(2)} mm/px`} />
      <SliderField label="Diepte" min={0.02} max={2} step={0.01} value={p.depth} onChange={(v, f) => onChange({ ...p, depth: v }, f)} format={(v) => `${Math.round(v * 100)} cm`} />
      <SliderField label="Max. hoek" min={10} max={89} step={1} value={p.maxAngle} onChange={(v, f) => onChange({ ...p, maxAngle: v }, f)} format={(v) => `${v}°`} />
      <label className="field check">
        <input type="checkbox" checked={p.mirror} onChange={(e) => onChange({ ...p, mirror: e.target.checked }, true)} />
        <span>Spiegelen naar andere kant (L/R)</span>
      </label>
      {p.mirror && (
        <label className="field check">
          <input type="checkbox" checked={p.mirrorReadable} onChange={(e) => onChange({ ...p, mirrorReadable: e.target.checked }, true)} />
          <span>Leesbaar houden (tekst/logo niet gespiegeld)</span>
        </label>
      )}
      <div className="row gap wrap">
        <button
          title="Richt de projectie langs de huidige kijkrichting (handig om over afgeronde hoeken te projecteren)"
          onClick={() => {
            const n = viewport()?.viewNormal();
            if (n) onChange({ ...p, normal: n, up: defaultUp(n, p.up) }, true);
          }}
        >
          ◎ Richt op camera
        </button>
        <button onClick={() => onChange({ ...p, up: defaultUp(p.normal) }, true)}>Rechtzetten</button>
      </div>
    </Section>
  );
}

function StrokeProps({ stroke, onChange }: { stroke: Stroke | null; onChange: (s: Stroke | null, final: boolean) => void }) {
  const primary = useEditor((s) => s.secondary);
  return (
    <Section title="Rand">
      <label className="field check">
        <input
          type="checkbox"
          checked={!!stroke}
          onChange={(e) => onChange(e.target.checked ? { paint: { type: "solid", color: primary }, width: 10, dash: [], cap: "round", join: "round" } : null, true)}
        />
        <span>Rand tekenen</span>
      </label>
      {stroke && (
        <>
          <PaintEditor paint={stroke.paint} allowNone={false} onChange={(p, f) => onChange({ ...stroke, paint: p }, f)} />
          <NumberField label="Dikte" value={stroke.width} min={0} onChange={(v) => onChange({ ...stroke, width: v }, true)} />
          <label className="field">
            <span>Streep</span>
            <input
              placeholder="bv. 20 10"
              defaultValue={stroke.dash.join(" ")}
              onBlur={(e) =>
                onChange(
                  {
                    ...stroke,
                    dash: e.target.value
                      .split(/[\s,]+/)
                      .map(Number)
                      .filter((n) => n > 0),
                  },
                  true,
                )
              }
            />
          </label>
          <label className="field">
            <span>Uiteinde</span>
            <select value={stroke.cap} onChange={(e) => onChange({ ...stroke, cap: e.target.value as CanvasLineCap }, true)}>
              <option value="butt">Recht</option>
              <option value="round">Rond</option>
              <option value="square">Vierkant</option>
            </select>
          </label>
          <label className="field">
            <span>Hoeken</span>
            <select value={stroke.join} onChange={(e) => onChange({ ...stroke, join: e.target.value as CanvasLineJoin }, true)}>
              <option value="miter">Scherp</option>
              <option value="round">Rond</option>
              <option value="bevel">Afgeschuind</option>
            </select>
          </label>
        </>
      )}
    </Section>
  );
}

function StripesEditor({ stripes, gap, onChange, unit }: { stripes: StripeDef[]; gap: number; unit: string; onChange: (s: StripeDef[], gap: number, final: boolean) => void }) {
  const primary = useEditor((s) => s.primary);
  return (
    <Section title="Strepen">
      {stripes.map((s, i) => (
        <div className="row gap stop" key={i}>
          <ColorField value={s.color} onChange={(c, f) => onChange(stripes.map((x, j) => (j === i ? { ...x, color: c } : x)), gap, f)} />
          <NumberField label="" value={s.width} min={0} onChange={(v) => onChange(stripes.map((x, j) => (j === i ? { ...x, width: v } : x)), gap, true)} suffix={unit} />
          <button disabled={i === 0} onClick={() => onChange(stripes.map((x, j) => (j === i - 1 ? stripes[i] : j === i ? stripes[i - 1] : x)), gap, true)}>
            ▲
          </button>
          <button className="x" disabled={stripes.length <= 1} onClick={() => onChange(stripes.filter((_, j) => j !== i), gap, true)}>
            ×
          </button>
        </div>
      ))}
      <div className="row gap">
        <button onClick={() => onChange([...stripes, { color: primary, width: stripes[stripes.length - 1]?.width ?? 20 }], gap, true)}>+ Streep</button>
        <NumberField label="Tussenruimte" value={gap} min={0} onChange={(v) => onChange(stripes, v, true)} suffix={unit} />
      </div>
    </Section>
  );
}

function TypeProps({ layer, edit }: { layer: Layer; edit: (p: Partial<Layer>, final?: boolean) => void }) {
  switch (layer.type) {
    case "fill":
      return (
        <Section title="Vulling">
          <PaintEditor paint={layer.fill} onChange={(p, f) => edit({ fill: p } as Partial<Layer>, f)} />
        </Section>
      );
    case "shape": {
      const g = layer.geometry;
      const setG = (patch: Partial<ShapeLayer["geometry"]>) => edit({ geometry: { ...g, ...patch } } as Partial<Layer>);
      return (
        <>
          <Section title="Vorm">
            {g.kind !== "path" ? (
              <div className="grid2">
                <NumberField label="Breedte" value={g.w} min={1} onChange={(v) => setG({ w: v })} />
                <NumberField label="Hoogte" value={g.h} min={1} onChange={(v) => setG({ h: v })} />
                {g.kind === "rect" && <NumberField label="Radius" value={g.radius} min={0} onChange={(v) => setG({ radius: v })} />}
                {g.kind === "polygon" && <NumberField label="Zijden" value={g.sides} min={3} onChange={(v) => setG({ sides: v })} />}
                {g.kind === "star" && <NumberField label="Punten" value={g.points} min={3} onChange={(v) => setG({ points: v })} />}
                {g.kind === "star" && <NumberField label="Binnen" value={g.inner} step={0.05} min={0.05} max={0.95} onChange={(v) => setG({ inner: v })} />}
              </div>
            ) : (
              <div className="row gap wrap">
                <label className="field check">
                  <input type="checkbox" checked={g.closed} onChange={(e) => setG({ closed: e.target.checked })} />
                  <span>Gesloten</span>
                </label>
                <label className="field check">
                  <input type="checkbox" checked={g.smooth} onChange={(e) => setG({ smooth: e.target.checked })} />
                  <span>Vloeiend</span>
                </label>
                <span className="muted small">{g.points.length} punten — bewerk met ◇</span>
              </div>
            )}
          </Section>
          <Section title="Vulling">
            <PaintEditor paint={layer.fill} onChange={(p, f) => edit({ fill: p } as Partial<Layer>, f)} />
          </Section>
          <StrokeProps stroke={layer.stroke} onChange={(st, f) => edit({ stroke: st } as Partial<Layer>, f)} />
        </>
      );
    }
    case "text":
      return <TextProps layer={layer} edit={edit} />;
    case "image":
      return (
        <Section title={layer.isSvg ? "Afbeelding (SVG – vector, lossless)" : "Afbeelding"}>
          <div className="grid2">
            <NumberField label="Breedte" value={layer.w} min={1} onChange={(v) => edit({ w: v, h: (layer.h * v) / layer.w } as Partial<Layer>)} />
            <NumberField label="Hoogte" value={layer.h} min={1} onChange={(v) => edit({ h: v, w: (layer.w * v) / layer.h } as Partial<Layer>)} />
          </div>
          <label className="field check">
            <input type="checkbox" checked={!!layer.tint} onChange={(e) => edit({ tint: e.target.checked ? useEditor.getState().primary : null } as Partial<Layer>)} />
            <span>Inkleuren (logo in één kleur)</span>
          </label>
          {layer.tint && <ColorField value={layer.tint} onChange={(c, f) => edit({ tint: c } as Partial<Layer>, f)} />}
        </Section>
      );
    case "raster":
      return (
        <Section title="Penseellaag">
          <p className="muted small">
            {layer.w}×{layer.h}px. Schilder met 🖌 direct op het model; streken lopen door over UV-naden.
          </p>
          <button
            className="danger"
            onClick={() => {
              const c = getRasterCanvas(layer);
              c.getContext("2d")!.clearRect(0, 0, c.width, c.height);
              markRasterSynced(layer.id, "");
              edit({ src: "" } as Partial<Layer>);
            }}
          >
            Laag leegmaken
          </button>
        </Section>
      );
    case "stripes":
    case "surfaceLine": {
      const unit = layer.type === "surfaceLine" ? "mm" : "px";
      return (
        <>
          <StripesEditor stripes={layer.stripes} gap={layer.gap} unit={unit} onChange={(s, gap, f) => edit({ stripes: s, gap } as Partial<Layer>, f)} />
          <Section title="Lijn">
            <div className="row gap wrap">
              <label className="field check">
                <input type="checkbox" checked={layer.smooth} onChange={(e) => edit({ smooth: e.target.checked } as Partial<Layer>)} />
                <span>Vloeiend</span>
              </label>
              {layer.type === "surfaceLine" && (
                <label className="field check">
                  <input type="checkbox" checked={layer.mirror} onChange={(e) => edit({ mirror: e.target.checked } as Partial<Layer>)} />
                  <span>Spiegelen L/R</span>
                </label>
              )}
              {layer.type === "stripes" && (
                <label className="field check">
                  <input type="checkbox" checked={layer.closed} onChange={(e) => edit({ closed: e.target.checked } as Partial<Layer>)} />
                  <span>Gesloten</span>
                </label>
              )}
            </div>
            <label className="field">
              <span>Uiteinde</span>
              <select value={layer.cap} onChange={(e) => edit({ cap: e.target.value } as Partial<Layer>)}>
                <option value="butt">Recht</option>
                <option value="round">Rond</option>
              </select>
            </label>
            <label className="field">
              <span>Onderbroken</span>
              <input
                placeholder={`streep gat (${unit}), bv. 300 100`}
                defaultValue={layer.dash.join(" ")}
                onBlur={(e) =>
                  edit({
                    dash: e.target.value
                      .split(/[\s,]+/)
                      .map(Number)
                      .filter((n) => n > 0),
                  } as Partial<Layer>)
                }
              />
            </label>
            {layer.type === "surfaceLine" && <p className="muted small">{layer.points.length} punten op het model — bewerk met ◇ (Ctrl+klik voegt toe).</p>}
          </Section>
        </>
      );
    }
  }
}

function TextProps({ layer, edit }: { layer: TextLayer; edit: (p: Partial<Layer>, final?: boolean) => void }) {
  return (
    <>
      <Section title="Tekst">
        <textarea value={layer.text} rows={2} onChange={(e) => edit({ text: e.target.value } as Partial<Layer>, false)} onBlur={(e) => edit({ text: e.target.value } as Partial<Layer>)} />
        <label className="field">
          <span>Lettertype</span>
          <select value={layer.fontFamily} onChange={(e) => edit({ fontFamily: e.target.value } as Partial<Layer>)}>
            {FONTS.map((f) => (
              <option key={f} value={f} style={{ fontFamily: f }}>
                {f.split(",")[0]}
              </option>
            ))}
          </select>
        </label>
        <div className="grid2">
          <NumberField label="Grootte" value={layer.fontSize} min={1} onChange={(v) => edit({ fontSize: v } as Partial<Layer>)} />
          <NumberField label="Spatiëring" value={layer.letterSpacing} onChange={(v) => edit({ letterSpacing: v } as Partial<Layer>)} />
          <NumberField label="Regelafstand" value={layer.lineHeight} step={0.05} min={0.5} onChange={(v) => edit({ lineHeight: v } as Partial<Layer>)} />
        </div>
        <div className="row gap">
          <button className={layer.bold ? "on" : ""} onClick={() => edit({ bold: !layer.bold } as Partial<Layer>)}>
            <b>B</b>
          </button>
          <button className={layer.italic ? "on" : ""} onClick={() => edit({ italic: !layer.italic } as Partial<Layer>)}>
            <i>I</i>
          </button>
          {(["left", "center", "right"] as const).map((a) => (
            <button key={a} className={layer.align === a ? "on" : ""} onClick={() => edit({ align: a } as Partial<Layer>)}>
              {{ left: "⯇", center: "≡", right: "⯈" }[a]}
            </button>
          ))}
        </div>
      </Section>
      <Section title="Vulling">
        <PaintEditor paint={layer.fill} onChange={(p, f) => edit({ fill: p } as Partial<Layer>, f)} />
      </Section>
      <StrokeProps stroke={layer.stroke} onChange={(st, f) => edit({ stroke: st } as Partial<Layer>, f)} />
    </>
  );
}

function ShadowProps({ layer, edit }: { layer: Layer; edit: (p: Partial<Layer>, final?: boolean) => void }) {
  const sh = layer.shadow;
  return (
    <Section title="Schaduw / gloed">
      <label className="field check">
        <input type="checkbox" checked={!!sh} onChange={(e) => edit({ shadow: e.target.checked ? { color: "#000000aa", blur: 12, offsetX: 6, offsetY: 6 } : null })} />
        <span>Schaduw</span>
      </label>
      {sh && (
        <>
          <ColorField value={sh.color} onChange={(c, f) => edit({ shadow: { ...sh, color: c } }, f)} />
          <div className="grid2">
            <NumberField label="Vervaging" value={sh.blur} min={0} onChange={(v) => edit({ shadow: { ...sh, blur: v } })} />
            <NumberField label="X" value={sh.offsetX} onChange={(v) => edit({ shadow: { ...sh, offsetX: v } })} />
            <NumberField label="Y" value={sh.offsetY} onChange={(v) => edit({ shadow: { ...sh, offsetY: v } })} />
          </div>
        </>
      )}
    </Section>
  );
}
