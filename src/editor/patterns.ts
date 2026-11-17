// Seamless two-colour pattern tiles (checker, carbon fibre, hex, camo, …) used as fills.
// Tiles are rendered at the device resolution of the target, so they stay sharp in exports.

import type { PatternKind } from "./types";

export const PATTERNS: { id: PatternKind; name: string }[] = [
  { id: "checker", name: "Dambord" },
  { id: "stripes", name: "Strepen" },
  { id: "dots", name: "Stippen" },
  { id: "halftone", name: "Halftone" },
  { id: "grid", name: "Raster" },
  { id: "carbon", name: "Carbon" },
  { id: "hex", name: "Honingraat" },
  { id: "chevron", name: "Chevron" },
  { id: "diamond", name: "Ruit" },
  { id: "camo", name: "Camouflage" },
];

/** Tile aspect (height / width). */
const ASPECT: Partial<Record<PatternKind, number>> = { hex: Math.sqrt(3) };

const cache = new Map<string, HTMLCanvasElement>();

function mulberry(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function draw(ctx: CanvasRenderingContext2D, kind: PatternKind, w: number, h: number, c1: string, c2: string) {
  ctx.fillStyle = c2;
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = c1;
  ctx.strokeStyle = c1;
  switch (kind) {
    case "checker":
      ctx.fillRect(0, 0, w / 2, h / 2);
      ctx.fillRect(w / 2, h / 2, w / 2, h / 2);
      break;
    case "stripes":
      ctx.fillRect(0, 0, w / 2, h);
      break;
    case "dots":
      ctx.beginPath();
      ctx.arc(w / 2, h / 2, w * 0.28, 0, Math.PI * 2);
      ctx.fill();
      break;
    case "halftone":
      for (const [x, y, r] of [
        [w / 4, h / 4, 0.2],
        [(3 * w) / 4, (3 * h) / 4, 0.2],
        [(3 * w) / 4, h / 4, 0.1],
        [w / 4, (3 * h) / 4, 0.1],
      ]) {
        ctx.beginPath();
        ctx.arc(x, y, w * r, 0, Math.PI * 2);
        ctx.fill();
      }
      break;
    case "grid": {
      const t = Math.max(1, w * 0.08);
      ctx.fillRect(0, 0, w, t);
      ctx.fillRect(0, 0, t, h);
      break;
    }
    case "carbon": {
      // 2×2 twill weave with shaded fibres
      const cells: [number, number, boolean][] = [
        [0, 0, true],
        [1, 0, false],
        [0, 1, false],
        [1, 1, true],
      ];
      for (const [cx, cy, horiz] of cells) {
        const x = (cx * w) / 2, y = (cy * h) / 2, cw = w / 2, ch = h / 2;
        const g = horiz ? ctx.createLinearGradient(x, y, x, y + ch) : ctx.createLinearGradient(x, y, x + cw, y);
        g.addColorStop(0, c2);
        g.addColorStop(0.5, c1);
        g.addColorStop(1, c2);
        ctx.fillStyle = g;
        ctx.fillRect(x + 0.5, y + 0.5, cw - 1, ch - 1);
      }
      break;
    }
    case "hex": {
      // flat hex outlines on a w × w√3 tile
      const r = w / 3;
      ctx.lineWidth = Math.max(1, w * 0.06);
      const hexAt = (cx: number, cy: number) => {
        ctx.beginPath();
        for (let i = 0; i < 6; i++) {
          const a = (Math.PI / 3) * i;
          const px = cx + r * Math.cos(a), py = cy + r * Math.sin(a);
          if (i === 0) ctx.moveTo(px, py);
          else ctx.lineTo(px, py);
        }
        ctx.closePath();
        ctx.stroke();
      };
      const dy = (r * Math.sqrt(3)) / 2;
      for (const [cx, cy] of [
        [0, 0],
        [w, 0],
        [0, h],
        [w, h],
        [w / 2, h / 2],
        [w / 2, h / 2 - 2 * dy],
        [w / 2, h / 2 + 2 * dy],
      ])
        hexAt(cx, cy);
      break;
    }
    case "chevron": {
      const t = h * 0.25;
      ctx.beginPath();
      ctx.moveTo(0, h * 0.25);
      ctx.lineTo(w / 2, h * 0.25 + t * 1.5);
      ctx.lineTo(w, h * 0.25);
      ctx.lineTo(w, h * 0.25 + t * 1.6);
      ctx.lineTo(w / 2, h * 0.25 + t * 3.1);
      ctx.lineTo(0, h * 0.25 + t * 1.6);
      ctx.closePath();
      ctx.fill();
      break;
    }
    case "diamond":
      ctx.beginPath();
      ctx.moveTo(w / 2, 0);
      ctx.lineTo(w, h / 2);
      ctx.lineTo(w / 2, h);
      ctx.lineTo(0, h / 2);
      ctx.closePath();
      ctx.fill();
      break;
    case "camo": {
      const rnd = mulberry(1337);
      const blob = (x: number, y: number, r: number) => {
        // draw with wrap-around so the tile is seamless
        for (const ox of [-w, 0, w])
          for (const oy of [-h, 0, h]) {
            ctx.beginPath();
            const n = 9;
            for (let i = 0; i <= n; i++) {
              const a = (i / n) * Math.PI * 2;
              const rr = r * (0.7 + 0.3 * Math.sin(a * 3 + x));
              const px = x + ox + Math.cos(a) * rr, py = y + oy + Math.sin(a) * rr * 0.8;
              if (i === 0) ctx.moveTo(px, py);
              else ctx.lineTo(px, py);
            }
            ctx.fill();
          }
      };
      for (let i = 0; i < 9; i++) blob(rnd() * w, rnd() * h, w * (0.12 + rnd() * 0.12));
      ctx.globalAlpha = 0.55;
      ctx.fillStyle = "#000";
      for (let i = 0; i < 6; i++) blob(rnd() * w, rnd() * h, w * (0.06 + rnd() * 0.08));
      ctx.globalAlpha = 1;
      break;
    }
  }
}

/** Returns a pattern for `ctx`, sized so one tile = `scale` local units, rotated by `angle`. */
export function makePattern(ctx: CanvasRenderingContext2D, kind: PatternKind, c1: string, c2: string, scale: number, angle: number, deviceScale: number): CanvasPattern | null {
  const aspect = ASPECT[kind] ?? 1;
  const px = Math.max(8, Math.min(1024, Math.round(scale * deviceScale)));
  const key = `${kind}|${c1}|${c2}|${px}`;
  let tile = cache.get(key);
  if (!tile) {
    tile = document.createElement("canvas");
    tile.width = px;
    tile.height = Math.max(8, Math.round(px * aspect));
    draw(tile.getContext("2d")!, kind, tile.width, tile.height, c1, c2);
    if (cache.size > 64) cache.clear();
    cache.set(key, tile);
  }
  const pat = ctx.createPattern(tile, "repeat");
  if (!pat) return null;
  pat.setTransform(new DOMMatrix().rotate(angle).scale(scale / px));
  return pat;
}
