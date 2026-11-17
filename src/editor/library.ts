// Built-in vector design elements. All are single-colour SVGs (recoloured through the
// image layer's tint), so they stay lossless at any size.

export interface LibraryItem {
  id: string;
  name: string;
  category: "Vormen" | "Snelheid" | "Racing" | "Decoratie";
  svg: string;
}

const wrap = (w: number, h: number, body: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" preserveAspectRatio="none"><g fill="#000">${body}</g></svg>`;

function chevrons(n: number) {
  let b = "";
  for (let i = 0; i < n; i++) {
    const x = i * 70;
    b += `<path d="M${x} 0 L${x + 50} 0 L${x + 110} 100 L${x + 50} 200 L${x} 200 L${x + 60} 100 Z"/>`;
  }
  return wrap(n * 70 + 50, 200, b);
}

function speedLines() {
  let b = "";
  const rows = 7;
  for (let i = 0; i < rows; i++) {
    const y = i * 30;
    const len = 600 - Math.abs(i - (rows - 1) / 2) * 110;
    b += `<path d="M${600 - len} ${y + 10} L600 ${y} L600 ${y + 18} Z"/>`;
  }
  return wrap(600, rows * 30, b);
}

function halftoneFade() {
  let b = "";
  const cols = 24, rows = 10, cell = 25;
  for (let c = 0; c < cols; c++)
    for (let r = 0; r < rows; r++) {
      const rad = (cell / 2) * (1 - c / cols) * 1.05;
      if (rad < 0.8) continue;
      const ox = r % 2 ? cell / 2 : 0;
      b += `<circle cx="${c * cell + cell / 2 + ox}" cy="${r * cell + cell / 2}" r="${rad.toFixed(2)}"/>`;
    }
  return wrap(cols * cell + cell, rows * cell, b);
}

function checkerFlag(cols = 12, rows = 6, cell = 40, wave = 18) {
  let b = "";
  for (let c = 0; c < cols; c++)
    for (let r = 0; r < rows; r++) {
      if ((c + r) % 2) continue;
      const y0 = r * cell + Math.sin((c / cols) * Math.PI * 2) * wave + wave;
      const y1 = r * cell + Math.sin(((c + 1) / cols) * Math.PI * 2) * wave + wave;
      b += `<path d="M${c * cell} ${y0.toFixed(1)} L${(c + 1) * cell} ${y1.toFixed(1)} L${(c + 1) * cell} ${(y1 + cell).toFixed(1)} L${c * cell} ${(y0 + cell).toFixed(1)} Z"/>`;
    }
  return wrap(cols * cell, rows * cell + wave * 2, b);
}

function starburst(points = 24) {
  let d = "";
  for (let i = 0; i < points * 2; i++) {
    const a = (i / (points * 2)) * Math.PI * 2;
    const r = i % 2 ? 60 : 100;
    d += `${i ? "L" : "M"}${(100 + Math.cos(a) * r).toFixed(1)} ${(100 + Math.sin(a) * r).toFixed(1)} `;
  }
  return wrap(200, 200, `<path d="${d}Z"/>`);
}

function star(points = 5) {
  let d = "";
  for (let i = 0; i < points * 2; i++) {
    const a = -Math.PI / 2 + (i / (points * 2)) * Math.PI * 2;
    const r = i % 2 ? 40 : 100;
    d += `${i ? "L" : "M"}${(100 + Math.cos(a) * r).toFixed(1)} ${(105 + Math.sin(a) * r).toFixed(1)} `;
  }
  return wrap(200, 200, `<path d="${d}Z"/>`);
}

function waveStripes(n = 3) {
  let b = "";
  for (let i = 0; i < n; i++) {
    const y = i * 45;
    b += `<path d="M0 ${y + 40} C150 ${y - 20} 300 ${y + 100} 450 ${y + 40} S750 ${y - 20} 900 ${y + 40} L900 ${y + 62} C750 ${y + 2} 600 ${y + 122} 450 ${y + 62} S150 ${y + 2} 0 ${y + 62} Z"/>`;
  }
  return wrap(900, n * 45 + 80, b);
}

export const LIBRARY: LibraryItem[] = [
  {
    id: "flame",
    name: "Vlammen",
    category: "Racing",
    svg: wrap(
      800,
      300,
      `<path d="M0 150 C120 130 180 60 260 40 C230 90 250 110 300 100 C360 80 380 20 470 0 C430 60 450 90 520 80 C600 70 640 40 720 30 C680 80 700 110 800 110 C700 140 690 160 760 200 C660 210 600 180 540 210 C580 240 600 260 660 300 C560 300 480 250 420 230 C400 260 420 280 450 300 C350 290 300 230 240 210 C200 230 200 250 220 280 C140 250 110 190 0 150 Z"/>`,
    ),
  },
  { id: "chevron3", name: "Chevrons", category: "Snelheid", svg: chevrons(3) },
  { id: "chevron5", name: "Chevrons ×5", category: "Snelheid", svg: chevrons(5) },
  { id: "speed", name: "Snelheidslijnen", category: "Snelheid", svg: speedLines() },
  {
    id: "swoosh",
    name: "Swoosh",
    category: "Snelheid",
    svg: wrap(900, 260, `<path d="M0 220 C250 250 600 180 900 0 C720 160 420 260 120 260 C70 260 30 245 0 220 Z"/>`),
  },
  {
    id: "bolt",
    name: "Bliksem",
    category: "Racing",
    svg: wrap(200, 400, `<path d="M120 0 L20 220 L95 220 L60 400 L190 150 L110 150 L160 0 Z"/>`),
  },
  { id: "checker", name: "Geblokte vlag", category: "Racing", svg: checkerFlag() },
  {
    id: "arrow",
    name: "Pijl",
    category: "Vormen",
    svg: wrap(500, 240, `<path d="M0 80 L330 80 L330 0 L500 120 L330 240 L330 160 L0 160 Z"/>`),
  },
  { id: "star", name: "Ster", category: "Vormen", svg: star() },
  { id: "burst", name: "Starburst", category: "Vormen", svg: starburst() },
  {
    id: "shield",
    name: "Schild",
    category: "Vormen",
    svg: wrap(300, 360, `<path d="M150 0 L300 50 L290 190 C280 280 220 330 150 360 C80 330 20 280 10 190 L0 50 Z"/>`),
  },
  {
    id: "ring",
    name: "Nummercirkel",
    category: "Racing",
    svg: wrap(300, 300, `<path fill-rule="evenodd" d="M150 0 A150 150 0 1 0 150.1 0 Z M150 30 A120 120 0 1 1 149.9 30 Z"/>`),
  },
  {
    id: "wing",
    name: "Vleugel",
    category: "Decoratie",
    svg: wrap(
      600,
      260,
      `<path d="M0 200 C80 120 200 60 600 0 C520 50 440 70 380 80 C470 85 520 80 580 70 C500 120 420 130 350 135 C430 145 480 145 540 140 C460 185 380 190 300 190 C350 205 400 210 450 210 C330 250 200 260 0 200 Z"/>`,
    ),
  },
  {
    id: "crown",
    name: "Kroon",
    category: "Decoratie",
    svg: wrap(400, 260, `<path d="M0 60 L100 140 L200 0 L300 140 L400 60 L360 220 L40 220 Z M40 235 L360 235 L360 260 L40 260 Z"/>`),
  },
  {
    id: "tribal",
    name: "Tribal",
    category: "Decoratie",
    svg: wrap(
      700,
      240,
      `<path d="M0 120 C120 40 220 30 330 90 C300 40 330 10 380 0 C360 40 380 80 440 100 C520 120 600 90 700 40 C640 130 560 170 460 160 C500 190 540 200 600 200 C520 240 430 230 370 180 C380 210 400 225 430 240 C340 235 300 190 290 150 C220 120 120 120 0 120 Z"/>`,
    ),
  },
  { id: "waves", name: "Golflijnen", category: "Snelheid", svg: waveStripes() },
  { id: "halftone", name: "Halftone-fade", category: "Decoratie", svg: halftoneFade() },
  {
    id: "stripe_tape",
    name: "Tapestreep",
    category: "Racing",
    svg: wrap(1000, 120, `<path d="M0 0 H1000 V28 H0 Z M0 46 H1000 V74 H0 Z M0 92 H1000 V120 H0 Z"/>`),
  },
];

export function svgToDataUrl(svg: string): string {
  return "data:image/svg+xml;base64," + btoa(unescape(encodeURIComponent(svg)));
}

export function svgSize(svg: string): { w: number; h: number } {
  const m = svg.match(/viewBox="0 0 ([\d.]+) ([\d.]+)"/);
  return m ? { w: Number(m[1]), h: Number(m[2]) } : { w: 200, h: 200 };
}
