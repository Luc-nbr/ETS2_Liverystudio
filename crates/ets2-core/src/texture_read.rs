//! Reading game textures: `.tobj` → `.dds` (or HashFS v2 packed images), DDS decoding to
//! RGBA8 and PNG encoding. Used to show stock textures and existing paint jobs.

use std::io::Cursor;

use image::{imageops::FilterType, ImageBuffer, ImageFormat, Rgba, RgbaImage};

use crate::hashfs::{join, normalize, parent, PackedTexture, Vfs};
use crate::{Error, Result};

/// Decoded top mip level.
pub struct DecodedTexture {
    pub width: u32,
    pub height: u32,
    pub rgba: Vec<u8>,
}

// DXGI_FORMAT values we understand
const R8G8B8A8_UNORM: u32 = 28;
const R8G8B8A8_UNORM_SRGB: u32 = 29;
const R8G8_UNORM: u32 = 49;
const R8_UNORM: u32 = 61;
const A8_UNORM: u32 = 65;
const BC1: [u32; 3] = [70, 71, 72];
const BC2: [u32; 3] = [73, 74, 75];
const BC3: [u32; 3] = [76, 77, 78];
const BC4: [u32; 3] = [79, 80, 81];
const BC5: [u32; 3] = [82, 83, 84];
const BC7: [u32; 3] = [97, 98, 99];
const B8G8R8A8_UNORM: u32 = 87;
const B8G8R8X8_UNORM: u32 = 88;
const B8G8R8A8_TYPELESS: u32 = 90;
const B8G8R8A8_UNORM_SRGB: u32 = 91;
const B8G8R8X8_UNORM_SRGB: u32 = 93;

/// (row pitch, number of rows) of a mip level, like DirectXTex GetSurfaceInfo.
fn surface_info(width: u32, height: u32, format: u32) -> Result<(usize, usize)> {
    let (w, h) = (width as usize, height as usize);
    let bc8 = BC1.contains(&format) || BC4.contains(&format);
    let bc16 = BC2.contains(&format) || BC3.contains(&format) || BC5.contains(&format) || BC7.contains(&format) || (94..=96).contains(&format);
    if bc8 || bc16 {
        let bw = w.div_ceil(4).max(1);
        let bh = h.div_ceil(4).max(1);
        return Ok((bw * if bc8 { 8 } else { 16 }, bh));
    }
    let bpp = match format {
        R8G8B8A8_UNORM | R8G8B8A8_UNORM_SRGB | 27 | 30 | 31 | 32 | B8G8R8A8_UNORM | B8G8R8X8_UNORM | B8G8R8A8_TYPELESS | B8G8R8A8_UNORM_SRGB | 92 | B8G8R8X8_UNORM_SRGB => 32,
        R8G8_UNORM | 48 | 50 | 51 | 52 => 16,
        R8_UNORM | 60 | 62 | 63 | 64 | A8_UNORM => 8,
        f => return Err(Error::Unsupported(format!("DXGI format {f}"))),
    };
    Ok(((w * bpp).div_ceil(8), h))
}

fn decode_bc(data: &[u8], w: u32, h: u32, f: fn(&[u8], usize, usize, &mut [u32]) -> std::result::Result<(), &'static str>) -> Result<Vec<u8>> {
    let mut px = vec![0u32; (w as usize) * (h as usize)];
    f(data, w as usize, h as usize, &mut px).map_err(|e| Error::Invalid(format!("BCn decode: {e}")))?;
    let mut out = Vec::with_capacity(px.len() * 4);
    for p in px {
        let [b, g, r, a] = p.to_le_bytes();
        out.extend_from_slice(&[r, g, b, a]);
    }
    Ok(out)
}

