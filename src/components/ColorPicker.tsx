import { useEffect, useRef, useState } from "react";
import { hslToRgb, hsvToRgb, parseColor, rgbToHsl, rgbToHsv, rgbaToHex, type HSV } from "../color/color";

interface Props {
  /** "#rrggbb[aa]" */
  hex: string;
  onChange: (hex: string, final: boolean) => void;
  showAlpha?: boolean;
}

type EyeDropperCtor = new () => { open: () => Promise<{ sRGBHex: string }> };

function useDrag(onMove: (fx: number, fy: number, final: boolean) => void) {
  const ref = useRef<HTMLDivElement>(null);
  const handle = (e: React.PointerEvent, final = false) => {
    const r = ref.current!.getBoundingClientRect();
    const fx = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    const fy = Math.min(1, Math.max(0, (e.clientY - r.top) / r.height));
    onMove(fx, fy, final);
  };
  return {
    ref,
    onPointerDown: (e: React.PointerEvent) => {
      ref.current!.setPointerCapture(e.pointerId);
      handle(e);
    },
    onPointerMove: (e: React.PointerEvent) => {
      if (e.buttons & 1) handle(e);
    },
    onPointerUp: (e: React.PointerEvent) => handle(e, true),
  };
}

export function ColorPicker({ hex, onChange, showAlpha = true }: Props) {
  const rgba = parseColor(hex) ?? { r: 255, g: 255, b: 255, a: 1 };
  // Keep hue/saturation stable when value hits black/grey.
  const [hsv, setHsv] = useState<HSV>(() => rgbToHsv(rgba));
  const lastEmitted = useRef(hex);
  useEffect(() => {
    if (hex !== lastEmitted.current) {
      const c = parseColor(hex);
      if (c) {
        const n = rgbToHsv(c);
        setHsv((old) => ({ h: n.s === 0 || n.v === 0 ? old.h : n.h, s: n.v === 0 ? old.s : n.s, v: n.v }));
      }
      lastEmitted.current = hex;
    }
  }, [hex]);

  const emit = (next: HSV, a: number, final: boolean) => {
    setHsv(next);
    const out = rgbaToHex(hsvToRgb(next, a));
    lastEmitted.current = out;
    onChange(out, final);
  };
  const emitHex = (h: string, final = true) => {
    const c = parseColor(h);
    if (!c) return false;
    const out = rgbaToHex(c);
    setHsv(rgbToHsv(c));
    lastEmitted.current = out;
    onChange(out, final);
    return true;
  };

  const sv = useDrag((fx, fy, final) => emit({ ...hsv, s: fx, v: 1 - fy }, rgba.a, final));
  const hue = useDrag((fx, _fy, final) => emit({ ...hsv, h: Math.min(359.9, fx * 360) }, rgba.a, final));
  const alpha = useDrag((fx, _fy, final) => emit(hsv, Math.round(fx * 100) / 100, final));

  const [hexText, setHexText] = useState(hex);
  useEffect(() => setHexText(hex), [hex]);
  const [invalid, setInvalid] = useState(false);

  const hsl = rgbToHsl(rgba);
  const pure = rgbaToHex(hsvToRgb({ h: hsv.h, s: 1, v: 1 }));
  const opaque = rgbaToHex({ ...rgba, a: 1 });

  const eyeDropper = (window as unknown as { EyeDropper?: EyeDropperCtor }).EyeDropper;

  const num = (label: string, value: number, max: number, set: (v: number) => void) => (
    <label className="num">
      <span>{label}</span>
      <input
        type="number"
        min={0}
        max={max}
        value={Math.round(value)}
        onChange={(e) => {
          const v = Math.min(max, Math.max(0, Number(e.target.value) || 0));
          set(v);
        }}
      />
    </label>
  );

  return (
    <div className="color-picker">
      <div className="sv" {...sv} style={{ background: pure }}>
        <div className="sv-white" />
        <div className="sv-black" />
        <div className="sv-thumb" style={{ left: `${hsv.s * 100}%`, top: `${(1 - hsv.v) * 100}%`, background: opaque }} />
      </div>
      <div className="slider hue" {...hue}>
        <div className="slider-thumb" style={{ left: `${(hsv.h / 360) * 100}%` }} />
      </div>
      {showAlpha && (
        <div className="slider alpha" {...alpha}>
          <div className="alpha-fill" style={{ background: `linear-gradient(90deg, transparent, ${opaque})` }} />
          <div className="slider-thumb" style={{ left: `${rgba.a * 100}%` }} />
        </div>
      )}
      <div className="row hex-row">
        <div className="swatch big" style={{ background: hex }} />
        <input
          className={"hex-input" + (invalid ? " invalid" : "")}
          value={hexText}
          spellCheck={false}
          placeholder="#rrggbb"
          onChange={(e) => {
            setHexText(e.target.value);
            setInvalid(!parseColor(e.target.value));
          }}
          onBlur={() => {
            if (!emitHex(hexText)) setHexText(hex);
            setInvalid(false);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          }}
          onPaste={(e) => {
            const t = e.clipboardData.getData("text");
            if (parseColor(t)) {
              e.preventDefault();
              setHexText(t);
              emitHex(t);
            }
          }}
          title="Plak of typ een kleur: #1e88e5, 1e88e5, #18e, rgb(30,136,229) of 30,136,229"
        />
        <button
          className="icon-btn"
          title="Kopieer hex"
          onClick={() => {
            void navigator.clipboard?.writeText(hex);
          }}
        >
          ⧉
        </button>
        {eyeDropper && (
          <button
            className="icon-btn"
            title="Pipet: kies een kleur van overal op het scherm"
            onClick={async () => {
              try {
                const res = await new eyeDropper().open();
                emitHex(res.sRGBHex);
              } catch {
                /* cancelled */
              }
            }}
          >
            ✎
          </button>
        )}
      </div>
      <div className="row nums">
        {num("R", rgba.r, 255, (v) => emitHex(rgbaToHex({ ...rgba, r: v })))}
        {num("G", rgba.g, 255, (v) => emitHex(rgbaToHex({ ...rgba, g: v })))}
        {num("B", rgba.b, 255, (v) => emitHex(rgbaToHex({ ...rgba, b: v })))}
        {showAlpha && num("A%", rgba.a * 100, 100, (v) => emitHex(rgbaToHex({ ...rgba, a: v / 100 })))}
      </div>
      <div className="row nums">
        {num("H", hsl.h, 360, (v) => emitHex(rgbaToHex(hslToRgb(v, hsl.s, hsl.l, rgba.a))))}
        {num("S%", hsl.s * 100, 100, (v) => emitHex(rgbaToHex(hslToRgb(hsl.h, v / 100, hsl.l, rgba.a))))}
        {num("L%", hsl.l * 100, 100, (v) => emitHex(rgbaToHex(hslToRgb(hsl.h, hsl.s, v / 100, rgba.a))))}
      </div>
    </div>
  );
}
