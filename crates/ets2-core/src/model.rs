//! PMD (model descriptor, v4) + PMG (geometry, v0x15) parsing and `.mat` inspection.
//!
//! Layouts follow TruckLib.Models (sk-zk, MIT). Only what the livery editor needs is
//! extracted: per-piece positions, normals, UV channels, triangle indices and the
//! material (per look) of each piece.

use base64::Engine;
use serde::Serialize;

use crate::hashfs::{join, parent, Vfs};
use crate::{Error, Result};

pub const PMD_VERSION: u32 = 4;
pub const PMG_VERSION: u8 = 0x15;
const PMG_HEADER_SIZE: usize = 112;
const PMG_PIECE_SIZE: usize = 100;
const PMG_PART_SIZE: usize = 24;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MaterialInfo {
    pub path: String,
    pub effect: String,
    pub textures: Vec<String>,
    pub paintable: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PieceData {
    pub material: u32,
    pub vertex_count: u32,
    pub uv_channels: u32,
    pub positions: String,
    pub normals: String,
    pub uvs: Vec<String>,
    pub indices: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PartData {
    pub name: String,
    pub pieces: Vec<PieceData>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelData {
    pub path: String,
    pub looks: Vec<String>,
    pub variants: Vec<String>,
    pub bbox_min: [f32; 3],
    pub bbox_max: [f32; 3],
    pub materials: Vec<MaterialInfo>,
    pub parts: Vec<PartData>,
}

/// Decodes an SCS token (base-38 packed string).
pub fn decode_token(mut v: u64) -> String {
    const CHARS: &[u8] = b"\x000123456789abcdefghijklmnopqrstuvwxyz_";
    let mut s = String::new();
    while v != 0 {
        let c = CHARS[(v % 38) as usize];
        if c != 0 {
            s.push(c as char);
        }
        v /= 38;
    }
    s
}

/// Encodes a string as an SCS token (only `[0-9a-z_]`, max 12 chars).
pub fn encode_token(s: &str) -> Option<u64> {
    const CHARS: &[u8] = b"\x000123456789abcdefghijklmnopqrstuvwxyz_";
    if s.len() > 12 {
        return None;
    }
    let mut v: u64 = 0;
    for c in s.bytes().rev() {
        let idx = CHARS.iter().position(|&x| x == c && x != 0)? as u64;
        v = v * 38 + idx;
    }
    Some(v)
}

struct Reader<'a> {
    b: &'a [u8],
}

impl<'a> Reader<'a> {
    fn need(&self, o: usize, n: usize) -> Result<()> {
        if o.checked_add(n).is_none_or(|e| e > self.b.len()) {
            Err(Error::Invalid(format!(
                "unexpected end of data at offset {o} (+{n}, size {})",
                self.b.len()
            )))
        } else {
            Ok(())
        }
    }
    fn u32(&self, o: usize) -> Result<u32> {
        self.need(o, 4)?;
        Ok(u32::from_le_bytes(self.b[o..o + 4].try_into().unwrap()))
    }
    fn i32(&self, o: usize) -> Result<i32> {
        Ok(self.u32(o)? as i32)
    }
    fn u64(&self, o: usize) -> Result<u64> {
        self.need(o, 8)?;
        Ok(u64::from_le_bytes(self.b[o..o + 8].try_into().unwrap()))
    }
    fn f32(&self, o: usize) -> Result<f32> {
        Ok(f32::from_bits(self.u32(o)?))
    }
    fn u16(&self, o: usize) -> Result<u16> {
        self.need(o, 2)?;
        Ok(u16::from_le_bytes([self.b[o], self.b[o + 1]]))
    }
    fn cstr(&self, o: usize) -> Result<String> {
        self.need(o, 0)?;
        let end = self.b[o..].iter().position(|&c| c == 0).map(|p| o + p).unwrap_or(self.b.len());
        Ok(String::from_utf8_lossy(&self.b[o..end]).to_string())
    }
}

#[derive(Debug, Clone, Default)]
pub struct Pmd {
    pub looks: Vec<String>,
    pub variants: Vec<String>,
    /// materials[look][material index]
    pub materials: Vec<Vec<String>>,
}

pub fn parse_pmd(data: &[u8]) -> Result<Pmd> {
    let r = Reader { b: data };
    if data.len() >= 4 && &data[1..4] == b"gmP" {
        return Err(Error::Invalid("this is a .pmg file, not a .pmd file".into()));
    }
    let version = r.u32(0)?;
    if version != PMD_VERSION {
        return Err(Error::Unsupported(format!(".pmd version {version}")));
    }
    let material_count = r.u32(4)? as usize;
    let look_count = r.u32(8)? as usize;
    let variant_count = r.u32(16)? as usize;
    let look_offset = r.u32(36)? as usize;
    let variant_offset = r.u32(40)? as usize;
    let mat_offsets_offset = r.u32(56)? as usize;
    let mat_paths_offset = r.u32(60)? as usize;

    let mut pmd = Pmd::default();
    for i in 0..look_count {
        pmd.looks.push(decode_token(r.u64(look_offset + i * 8)?));
    }
    for i in 0..variant_count {
        pmd.variants.push(decode_token(r.u64(variant_offset + i * 8)?));
    }
    // Sequential fallback list (TruckLib ignores the offsets; some files have bad block sizes)
    let sequential: Vec<String> = if mat_paths_offset <= data.len() {
        data[mat_paths_offset..]
            .split(|&c| c == 0)
            .map(|s| String::from_utf8_lossy(s).to_string())
            .collect()
    } else {
        Vec::new()
    };
    for l in 0..look_count {
        let mut mats = Vec::with_capacity(material_count);
        for m in 0..material_count {
            let i = l * material_count + m;
            let by_offset = r
                .u32(mat_offsets_offset + i * 4)
                .ok()
                .map(|o| o as usize)
                .filter(|&o| o >= mat_paths_offset && o < data.len())
                .and_then(|o| r.cstr(o).ok());
            let path = by_offset
                .or_else(|| sequential.get(i).cloned())
                .unwrap_or_default();
            mats.push(path);
        }
        pmd.materials.push(mats);
    }
    Ok(pmd)
}

#[derive(Debug, Clone, Default)]
pub struct Piece {
    pub material: u32,
    pub positions: Vec<f32>,
    pub normals: Vec<f32>,
    pub uvs: Vec<Vec<f32>>,
    pub indices: Vec<u32>,
}

#[derive(Debug, Clone, Default)]
pub struct Part {
    pub name: String,
    pub pieces: Vec<Piece>,
}

#[derive(Debug, Clone, Default)]
pub struct Pmg {
    pub bbox_min: [f32; 3],
    pub bbox_max: [f32; 3],
    pub parts: Vec<Part>,
}

pub fn parse_pmg(data: &[u8]) -> Result<Pmg> {
    let r = Reader { b: data };
    r.need(0, PMG_HEADER_SIZE)?;
    if &data[1..4] != b"gmP" {
        return Err(Error::Invalid("not a .pmg file (bad signature)".into()));
    }
    let version = data[0];
    if version != PMG_VERSION {
        return Err(Error::Unsupported(format!(
            ".pmg version 0x{version:02x} (only 0x{PMG_VERSION:02x} is supported)"
        )));
    }
    let piece_count = r.u32(4)? as usize;
    let part_count = r.u32(8)? as usize;
    let bbox_min = [r.f32(48)?, r.f32(52)?, r.f32(56)?];
    let bbox_max = [r.f32(60)?, r.f32(64)?, r.f32(68)?];
    let parts_offset = r.u32(76)? as usize;
    let pieces_offset = r.u32(84)? as usize;

    let mut pieces = Vec::with_capacity(piece_count);
    for p in 0..piece_count {
        let o = pieces_offset + p * PMG_PIECE_SIZE;
        r.need(o, PMG_PIECE_SIZE)?;
        let edges = r.u32(o)? as usize;
        let verts = r.u32(o + 4)? as usize;
        let uv_width = r.i32(o + 12)?.clamp(0, 8) as usize;
        let material = r.u32(o + 16)?;
        let pos_off = r.i32(o + 64)?;
        let nrm_off = r.i32(o + 68)?;
        let uv_off = r.i32(o + 72)?;
        let col2_off = r.i32(o + 80)?;
        let tan_off = r.i32(o + 84)?;
        let bidx_off = r.i32(o + 88)?;
        let bw_off = r.i32(o + 92)?;
        let idx_off = r.i32(o + 96)?;

        let has = |v: i32| v != -1;
        let uv_channels = if has(uv_off) { uv_width } else { 0 };
        let stride = 12
            + 12
            + if has(tan_off) { 16 } else { 0 }
            + 4
            + if has(col2_off) { 4 } else { 0 }
            + uv_channels * 8
            + if has(bidx_off) { 4 } else { 0 }
            + if has(bw_off) { 4 } else { 0 };

        if pos_off < 0 || nrm_off < 0 {
            return Err(Error::Invalid(format!("piece {p} has no position/normal stream")));
        }
        let (pos_off, nrm_off) = (pos_off as usize, nrm_off as usize);
        let mut piece = Piece {
            material,
            positions: Vec::with_capacity(verts * 3),
            normals: Vec::with_capacity(verts * 3),
            uvs: vec![Vec::with_capacity(verts * 2); uv_channels],
            indices: Vec::with_capacity(edges),
        };
        for v in 0..verts {
            let base = v * stride;
            for k in 0..3 {
                piece.positions.push(r.f32(pos_off + base + k * 4)?);
                piece.normals.push(r.f32(nrm_off + base + k * 4)?);
            }
            for (ch, uv) in piece.uvs.iter_mut().enumerate() {
                let uo = uv_off as usize + base + ch * 8;
                uv.push(r.f32(uo)?);
                uv.push(r.f32(uo + 4)?);
            }
        }
        if idx_off >= 0 {
            for i in 0..edges {
                let idx = r.u16(idx_off as usize + i * 2)? as u32;
                piece.indices.push(if (idx as usize) < verts { idx } else { 0 });
            }
        }
        pieces.push(piece);
    }

    let mut parts = Vec::with_capacity(part_count);
    let mut used = vec![false; pieces.len()];
    for i in 0..part_count {
        let o = parts_offset + i * PMG_PART_SIZE;
        let name = decode_token(r.u64(o)?);
        let count = r.u32(o + 8)? as usize;
        let index = r.u32(o + 12)? as usize;
        let mut part = Part { name, pieces: Vec::new() };
        for pi in index..(index + count).min(pieces.len()) {
            part.pieces.push(pieces[pi].clone());
            used[pi] = true;
        }
        parts.push(part);
    }
    // Pieces that are not referenced by any part (should not happen, but be safe)
    let orphans: Vec<Piece> = pieces
        .into_iter()
        .zip(used)
        .filter(|(_, u)| !u)
        .map(|(p, _)| p)
        .collect();
    if !orphans.is_empty() {
        parts.push(Part { name: "unassigned".into(), pieces: orphans });
    }
    Ok(Pmg { bbox_min, bbox_max, parts })
}

/// Extracts the effect name and referenced textures from a `.mat` file.
/// Handles both the legacy (`material : "x" { texture[0] : ... }`) and the
/// current (`effect : "x" { texture : "name" { source : ... } }`) syntax.
pub fn parse_mat(text: &str, mat_path: &str) -> MaterialInfo {
    let mut effect = String::new();
    let mut textures = Vec::new();
    let dir = parent(mat_path);
    for line in text.lines() {
        let line = line.trim();
        let Some((k, v)) = line.split_once(':') else { continue };
        let key = k.trim();
        let v = v.trim();
        let Some(rest) = v.strip_prefix('"') else { continue };
        let Some(end) = rest.find('"') else { continue };
        let value = &rest[..end];
        if effect.is_empty() && (key == "material" || key == "effect") {
            effect = value.to_string();
        } else if value.to_ascii_lowercase().ends_with(".tobj") {
            let p = if value.starts_with('/') { value.to_string() } else { join(&dir, value) };
            if !textures.contains(&p) {
                textures.push(p);
            }
        }
    }
    MaterialInfo {
        path: mat_path.to_string(),
        paintable: effect.contains("truckpaint"),
        effect,
        textures,
    }
}

fn b64_f32(v: &[f32]) -> String {
    let mut bytes = Vec::with_capacity(v.len() * 4);
    for f in v {
        bytes.extend_from_slice(&f.to_le_bytes());
    }
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

fn b64_u32(v: &[u32]) -> String {
    let mut bytes = Vec::with_capacity(v.len() * 4);
    for f in v {
        bytes.extend_from_slice(&f.to_le_bytes());
    }
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

/// Loads `<x>.pmd` + `<x>.pmg` and the materials of `look` from the VFS.
pub fn load_model(vfs: &Vfs, pmd_path: &str, look: usize) -> Result<ModelData> {
    let pmd_path = crate::hashfs::normalize(pmd_path);
    let pmg_path = match pmd_path.strip_suffix(".pmd") {
        Some(stem) => format!("{stem}.pmg"),
        None => return Err(Error::Invalid(format!("{pmd_path} is not a .pmd path"))),
    };
    let pmd = parse_pmd(&vfs.read(&pmd_path)?)?;
    let pmg = parse_pmg(&vfs.read(&pmg_path)?)?;
    let model_dir = parent(&pmd_path);

    let look_idx = look.min(pmd.looks.len().saturating_sub(1));
    let mat_paths = pmd.materials.get(look_idx).cloned().unwrap_or_default();
    let materials = mat_paths
        .iter()
        .map(|m| {
            let p = if m.starts_with('/') { m.clone() } else { join(&model_dir, m) };
            match vfs.read_text(&p) {
                Ok(text) => parse_mat(&text, &p),
                Err(_) => MaterialInfo {
                    path: p,
                    effect: String::new(),
                    textures: Vec::new(),
                    paintable: false,
                },
            }
        })
        .collect();

    let parts = pmg
        .parts
        .into_iter()
        .map(|part| PartData {
            name: part.name,
            pieces: part
                .pieces
                .into_iter()
                .map(|p| PieceData {
                    material: p.material,
                    vertex_count: (p.positions.len() / 3) as u32,
                    uv_channels: p.uvs.len() as u32,
                    positions: b64_f32(&p.positions),
                    normals: b64_f32(&p.normals),
                    uvs: p.uvs.iter().map(|u| b64_f32(u)).collect(),
                    indices: b64_u32(&p.indices),
                })
                .collect(),
        })
        .collect();

    Ok(ModelData {
        path: pmd_path,
        looks: pmd.looks,
        variants: pmd.variants,
        bbox_min: pmg.bbox_min,
        bbox_max: pmg.bbox_max,
        materials,
        parts,
    })
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    pub fn tok(s: &str) -> u64 {
        encode_token(s).unwrap()
    }

    /// Builds a minimal PMD v4 with one look/variant and the given materials.
    pub fn build_pmd(materials: &[&str]) -> Vec<u8> {
        let mut b = vec![0u8; 64];
        let w = |b: &mut Vec<u8>, o: usize, v: u32| b[o..o + 4].copy_from_slice(&v.to_le_bytes());
        w(&mut b, 0, 4);
        w(&mut b, 4, materials.len() as u32);
        w(&mut b, 8, 1);
        w(&mut b, 16, 1);
        let look_offset = b.len();
        b.extend_from_slice(&tok("default").to_le_bytes());
        let variant_offset = b.len();
        b.extend_from_slice(&tok("default").to_le_bytes());
        let offs_offset = b.len();
        let paths_offset = offs_offset + materials.len() * 4;
        let mut cur = paths_offset;
        for m in materials {
            b.extend_from_slice(&(cur as u32).to_le_bytes());
            cur += m.len() + 1;
        }
        for m in materials {
            b.extend_from_slice(m.as_bytes());
            b.push(0);
        }
        w(&mut b, 36, look_offset as u32);
        w(&mut b, 40, variant_offset as u32);
        w(&mut b, 56, offs_offset as u32);
        w(&mut b, 60, paths_offset as u32);
        b
    }

    /// Builds a PMG 0x15 with one part, one piece (a single triangle, 2 UV channels).
    pub fn build_pmg() -> Vec<u8> {
        let mut b = vec![0u8; PMG_HEADER_SIZE];
        b[0] = PMG_VERSION;
        b[1..4].copy_from_slice(b"gmP");
        let w = |b: &mut Vec<u8>, o: usize, v: u32| b[o..o + 4].copy_from_slice(&v.to_le_bytes());
        let wf = |b: &mut Vec<u8>, o: usize, v: f32| b[o..o + 4].copy_from_slice(&v.to_le_bytes());
        w(&mut b, 4, 1); // pieces
        w(&mut b, 8, 1); // parts
        for (i, v) in [0.0f32, 0.0, 0.0, 1.0, 1.0, 0.0].iter().enumerate() {
            wf(&mut b, 48 + i * 4, *v);
        }
        let parts_offset = b.len();
        b.extend_from_slice(&tok("body").to_le_bytes());
        b.extend_from_slice(&1u32.to_le_bytes()); // pieces count
        b.extend_from_slice(&0u32.to_le_bytes()); // pieces index
        b.extend_from_slice(&0u32.to_le_bytes());
        b.extend_from_slice(&0u32.to_le_bytes());
        let pieces_offset = b.len();
        b.extend_from_slice(&[0u8; PMG_PIECE_SIZE]);
        let vert_offset = b.len();
        // stride = pos 12 + normal 12 + color 4 + 2*uv 16 = 44
        let verts: [[f32; 3]; 3] = [[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0]];
        for (i, p) in verts.iter().enumerate() {
            for c in p {
                b.extend_from_slice(&c.to_le_bytes());
            }
            for c in [0.0f32, 0.0, 1.0] {
                b.extend_from_slice(&c.to_le_bytes());
            }
            b.extend_from_slice(&0xFFFF_FFFFu32.to_le_bytes());
            for c in [p[0], p[1], 0.5 + i as f32, 0.25] {
                b.extend_from_slice(&c.to_le_bytes());
            }
        }
        let idx_offset = b.len();
        for i in [0u16, 1, 2] {
            b.extend_from_slice(&i.to_le_bytes());
        }
        b.extend_from_slice(&0u16.to_le_bytes()); // padding
        w(&mut b, 76, parts_offset as u32);
        w(&mut b, 84, pieces_offset as u32);
        let p = pieces_offset;
        w(&mut b, p, 3); // edges
        w(&mut b, p + 4, 3); // verts
        w(&mut b, p + 8, 0xFFFF_FFF0);
        w(&mut b, p + 12, 2); // uv width
        w(&mut b, p + 16, 0); // material
        w(&mut b, p + 60, 36);
        w(&mut b, p + 64, vert_offset as u32);
        w(&mut b, p + 68, (vert_offset + 12) as u32);
        w(&mut b, p + 72, (vert_offset + 28) as u32);
        w(&mut b, p + 76, (vert_offset + 24) as u32);
        for k in [80usize, 84, 88, 92] {
            w(&mut b, p + k, u32::MAX);
        }
        w(&mut b, p + 96, idx_offset as u32);
        b
    }

    #[test]
    fn token_roundtrip() {
        for s in ["default", "body", "cab_a", "x1_2"] {
            assert_eq!(decode_token(encode_token(s).unwrap()), s);
        }
        assert!(encode_token("this_is_too_long").is_none());
    }

    #[test]
    fn parses_synthetic_model() {
        let pmd = parse_pmd(&build_pmd(&["/a/paint.mat", "glass.mat"])).unwrap();
        assert_eq!(pmd.looks, vec!["default"]);
        assert_eq!(pmd.materials[0], vec!["/a/paint.mat", "glass.mat"]);

        let pmg = parse_pmg(&build_pmg()).unwrap();
        assert_eq!(pmg.parts.len(), 1);
        assert_eq!(pmg.parts[0].name, "body");
        let piece = &pmg.parts[0].pieces[0];
        assert_eq!(piece.positions.len(), 9);
        assert_eq!(piece.positions[3], 1.0);
        assert_eq!(piece.normals[2], 1.0);
        assert_eq!(piece.uvs.len(), 2);
        assert_eq!(piece.uvs[1], vec![0.5, 0.25, 1.5, 0.25, 2.5, 0.25]);
        assert_eq!(piece.indices, vec![0, 1, 2]);
        assert_eq!(pmg.bbox_max, [1.0, 1.0, 0.0]);

        let mut bad = build_pmg();
        bad[0] = 0x13;
        assert!(parse_pmg(&bad).unwrap_err().to_string().contains("0x13"));
    }

    #[test]
    fn parses_materials() {
        let new = "effect : \"eut2.truckpaint.airbrush\" {\n\ttexture : \"texture_base\" {\n\t\tsource : \"cab.tobj\"\n\t}\n}";
        let m = parse_mat(new, "/vehicle/truck/x/paint.mat");
        assert!(m.paintable);
        assert_eq!(m.effect, "eut2.truckpaint.airbrush");
        assert_eq!(m.textures, vec!["/vehicle/truck/x/cab.tobj"]);
        let old = "material : \"eut2.dif.spec\" {\n\ttexture[0] : \"/model/glass.tobj\"\n}";
        let m = parse_mat(old, "/model/glass.mat");
        assert!(!m.paintable);
        assert_eq!(m.textures, vec!["/model/glass.tobj"]);
    }
}