/// Decodes tightly packed top-mip data of the given DXGI format to RGBA8.
pub fn decode_surface(data: &[u8], width: u32, height: u32, format: u32) -> Result<DecodedTexture> {
    let (pitch, rows) = surface_info(width, height, format)?;
    if data.len() < pitch * rows {
        return Err(Error::Invalid("texture data too short".into()));
    }
    let data = &data[..pitch * rows];
    let n = (width as usize) * (height as usize);
    let rgba = if BC1.contains(&format) {
        decode_bc(data, width, height, texture2ddecoder::decode_bc1)?
    } else if BC2.contains(&format) {
        decode_bc(data, width, height, texture2ddecoder::decode_bc2)?
    } else if BC3.contains(&format) {
        decode_bc(data, width, height, texture2ddecoder::decode_bc3)?
    } else if BC4.contains(&format) {
        decode_bc(data, width, height, texture2ddecoder::decode_bc4)?
    } else if BC5.contains(&format) {
        decode_bc(data, width, height, texture2ddecoder::decode_bc5)?
    } else if BC7.contains(&format) {
        decode_bc(data, width, height, texture2ddecoder::decode_bc7)?
    } else {
        let mut out = vec![0u8; n * 4];
        for y in 0..height as usize {
            let row = &data[y * pitch..];
            for x in 0..width as usize {
                let o = (y * width as usize + x) * 4;
                let px: [u8; 4] = match format {
                    R8G8B8A8_UNORM | R8G8B8A8_UNORM_SRGB | 27 | 30..=32 => [row[x * 4], row[x * 4 + 1], row[x * 4 + 2], row[x * 4 + 3]],
                    B8G8R8A8_UNORM | B8G8R8A8_TYPELESS | B8G8R8A8_UNORM_SRGB => [row[x * 4 + 2], row[x * 4 + 1], row[x * 4], row[x * 4 + 3]],
                    B8G8R8X8_UNORM | 92 | B8G8R8X8_UNORM_SRGB => [row[x * 4 + 2], row[x * 4 + 1], row[x * 4], 255],
                    R8G8_UNORM | 48 | 50..=52 => [row[x * 2], row[x * 2 + 1], 0, 255],
                    A8_UNORM => [255, 255, 255, row[x]],
                    _ => [row[x], row[x], row[x], 255],
                };
                out[o..o + 4].copy_from_slice(&px);
            }
        }
        out
    };
    Ok(DecodedTexture { width, height, rgba })
}

/// Top mip of a HashFS v2 packed texture (rows are padded to `pitch_alignment`).
pub fn decode_packed(t: &PackedTexture) -> Result<DecodedTexture> {
    let (pitch, rows) = surface_info(t.width, t.height, t.format)?;
    let align = t.pitch_alignment.max(1) as usize;
    let stride = pitch.div_ceil(align) * align;
    let mut tight = Vec::with_capacity(pitch * rows);
    for r in 0..rows {
        let start = r * stride;
        let row = t.surface.get(start..start + pitch).ok_or_else(|| Error::Invalid("packed texture data too short".into()))?;
        tight.extend_from_slice(row);
    }
    decode_surface(&tight, t.width, t.height, t.format)
}

/// Parses a DDS file (legacy or DX10 header) and decodes its top mip.
pub fn decode_dds(data: &[u8]) -> Result<DecodedTexture> {
    let u32_at = |o: usize| -> Result<u32> {
        data.get(o..o + 4).map(|b| u32::from_le_bytes(b.try_into().unwrap())).ok_or_else(|| Error::Invalid("truncated DDS header".into()))
    };
    if data.len() < 128 || &data[0..4] != b"DDS " {
        return Err(Error::Invalid("not a DDS file".into()));
    }
    let height = u32_at(12)?;
    let width = u32_at(16)?;
    let pf_flags = u32_at(80)?;
    let fourcc = &data[84..88];
    let bit_count = u32_at(88)?;
    let masks = [u32_at(92)?, u32_at(96)?, u32_at(100)?, u32_at(104)?];
    let mut offset = 128;
    let format = if pf_flags & 0x4 != 0 {
        match fourcc {
            b"DXT1" => 71,
            b"DXT2" | b"DXT3" => 74,
            b"DXT4" | b"DXT5" => 77,
            b"ATI1" | b"BC4U" => 80,
            b"ATI2" | b"BC5U" => 83,
            b"DX10" => {
                offset = 148;
                u32_at(128)?
            }
            other => return Err(Error::Unsupported(format!("DDS FourCC {:?}", String::from_utf8_lossy(other)))),
        }
    } else if pf_flags & 0x40 != 0 {
        match (bit_count, masks) {
            (32, [0xff, 0xff00, 0xff0000, _]) => R8G8B8A8_UNORM,
            (32, [0xff0000, 0xff00, 0xff, 0xff000000]) => B8G8R8A8_UNORM,
            (32, [0xff0000, 0xff00, 0xff, 0]) => B8G8R8X8_UNORM,
            (24, [0xff0000, 0xff00, 0xff, _]) => {
                // 24-bit BGR: expand manually
                let n = (width * height) as usize;
                let src = data.get(offset..offset + n * 3).ok_or_else(|| Error::Invalid("DDS data too short".into()))?;
                let mut rgba = Vec::with_capacity(n * 4);
                for p in src.chunks_exact(3) {
                    rgba.extend_from_slice(&[p[2], p[1], p[0], 255]);
                }
                return Ok(DecodedTexture { width, height, rgba });
            }
            _ => return Err(Error::Unsupported(format!("uncompressed DDS layout ({bit_count} bit)"))),
        }
    } else if pf_flags & 0x20000 != 0 && bit_count == 8 {
        R8_UNORM
    } else {
        return Err(Error::Unsupported("DDS pixel format".into()));
    };
    decode_surface(data.get(offset..).unwrap_or(&[]), width, height, format)
}

