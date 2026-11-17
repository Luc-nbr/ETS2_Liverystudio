// Minimal DDS decoder (top mip only) for importing existing skins:
// uncompressed 32/24-bit RGB(A), BC1/DXT1, BC2/DXT3, BC3/DXT5 (legacy and DX10 headers).

export interface DecodedImage {
  width: number;
  height: number;
  data: Uint8ClampedArray; // RGBA
}

const FOURCC = (s: string) => s.charCodeAt(0) | (s.charCodeAt(1) << 8) | (s.charCodeAt(2) << 16) | (s.charCodeAt(3) << 24);

function rgb565(c: number): [number, number, number] {
  const r = (c >> 11) & 31, g = (c >> 5) & 63, b = c & 31;
  return [(r << 3) | (r >> 2), (g << 2) | (g >> 4), (b << 3) | (b >> 2)];
}

function decodeColorBlock(v: DataView, o: number, out: Uint8ClampedArray, w: number, h: number, bx: number, by: number, forceFour: boolean, alpha: number[] | null) {
  const c0 = v.getUint16(o, true), c1 = v.getUint16(o + 2, true);
  const p0 = rgb565(c0), p1 = rgb565(c1);
  const pal: number[][] = [
    [...p0, 255],
    [...p1, 255],
  ];
  if (c0 > c1 || forceFour) {
    pal.push([(2 * p0[0] + p1[0]) / 3, (2 * p0[1] + p1[1]) / 3, (2 * p0[2] + p1[2]) / 3, 255]);
    pal.push([(p0[0] + 2 * p1[0]) / 3, (p0[1] + 2 * p1[1]) / 3, (p0[2] + 2 * p1[2]) / 3, 255]);
  } else {
    pal.push([(p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2, (p0[2] + p1[2]) / 2, 255]);
    pal.push([0, 0, 0, 0]);
  }
  const bits = v.getUint32(o + 4, true);
  for (let i = 0; i < 16; i++) {
    const x = bx + (i & 3), y = by + (i >> 2);
    if (x >= w || y >= h) continue;
    const c = pal[(bits >> (2 * i)) & 3];
    const k = (y * w + x) * 4;
    out[k] = c[0];
    out[k + 1] = c[1];
    out[k + 2] = c[2];
    out[k + 3] = alpha ? alpha[i] : c[3];
  }
}

function bc3Alpha(v: DataView, o: number): number[] {
  const a0 = v.getUint8(o), a1 = v.getUint8(o + 1);
  const pal = [a0, a1];
  if (a0 > a1) for (let i = 1; i <= 6; i++) pal.push(((7 - i) * a0 + i * a1) / 7);
  else {
    for (let i = 1; i <= 4; i++) pal.push(((5 - i) * a0 + i * a1) / 5);
    pal.push(0, 255);
  }
  // 48 bits of 3-bit indices
  const lo = v.getUint32(o + 2, true) >>> 0;
  const hi = v.getUint16(o + 6, true);
  const out: number[] = [];
  for (let i = 0; i < 16; i++) {
    let idx: number;
    if (i < 10) idx = (lo >>> (3 * i)) & 7;
    else if (i === 10) idx = ((lo >>> 30) | ((hi & 1) << 2)) & 7;
    else idx = (hi >> (3 * (i - 11) + 1)) & 7;
    out.push(pal[idx]);
  }
  return out;
}

export function decodeDds(buf: ArrayBuffer): DecodedImage {
  const v = new DataView(buf);
  if (v.getUint32(0, true) !== FOURCC("DDS ")) throw new Error("Geen DDS-bestand");
  const height = v.getUint32(12, true), width = v.getUint32(16, true);
  const pfFlags = v.getUint32(80, true);
  let fourcc = v.getUint32(84, true);
  const bitCount = v.getUint32(88, true);
  const masks = [v.getUint32(92, true), v.getUint32(96, true), v.getUint32(100, true), v.getUint32(104, true)];
  let offset = 128;
  if (fourcc === FOURCC("DX10")) {
    const dxgi = v.getUint32(128, true);
    offset = 148;
    if (dxgi === 71 || dxgi === 72) fourcc = FOURCC("DXT1");
    else if (dxgi === 74 || dxgi === 75) fourcc = FOURCC("DXT3");
    else if (dxgi === 77 || dxgi === 78) fourcc = FOURCC("DXT5");
    else if (dxgi === 28 || dxgi === 29) return rgba(v, offset, width, height, [0xff, 0xff00, 0xff0000, 0xff000000], 32);
    else if (dxgi === 87 || dxgi === 91) return rgba(v, offset, width, height, [0xff0000, 0xff00, 0xff, 0xff000000], 32);
    else throw new Error(`DDS-formaat (DXGI ${dxgi}) wordt niet ondersteund — exporteer als PNG of DXT5`);
  }
  const out = new Uint8ClampedArray(width * height * 4);
  if (pfFlags & 0x4) {
    const kind = fourcc === FOURCC("DXT1") ? 1 : fourcc === FOURCC("DXT3") || fourcc === FOURCC("DXT2") ? 2 : fourcc === FOURCC("DXT5") || fourcc === FOURCC("DXT4") ? 3 : 0;
    if (!kind) throw new Error("Compressieformaat wordt niet ondersteund (alleen DXT1/3/5)");
    const blockSize = kind === 1 ? 8 : 16;
    let o = offset;
    for (let by = 0; by < height; by += 4)
      for (let bx = 0; bx < width; bx += 4) {
        if (kind === 1) decodeColorBlock(v, o, out, width, height, bx, by, false, null);
        else if (kind === 2) {
          const a: number[] = [];
          for (let i = 0; i < 8; i++) {
            const byte = v.getUint8(o + i);
            a.push((byte & 15) * 17, (byte >> 4) * 17);
          }
          decodeColorBlock(v, o + 8, out, width, height, bx, by, true, a);
        } else decodeColorBlock(v, o + 8, out, width, height, bx, by, true, bc3Alpha(v, o));
        o += blockSize;
      }
    return { width, height, data: out };
  }
  if (pfFlags & 0x40) return rgba(v, offset, width, height, masks, bitCount);
  throw new Error("Onbekend DDS-pixelformaat");
}

function rgba(v: DataView, offset: number, width: number, height: number, masks: number[], bitCount: number): DecodedImage {
  const out = new Uint8ClampedArray(width * height * 4);
  const bpp = bitCount / 8;
  const shift = (m: number) => (m ? Math.log2(m & -m) : 0);
  const sh = masks.map(shift);
  const bits = masks.map((m) => (m ? Math.round(Math.log2((m >>> shift(m)) + 1)) : 0));
  const scale = (val: number, b: number) => (b >= 8 ? val >>> (b - 8) : Math.round((val * 255) / ((1 << b) - 1)));
  for (let i = 0; i < width * height; i++) {
    const p = offset + i * bpp;
    const px = bpp === 4 ? v.getUint32(p, true) : v.getUint8(p) | (v.getUint8(p + 1) << 8) | (bpp > 2 ? v.getUint8(p + 2) << 16 : 0);
    for (let c = 0; c < 4; c++) {
      out[i * 4 + c] = masks[c] ? scale((px & masks[c]) >>> sh[c], bits[c]) : c === 3 ? 255 : 0;
    }
  }
  return { width, height, data: out };
}

/** Decodes a DDS file into a PNG data URL. */
export async function ddsToDataUrl(file: Blob): Promise<{ url: string; width: number; height: number }> {
  const img = decodeDds(await file.arrayBuffer());
  const c = document.createElement("canvas");
  c.width = img.width;
  c.height = img.height;
  c.getContext("2d")!.putImageData(new ImageData(img.data, img.width, img.height), 0, 0);
  return { url: c.toDataURL("image/png"), width: img.width, height: img.height };
}
