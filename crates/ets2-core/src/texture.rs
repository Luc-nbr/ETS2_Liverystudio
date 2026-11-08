//! DDS and TOBJ writers.

use crate::{Error, Result};

/// 40-byte binary TOBJ header used by Paint Job Packer (2D map, clamp_to_edge U/V,
/// default filters, uncompressed-allowed). Proven to load in ETS2/ATS.
const TOBJ_HEADER: [u8; 40] = [
    0x01, 0x0A, 0xB1, 0x70, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x02, 0x00, 0x02, 0x00, 0x03, 0x03, 0x03, 0x00,
    0x02, 0x02, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00,
];

/// Binary `.tobj` pointing at `dds_path` (absolute virtual path, e.g. `/vehicle/.../cab.dds`).
pub fn write_tobj(dds_path: &str) -> Vec<u8> {
    let mut out = Vec::with_capacity(48 + dds_path.len());
    out.extend_from_slice(&TOBJ_HEADER);
    out.extend_from_slice(&(dds_path.len() as u64).to_le_bytes());
    out.extend_from_slice(dds_path.as_bytes());
    out
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DdsFormat {
    /// Uncompressed 32-bit B8G8R8A8 (lossless)
    Bgra8,
    /// BC3 / DXT5
    Bc3,
}

impl DdsFormat {
    pub fn from_name(s: &str) -> Result<Self> {
        match s {
            "rgba8" | "bgra8" => Ok(DdsFormat::Bgra8),
            "bc3" | "dxt5" => Ok(DdsFormat::Bc3),
            _ => Err(Error::Invalid(format!("unknown texture format {s}"))),
        }
    }
}

/// Halves an RGBA8 image (box filter, alpha-weighted so transparent pixels don't darken edges).
pub fn downsample(rgba: &[u8], w: u32, h: u32) -> (Vec<u8>, u32, u32) {
    let nw = (w / 2).max(1);
    let nh = (h / 2).max(1);
    let mut out = vec![0u8; (nw * nh * 4) as usize];
    for y in 0..nh {
        for x in 0..nw {
            let mut acc = [0f32; 4];
            let mut n = 0f32;
            for dy in 0..2 {
                for dx in 0..2 {
                    let sx = (x * 2 + dx).min(w - 1);
                    let sy = (y * 2 + dy).min(h - 1);
                    let i = ((sy * w + sx) * 4) as usize;
                    let a = rgba[i + 3] as f32 / 255.0;
                    acc[0] += rgba[i] as f32 * a;
                    acc[1] += rgba[i + 1] as f32 * a;
                    acc[2] += rgba[i + 2] as f32 * a;
                    acc[3] += a;
                    n += 1.0;
                }
            }
            let o = ((y * nw + x) * 4) as usize;
            if acc[3] > 0.0 {
                out[o] = (acc[0] / acc[3]).round().clamp(0.0, 255.0) as u8;
                out[o + 1] = (acc[1] / acc[3]).round().clamp(0.0, 255.0) as u8;
                out[o + 2] = (acc[2] / acc[3]).round().clamp(0.0, 255.0) as u8;
            }
            out[o + 3] = (acc[3] / n * 255.0).round().clamp(0.0, 255.0) as u8;
        }
    }
    (out, nw, nh)
}

fn mip_count(w: u32, h: u32) -> u32 {
    32 - w.max(h).max(1).leading_zeros()
}

/// Encodes RGBA8 pixels as a DDS file.
pub fn write_dds(rgba: &[u8], width: u32, height: u32, format: DdsFormat, mipmaps: bool) -> Result<Vec<u8>> {
    if rgba.len() != (width as usize) * (height as usize) * 4 || width == 0 || height == 0 {
        return Err(Error::Invalid("pixel buffer size does not match dimensions".into()));
    }
    let levels = if mipmaps { mip_count(width, height) } else { 1 };

    let mut out = Vec::new();
    out.extend_from_slice(b"DDS ");
    let mut hdr = [0u32; 31];
    hdr[0] = 124; // dwSize
    let mut flags = 0x1 | 0x2 | 0x4 | 0x1000; // CAPS | HEIGHT | WIDTH | PIXELFORMAT
    if mipmaps {
        flags |= 0x20000; // MIPMAPCOUNT
    }
    match format {
        DdsFormat::Bgra8 => flags |= 0x8,    // PITCH
        DdsFormat::Bc3 => flags |= 0x80000, // LINEARSIZE
    }
    hdr[1] = flags;
    hdr[2] = height;
    hdr[3] = width;
    hdr[4] = match format {
        DdsFormat::Bgra8 => width * 4,
        DdsFormat::Bc3 => width.div_ceil(4).max(1) * height.div_ceil(4).max(1) * 16,
    };
    hdr[5] = 0; // depth
    hdr[6] = levels;
    // pixel format starts at index 18 (offset 72)
    hdr[18] = 32;
    match format {
        DdsFormat::Bgra8 => {
            hdr[19] = 0x40 | 0x1; // RGB | ALPHAPIXELS
            hdr[20] = 0;
            hdr[21] = 32;
            hdr[22] = 0x00FF_0000;
            hdr[23] = 0x0000_FF00;
            hdr[24] = 0x0000_00FF;
            hdr[25] = 0xFF00_0000;
        }
        DdsFormat::Bc3 => {
            hdr[19] = 0x4; // FOURCC
            hdr[20] = u32::from_le_bytes(*b"DXT5");
        }
    }
    hdr[26] = 0x1000 | if mipmaps { 0x8 | 0x40_0000 } else { 0 }; // caps
    for v in hdr {
        out.extend_from_slice(&v.to_le_bytes());
    }

    let mut level = rgba.to_vec();
    let (mut w, mut h) = (width, height);
    for i in 0..levels {
        match format {
            DdsFormat::Bgra8 => {
                for px in level.chunks_exact(4) {
                    out.extend_from_slice(&[px[2], px[1], px[0], px[3]]);
                }
            }
            DdsFormat::Bc3 => {
                let fmt = texpresso::Format::Bc3;
                let mut buf = vec![0u8; fmt.compressed_size(w as usize, h as usize)];
                fmt.compress(&level, w as usize, h as usize, texpresso::Params::default(), &mut buf);
                out.extend_from_slice(&buf);
            }
        }
        if i + 1 < levels {
            let (nl, nw, nh) = downsample(&level, w, h);
            level = nl;
            w = nw;
            h = nh;
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tobj_layout() {
        let path = "/vehicle/truck/upgrade/paintjob/x/y/cab.dds";
        let t = write_tobj(path);
        assert_eq!(&t[0..4], &[0x01, 0x0A, 0xB1, 0x70]);
        assert_eq!(t.len(), 48 + path.len());
        assert_eq!(u64::from_le_bytes(t[40..48].try_into().unwrap()), path.len() as u64);
        assert_eq!(&t[48..], path.as_bytes());
        let hex: String = TOBJ_HEADER.iter().map(|b| format!("{b:02X}")).collect();
        assert_eq!(hex, "010AB170000000000000000000000000000000000100020002000303030002020001000000010000");
    }

    #[test]
    fn dds_uncompressed_header_and_size() {
        let px = [10u8, 20, 30, 255].repeat(8 * 4);
        let d = write_dds(&px, 8, 4, DdsFormat::Bgra8, true).unwrap();
        assert_eq!(&d[0..4], b"DDS ");
        let u = |i: usize| u32::from_le_bytes(d[4 + i * 4..8 + i * 4].try_into().unwrap());
        assert_eq!(u(0), 124);
        assert_eq!(u(2), 4); // height
        assert_eq!(u(3), 8); // width
        assert_eq!(u(6), 4); // mips 8x4,4x2,2x1,1x1
        assert_eq!(u(18), 32);
        assert_eq!(u(21), 32);
        // first pixel is BGRA
        assert_eq!(&d[128..132], &[30, 20, 10, 255]);
        assert_eq!(d.len(), 128 + (32 + 8 + 2 + 1) * 4);
    }

    #[test]
    fn dds_bc3_size() {
        let px = vec![255u8; 16 * 16 * 4];
        let d = write_dds(&px, 16, 16, DdsFormat::Bc3, false).unwrap();
        assert_eq!(&d[84..88], b"DXT5");
        assert_eq!(d.len(), 128 + 16 * 16);
        let d = write_dds(&px, 16, 16, DdsFormat::Bc3, true).unwrap();
        // 16x16 (256) + 8x8 (64) + 4x4 (16) + 2x2 (16) + 1x1 (16)
        assert_eq!(d.len(), 128 + 256 + 64 + 16 + 16 + 16);
    }

    #[test]
    fn downsample_ignores_transparent_color() {
        // left two pixels: opaque red; right: transparent black
        let px = [255, 0, 0, 255, 0, 0, 0, 0, 255, 0, 0, 255, 0, 0, 0, 0];
        let (o, w, h) = downsample(&px, 2, 2);
        assert_eq!((w, h), (1, 1));
        assert_eq!(o[0], 255);
        assert_eq!(o[3], 128);
    }
}