/// Texture path referenced by a binary `.tobj` (first texture).
pub fn tobj_texture_path(tobj: &[u8], tobj_path: &str) -> Result<String> {
    if tobj.len() < 48 || u32::from_le_bytes(tobj[0..4].try_into().unwrap()) != 0x70b1_0a01 {
        // text tobj ("map 2d /path.dds")
        let text = String::from_utf8_lossy(tobj);
        if let Some(p) = text.split_whitespace().find(|w| w.to_ascii_lowercase().ends_with(".dds")) {
            return Ok(resolve(p, tobj_path));
        }
        return Err(Error::Invalid(format!("{tobj_path}: unsupported tobj")));
    }
    let len = u64::from_le_bytes(tobj[40..48].try_into().unwrap()) as usize;
    let raw = tobj.get(48..48 + len).ok_or_else(|| Error::Invalid(format!("{tobj_path}: truncated tobj")))?;
    Ok(resolve(&String::from_utf8_lossy(raw), tobj_path))
}

fn resolve(p: &str, relative_to: &str) -> String {
    let p = p.trim().trim_matches('"');
    if p.starts_with('/') {
        normalize(p)
    } else {
        join(&parent(relative_to), p)
    }
}

fn ext(path: &str) -> String {
    path.rsplit_once('.').map(|(_, e)| e.to_ascii_lowercase()).unwrap_or_default()
}

fn with_ext(path: &str, e: &str) -> String {
    match path.rsplit_once('.') {
        Some((stem, _)) => format!("{stem}.{e}"),
        None => format!("{path}.{e}"),
    }
}

/// Loads and decodes the texture at `path` (.tobj, .dds, .png, .jpg) from the VFS.
pub fn load_texture(vfs: &Vfs, path: &str) -> Result<DecodedTexture> {
    load_inner(vfs, &normalize(path), 0)
}

fn load_inner(vfs: &Vfs, path: &str, depth: u32) -> Result<DecodedTexture> {
    if depth > 4 {
        return Err(Error::Invalid("texture reference loop".into()));
    }
    match ext(path).as_str() {
        "tobj" => {
            if let Some(packed) = vfs.read_packed_texture(path)? {
                return decode_packed(&packed);
            }
            let data = vfs.read(path)?;
            let target = tobj_texture_path(&data, path)?;
            load_inner(vfs, &target, depth + 1)
        }
        "dds" => {
            if vfs.exists(path).is_some() {
                return decode_dds(&vfs.read(path)?);
            }
            // In HashFS v2 the dds lives inside the packed .tobj entry.
            let tobj = with_ext(path, "tobj");
            match vfs.read_packed_texture(&tobj)? {
                Some(p) => decode_packed(&p),
                None => Err(Error::NotFound(path.to_string())),
            }
        }
        "mat" => {
            // first texture referenced by the material
            let text = vfs.read_text(path)?;
            let tex = crate::model::parse_mat(&text, path).textures.into_iter().next().ok_or_else(|| Error::NotFound(format!("{path}: no texture")))?;
            load_inner(vfs, &tex, depth + 1)
        }
        _ => {
            let data = vfs.read(path)?;
            let img = image::load_from_memory(&data)?.to_rgba8();
            Ok(DecodedTexture { width: img.width(), height: img.height(), rgba: img.into_raw() })
        }
    }
}

