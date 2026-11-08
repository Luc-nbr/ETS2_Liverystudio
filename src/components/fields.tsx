// Small reusable inputs for the properties panel.

import { useEffect, useRef, useState } from "react";
import { contrastText } from "../color/color";
import { resolveColor } from "../editor/render";
import { useEditor } from "../editor/store";
import type { ColorRef, Paint } from "../editor/types";
import { ColorPicker } from "./ColorPicker";

export function NumberField(props: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  step?: number;
  min?: number;
  max?: number;
  suffix?: string;
}) {
  const { label, value, onChange, step = 1, min, max, suffix } = props;
  const [text, setText] = useState(String(round(value)));
  useEffect(() => setText(String(round(value))), [value]);
  const commit = (t: string) => {
    let v = Number(t.replace(",", "."));
    if (!Number.isFinite(v)) return setText(String(round(value)));
    if (min !== undefined) v = Math.max(min, v);
    if (max !== undefined) v = Math.min(max, v);
    onChange(v);
  };
  return (
    <label className="field num-field">
      <span>{label}</span>
      <input
        type="number"
        step={step}
        min={min}
        max={max}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          if (e.target.value !== "" && Number.isFinite(Number(e.target.value))) commit(e.target.value);
        }}
        onBlur={(e) => commit(e.target.value)}
      />
      {suffix && <em>{suffix}</em>}
    </label>
  );
}

const round = (v: number) => Math.round(v * 100) / 100;

export function SliderField(props: { label: string; value: number; onChange: (v: number, final: boolean) => void; min: number; max: number; step?: number; format?: (v: number) => string }) {
  const { label, value, onChange, min, max, step = 0.01, format } = props;
  return (
    <label className="field slider-field">
      <span>{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value), false)}
        onPointerUp={(e) => onChange(Number((e.target as HTMLInputElement).value), true)}
      />
      <em>{format ? format(value) : round(value)}</em>
    </label>
  );
}

/** Colour swatch that opens a picker popover; can link to a palette colour. */
export function ColorField({ value, onChange, label }: { value: ColorRef; onChange: (c: ColorRef, final: boolean) => void; label?: string }) {
  const palette = useEditor((s) => s.project.palette);
  const primary = useEditor((s) => s.primary);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const hex = resolveColor(value, palette);
  const linked = value.startsWith("pal:") ? palette.find((p) => `pal:${p.id}` === value) : null;

  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, [open]);

  return (
    <div className="color-field" ref={ref}>
      {label && <span className="cf-label">{label}</span>}
      <button className="cf-swatch" style={{ background: hex, color: contrastText(hex) }} onClick={() => setOpen(!open)} title={hex}>
        {linked ? `🔗 ${linked.name}` : hex}
      </button>
      {open && (
        <div className="popover">
          <ColorPicker hex={hex} onChange={(h, final) => onChange(h, final)} />
          <div className="swatch-row">
            {palette.map((p) => (
              <button
                key={p.id}
                className={"swatch small" + (value === `pal:${p.id}` ? " active" : "")}
                style={{ background: p.hex }}
                title={`${p.name} (gekoppeld)`}
                onClick={() => onChange(`pal:${p.id}`, true)}
              />
            ))}
          </div>
          <div className="row gap">
            <button onClick={() => onChange(primary, true)}>Primaire kleur</button>
            {linked && <button onClick={() => onChange(linked.hex, true)}>Ontkoppel</button>}
          </div>
        </div>
      )}
    </div>
  );
}

export function PaintEditor({ paint, onChange, allowNone = true }: { paint: Paint; onChange: (p: Paint, final: boolean) => void; allowNone?: boolean }) {
  const primary = useEditor((s) => s.primary);
  const secondary = useEditor((s) => s.secondary);
  const firstColor = paint.type === "solid" ? paint.color : paint.type === "none" ? primary : paint.stops[0]?.color ?? primary;
  const setType = (t: Paint["type"]) => {
    switch (t) {
      case "none":
        return onChange({ type: "none" }, true);
      case "solid":
        return onChange({ type: "solid", color: firstColor }, true);
      case "linear":
        return onChange({ type: "linear", angle: 0, stops: paint.type === "radial" ? paint.stops : [{ offset: 0, color: firstColor }, { offset: 1, color: secondary }] }, true);
      case "radial":
        return onChange({ type: "radial", cx: 0.5, cy: 0.5, radius: 1, stops: paint.type === "linear" ? paint.stops : [{ offset: 0, color: firstColor }, { offset: 1, color: secondary }] }, true);
    }
  };
  return (
    <div className="paint-editor">
      <div className="seg">
        {(allowNone ? (["none", "solid", "linear", "radial"] as const) : (["solid", "linear", "radial"] as const)).map((t) => (
          <button key={t} className={paint.type === t ? "on" : ""} onClick={() => setType(t)}>
            {{ none: "Geen", solid: "Effen", linear: "Lineair", radial: "Radiaal" }[t]}
          </button>
        ))}
      </div>
      {paint.type === "solid" && <ColorField value={paint.color} onChange={(c, f) => onChange({ ...paint, color: c }, f)} />}
      {(paint.type === "linear" || paint.type === "radial") && (
        <>
          {paint.type === "linear" ? (
            <SliderField label="Hoek" min={-180} max={180} step={1} value={paint.angle} onChange={(v, f) => onChange({ ...paint, angle: v }, f)} format={(v) => `${v}°`} />
          ) : (
            <>
              <SliderField label="Midden X" min={0} max={1} value={paint.cx} onChange={(v, f) => onChange({ ...paint, cx: v }, f)} />
              <SliderField label="Midden Y" min={0} max={1} value={paint.cy} onChange={(v, f) => onChange({ ...paint, cy: v }, f)} />
              <SliderField label="Straal" min={0.05} max={3} value={paint.radius} onChange={(v, f) => onChange({ ...paint, radius: v }, f)} />
            </>
          )}
          <div className="gradient-preview" style={{ background: `linear-gradient(90deg, ${paint.stops.map((s) => `${resolveColorStatic(s.color)} ${s.offset * 100}%`).join(",")})` }} />
          {paint.stops.map((s, i) => (
            <div className="row gap stop" key={i}>
              <ColorField value={s.color} onChange={(c, f) => onChange({ ...paint, stops: paint.stops.map((x, j) => (j === i ? { ...x, color: c } : x)) }, f)} />
              <input
                type="range"
                min={0}
                max={1}
                step={0.01}
                value={s.offset}
                onChange={(e) => onChange({ ...paint, stops: paint.stops.map((x, j) => (j === i ? { ...x, offset: Number(e.target.value) } : x)) }, false)}
                onPointerUp={() => onChange(paint, true)}
              />
              <button className="x" disabled={paint.stops.length <= 2} onClick={() => onChange({ ...paint, stops: paint.stops.filter((_, j) => j !== i) }, true)}>
                ×
              </button>
            </div>
          ))}
          <button onClick={() => onChange({ ...paint, stops: [...paint.stops, { offset: 1, color: primary }].sort((a, b) => a.offset - b.offset) }, true)}>+ Kleurstop</button>
        </>
      )}
    </div>
  );
}

function resolveColorStatic(c: ColorRef) {
  return resolveColor(c, useEditor.getState().project.palette);
}
