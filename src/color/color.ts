// Color utilities: hex <-> rgba <-> hsv/hsl, parsing of user input.

export interface RGBA {
  r: number; // 0..255
  g: number;
  b: number;
  a: number; // 0..1
}

export interface HSV {
  h: number; // 0..360
  s: number; // 0..1
  v: number; // 0..1
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Normalises any accepted input to "#rrggbb" or "#rrggbbaa" (lowercase). Returns null when invalid. */
export function normalizeHex(input: string): string | null {
  const c = parseColor(input);
  return c ? rgbaToHex(c) : null;
}

/**
 * Parses "#rgb", "#rgba", "#rrggbb", "#rrggbbaa" (with or without #, also "0x..."),
 * "rgb(r,g,b)", "rgba(r,g,b,a)" and "r, g, b" (as copied from many tools).
 */
export function parseColor(input: string): RGBA | null {
  let s = input.trim().toLowerCase();
  if (!s) return null;
  const fn = s.match(/^rgba?\(([^)]*)\)$/);
  if (fn) s = fn[1];
  if (s.includes(",")) {
    const parts = s.split(",").map((p) => parseFloat(p.trim()));
    if (parts.length >= 3 && parts.slice(0, 3).every((n) => Number.isFinite(n))) {
      return {
        r: clamp(Math.round(parts[0]), 0, 255),
        g: clamp(Math.round(parts[1]), 0, 255),
        b: clamp(Math.round(parts[2]), 0, 255),
        a: parts.length > 3 && Number.isFinite(parts[3]) ? clamp(parts[3], 0, 1) : 1,
      };
    }
    return null;
  }
  s = s.replace(/^#/, "").replace(/^0x/, "");
  if (!/^[0-9a-f]+$/.test(s)) return null;
  if (s.length === 3 || s.length === 4) s = s.split("").map((ch) => ch + ch).join("");
  if (s.length !== 6 && s.length !== 8) return null;
  const n = (i: number) => parseInt(s.slice(i, i + 2), 16);
  return { r: n(0), g: n(2), b: n(4), a: s.length === 8 ? n(6) / 255 : 1 };
}

export function rgbaToHex({ r, g, b, a }: RGBA, forceAlpha = false): string {
  const h = (n: number) => clamp(Math.round(n), 0, 255).toString(16).padStart(2, "0");
  const base = `#${h(r)}${h(g)}${h(b)}`;
  return a < 1 || forceAlpha ? base + h(a * 255) : base;
}

export function rgbToHsv({ r, g, b }: RGBA): HSV {
  const rn = r / 255, gn = g / 255, bn = b / 255;
  const max = Math.max(rn, gn, bn), min = Math.min(rn, gn, bn);
  const d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === rn) h = ((gn - bn) / d) % 6;
    else if (max === gn) h = (bn - rn) / d + 2;
    else h = (rn - gn) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return { h, s: max === 0 ? 0 : d / max, v: max };
}

export function hsvToRgb({ h, s, v }: HSV, a = 1): RGBA {
  const c = v * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - c;
  let r = 0, g = 0, b = 0;
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  return { r: (r + m) * 255, g: (g + m) * 255, b: (b + m) * 255, a };
}

export function rgbToHsl({ r, g, b }: RGBA): { h: number; s: number; l: number } {
  const { h } = rgbToHsv({ r, g, b, a: 1 });
  const rn = r / 255, gn = g / 255, bn = b / 255;
  const max = Math.max(rn, gn, bn), min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  const d = max - min;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  return { h, s, l };
}

export function hslToRgb(h: number, s: number, l: number, a = 1): RGBA {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const v = l + c / 2;
  const sv = v === 0 ? 0 : c / v;
  return hsvToRgb({ h, s: sv, v }, a);
}

export function toCss(c: RGBA): string {
  return `rgba(${Math.round(c.r)},${Math.round(c.g)},${Math.round(c.b)},${c.a})`;
}

/** Hex → css with optional extra opacity multiplier. */
export function hexToCss(hex: string, opacity = 1): string {
  const c = parseColor(hex) ?? { r: 255, g: 0, b: 255, a: 1 };
  return toCss({ ...c, a: c.a * opacity });
}

/** sRGB hex → linear 0..1 triple (what SII base_color expects). */
export function hexToLinear(hex: string): [number, number, number] {
  const c = parseColor(hex) ?? { r: 255, g: 255, b: 255, a: 1 };
  const lin = (u: number) => {
    const x = u / 255;
    return x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
  };
  return [lin(c.r), lin(c.g), lin(c.b)];
}

/** Black or white, whichever reads better on the given color. */
export function contrastText(hex: string): string {
  const c = parseColor(hex);
  if (!c) return "#000";
  const y = 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
  return y > 150 ? "#111" : "#fff";
}

/** Generates harmonious colors from a base (for the palette generator). */
export function harmony(hex: string, kind: "complementary" | "triadic" | "analogous" | "shades"): string[] {
  const c = parseColor(hex);
  if (!c) return [];
  const hsv = rgbToHsv(c);
  const rot = (deg: number) => rgbaToHex(hsvToRgb({ ...hsv, h: (hsv.h + deg + 360) % 360 }));
  switch (kind) {
    case "complementary":
      return [rgbaToHex(c), rot(180)];
    case "triadic":
      return [rgbaToHex(c), rot(120), rot(240)];
    case "analogous":
      return [rot(-30), rgbaToHex(c), rot(30)];
    case "shades":
      return [0.25, 0.5, 0.75, 1].map((f) => rgbaToHex(hsvToRgb({ ...hsv, v: hsv.v * f })));
  }
}