/// Encodes RGBA8 as PNG, downscaled so the longest side is at most `max_size` (0 = no limit).
pub fn to_png(t: DecodedTexture, max_size: u32) -> Result<(u32, u32, Vec<u8>)> {
    let mut img: RgbaImage = ImageBuffer::<Rgba<u8>, _>::from_raw(t.width, t.height, t.rgba).ok_or_else(|| Error::Invalid("pixel buffer size mismatch".into()))?;
    if max_size > 0 && (img.width() > max_size || img.height() > max_size) {
        let s = max_size as f64 / img.width().max(img.height()) as f64;
        let w = ((img.width() as f64 * s).round() as u32).max(1);
        let h = ((img.height() as f64 * s).round() as u32).max(1);
        img = image::imageops::resize(&img, w, h, FilterType::Triangle);
    }
    let (w, h) = img.dimensions();
    let mut out = Vec::new();
    img.write_to(&mut Cursor::new(&mut out), ImageFormat::Png)?;
    Ok((w, h, out))
}

/// Reads any texture from the game files and returns (width, height, PNG bytes).
pub fn read_texture(vfs: &Vfs, path: &str, max_size: u32) -> Result<(u32, u32, Vec<u8>)> {
    to_png(load_texture(vfs, path)?, max_size)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dds_rgba(w: u32, h: u32, px: &[u8]) -> Vec<u8> {
        let mut d = vec![0u8; 128];
        d[0..4].copy_from_slice(b"DDS ");
        d[4..8].copy_from_slice(&124u32.to_le_bytes());
        d[12..16].copy_from_slice(&h.to_le_bytes());
        d[16..20].copy_from_slice(&w.to_le_bytes());
        d[76..80].copy_from_slice(&32u32.to_le_bytes());
        d[80..84].copy_from_slice(&0x41u32.to_le_bytes());
        d[88..92].copy_from_slice(&32u32.to_le_bytes());
        d[92..96].copy_from_slice(&0xff0000u32.to_le_bytes());
        d[96..100].copy_from_slice(&0xff00u32.to_le_bytes());
        d[100..104].copy_from_slice(&0xffu32.to_le_bytes());
        d[104..108].copy_from_slice(&0xff000000u32.to_le_bytes());
        d.extend_from_slice(px);
        d
    }

    #[test]
    fn decodes_bgra_dds() {
        // 2x1: red, green (stored BGRA)
        let d = dds_rgba(2, 1, &[0, 0, 255, 255, 0, 255, 0, 128]);
        let t = decode_dds(&d).unwrap();
        assert_eq!((t.width, t.height), (2, 1));
        assert_eq!(t.rgba, vec![255, 0, 0, 255, 0, 255, 0, 128]);
    }

    #[test]
    fn decodes_dxt1_solid_block() {
        let mut d = vec![0u8; 128];
        d[0..4].copy_from_slice(b"DDS ");
        d[12..16].copy_from_slice(&4u32.to_le_bytes());
        d[16..20].copy_from_slice(&4u32.to_le_bytes());
        d[80..84].copy_from_slice(&4u32.to_le_bytes());
        d[84..88].copy_from_slice(b"DXT1");
        // c0 = pure blue (0x001F), c1 = 0, indices all 0
        d.extend_from_slice(&[0x1F, 0x00, 0x00, 0x00, 0, 0, 0, 0]);
        let t = decode_dds(&d).unwrap();
        assert_eq!(&t.rgba[0..4], &[0, 0, 255, 255]);
        assert_eq!(t.rgba.len(), 64);
    }

    #[test]
    fn packed_rows_are_unpadded() {
        // 2x2 RGBA8 with 256-byte row pitch alignment
        let mut surface = vec![0u8; 256 + 8];
        surface[0..8].copy_from_slice(&[1, 2, 3, 4, 5, 6, 7, 8]);
        surface[256..264].copy_from_slice(&[9, 10, 11, 12, 13, 14, 15, 16]);
        let t = PackedTexture { width: 2, height: 2, mip_count: 1, format: R8G8B8A8_UNORM, is_cube: false, face_count: 1, pitch_alignment: 256, image_alignment: 512, surface };
        let d = decode_packed(&t).unwrap();
        assert_eq!(d.rgba, (1..=16).collect::<Vec<u8>>());
    }

    #[test]
    fn tobj_path_and_png() {
        let tobj = crate::texture::write_tobj("/vehicle/truck/x/cab.dds");
        assert_eq!(tobj_texture_path(&tobj, "/vehicle/truck/x/cab.tobj").unwrap(), "/vehicle/truck/x/cab.dds");
        let t = DecodedTexture { width: 8, height: 4, rgba: vec![200; 8 * 4 * 4] };
        let (w, h, png) = to_png(t, 4).unwrap();
        assert_eq!((w, h), (4, 2));
        assert_eq!(&png[1..4], b"PNG");
    }
}
