//! Paint job mod builder.
//!
//! Layout (follows the conventions of Paint Job Packer, which is known to work in-game):
//!
//! ```text
//! manifest.sii, description.txt, mod_manager.jpg
//! material/ui/accessory/<mod>_icon.{mat,tobj,dds}
//! def/vehicle/<type>/<vehicle>/paint_job/<mod>_settings.sui
//! def/vehicle/<type>/<vehicle>/paint_job/<pj_unit>.sii            (one per texture)
//! vehicle/<type>/upgrade/paintjob/<mod>/<vehicle>/<texture>.{tobj,dds}
//! ```

use std::io::{Cursor, Write};
use std::path::{Path, PathBuf};

use base64::Engine;
use image::{imageops::FilterType, DynamicImage, RgbaImage};
use serde::{Deserialize, Serialize};

use crate::texture::{write_dds, write_tobj, DdsFormat};
use crate::{Error, Result};

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportTexture {
    pub name: String,
    pub png_base64: String,
    #[serde(default)]
    pub cabin_units: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportRequest {
    pub mod_id: String,
    pub display_name: String,
    pub author: String,
    pub version: String,
    #[serde(default)]
    pub description: String,
    pub price: u32,
    pub unlock_level: u32,
    pub vehicle_type: String,
    pub vehicle_id: String,
    pub textures: Vec<ExportTexture>,
    #[serde(default)]
    pub alternate_uvset: bool,
    pub base_color: [f32; 3],
    #[serde(default)]
    pub base_color_locked: bool,
    pub format: String,
    #[serde(default = "default_true")]
    pub mipmaps: bool,
    #[serde(default)]
    pub icon_png_base64: Option<String>,
    #[serde(default)]
    pub mod_manager_png_base64: Option<String>,
    pub packaging: String,
    pub output_dir: String,
    #[serde(default)]
    pub overwrite: bool,
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportResult {
    pub output_path: String,
    pub files: Vec<String>,
    pub warnings: Vec<String>,
}

/// `[a-z0-9_]{1,max}`
pub fn is_token(s: &str, max: usize) -> bool {
    !s.is_empty()
        && s.len() <= max
        && s.bytes().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'_')
}

fn sii_escape(s: &str) -> String {
    s.replace('\\', "\\\\").replace('"', "\\\"").replace(['\r', '\n'], " ")
}

fn decode_png(b64: &str) -> Result<RgbaImage> {
    let b64 = b64.split_once("base64,").map(|(_, d)| d).unwrap_or(b64);
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(b64.trim())
        .map_err(|e| Error::Invalid(format!("base64: {e}")))?;
    Ok(image::load_from_memory(&bytes)?.to_rgba8())
}

fn placeholder(w: u32, h: u32) -> RgbaImage {
    RgbaImage::from_fn(w, h, |x, y| {
        let t = (x as f32 / w as f32 + y as f32 / h as f32) * 0.5;
        let v = (30.0 + 40.0 * t) as u8;
        image::Rgba([v, v, (v as f32 * 1.3) as u8, 255])
    })
}

fn fit(img: RgbaImage, w: u32, h: u32) -> RgbaImage {
    DynamicImage::ImageRgba8(img)
        .resize_to_fill(w, h, FilterType::Lanczos3)
        .to_rgba8()
}

/// Builds every file of the mod in memory: (relative path, contents).
/// In-memory mod contents: (relative path, bytes), plus warnings.
pub type BuiltMod = (Vec<(String, Vec<u8>)>, Vec<String>);

pub fn build_files(req: &ExportRequest) -> Result<BuiltMod> {
    let mut warnings = Vec::new();
    if !is_token(&req.mod_id, 12) {
        return Err(Error::Invalid(
            "mod id must be 1–12 characters of a–z, 0–9 or _".into(),
        ));
    }
    if req.vehicle_type != "truck" && req.vehicle_type != "trailer_owned" {
        return Err(Error::Invalid(format!("unknown vehicle type {}", req.vehicle_type)));
    }
    if req.vehicle_id.is_empty()
        || !req
            .vehicle_id
            .split('.')
            .all(|p| is_token(p, 12))
    {
        return Err(Error::Invalid(format!("invalid vehicle id {}", req.vehicle_id)));
    }
    if req.textures.is_empty() {
        return Err(Error::Invalid("no textures to export".into()));
    }
    let format = DdsFormat::from_name(&req.format)?;

    let mod_id = &req.mod_id;
    let vtype = &req.vehicle_type;
    let vid = &req.vehicle_id;
    let mut files: Vec<(String, Vec<u8>)> = Vec::new();

    // --- manifest / description / mod manager image
    let manifest = format!(
        "SiiNunit\n{{\nmod_package : .package_name\n{{\n\tpackage_version: \"{}\"\n\tdisplay_name: \"{}\"\n\tauthor: \"{}\"\n\tcategory[]: \"paint_job\"\n\ticon: \"mod_manager.jpg\"\n\tdescription_file: \"description.txt\"\n}}\n}}\n",
        sii_escape(&req.version),
        sii_escape(&req.display_name),
        sii_escape(&req.author)
    );
    files.push(("manifest.sii".into(), manifest.into_bytes()));
    let description = if req.description.trim().is_empty() {
        format!("{} – paint job for {}.\nMade with ETS2 Livery Studio.", req.display_name, vid)
    } else {
        req.description.clone()
    };
    files.push(("description.txt".into(), description.into_bytes()));

    let mm = match &req.mod_manager_png_base64 {
        Some(b) if !b.is_empty() => fit(decode_png(b)?, 276, 162),
        _ => placeholder(276, 162),
    };
    let mut jpg = Vec::new();
    {
        let rgb = DynamicImage::ImageRgba8(mm).to_rgb8();
        let mut enc = image::codecs::jpeg::JpegEncoder::new_with_quality(Cursor::new(&mut jpg), 92);
        enc.encode_image(&rgb)?;
    }
    files.push(("mod_manager.jpg".into(), jpg));

    // --- shop icon
    let icon_name = format!("{mod_id}_icon");
    let icon = match &req.icon_png_base64 {
        Some(b) if !b.is_empty() => fit(decode_png(b)?, 256, 64),
        _ => placeholder(256, 64),
    };
    let acc_dir = "material/ui/accessory";
    files.push((
        format!("{acc_dir}/{icon_name}.mat"),
        format!(
            "effect : \"ui.rfx\" {{\n\ttexture : \"texture\" {{\n\t\tsource : \"{icon_name}.tobj\"\n\t}}\n}}\n"
        )
        .into_bytes(),
    ));
    files.push((
        format!("{acc_dir}/{icon_name}.tobj"),
        write_tobj(&format!("/{acc_dir}/{icon_name}.dds")),
    ));
    files.push((
        format!("{acc_dir}/{icon_name}.dds"),
        write_dds(icon.as_raw(), 256, 64, DdsFormat::Bgra8, false)?,
    ));

    // --- settings
    let def_dir = format!("def/vehicle/{vtype}/{vid}/paint_job");
    let c = req.base_color.map(|v| v.clamp(0.0, 1.0));
    let mut settings = format!(
        "\tname: \"{}\"\n\tprice: {}\n\tunlock: {}\n\tairbrush: true\n\ticon: \"{icon_name}\"\n\tbase_color: ({:.4}, {:.4}, {:.4})\n\tbase_color_locked: {}\n",
        sii_escape(&req.display_name),
        req.price,
        req.unlock_level,
        c[0],
        c[1],
        c[2],
        req.base_color_locked
    );
    if req.alternate_uvset {
        settings.push_str("\talternate_uvset: true\n");
    }
    files.push((format!("{def_dir}/{mod_id}_settings.sui"), settings.into_bytes()));

    // --- textures + paint job definitions
    let tex_dir = format!("vehicle/{vtype}/upgrade/paintjob/{mod_id}/{vid}");
    let mut used_units: Vec<String> = Vec::new();
    let mut used_names: Vec<String> = Vec::new();
    for tex in &req.textures {
        if !is_token(&tex.name, 64) {
            return Err(Error::Invalid(format!(
                "texture name \"{}\" may only contain a–z, 0–9 and _",
                tex.name
            )));
        }
        if used_names.contains(&tex.name) {
            return Err(Error::Invalid(format!("duplicate texture name {}", tex.name)));
        }
        used_names.push(tex.name.clone());

        let img = decode_png(&tex.png_base64)?;
        let (w, h) = img.dimensions();
        if !w.is_power_of_two() || !h.is_power_of_two() {
            return Err(Error::Invalid(format!(
                "texture {} is {w}x{h}; width and height must be powers of two",
                tex.name
            )));
        }
        if w > 8192 || h > 8192 {
            return Err(Error::Invalid(format!("texture {} is larger than 8192 px", tex.name)));
        }
        if w > 4096 || h > 4096 {
            warnings.push(format!(
                "{}: {w}x{h} is larger than the usual 4096 px maximum and may use a lot of VRAM",
                tex.name
            ));
        }
        for cab in &tex.cabin_units {
            if cab.contains('"') || cab.trim().is_empty() {
                return Err(Error::Invalid(format!("invalid cabin unit name {cab:?}")));
            }
        }

        let dds_vpath = format!("/{tex_dir}/{}.dds", tex.name);
        files.push((format!("{tex_dir}/{}.dds", tex.name), write_dds(img.as_raw(), w, h, format, req.mipmaps)?));
        files.push((format!("{tex_dir}/{}.tobj", tex.name), write_tobj(&dds_vpath)));

        let mut unit = if req.textures.len() == 1 {
            mod_id.clone()
        } else {
            let mut u = format!("{mod_id}_{}", tex.name);
            u.truncate(12);
            u
        };
        let mut n = 1;
        while used_units.contains(&unit) {
            let suffix = n.to_string();
            unit.truncate(12 - suffix.len());
            unit.push_str(&suffix);
            n += 1;
        }
        used_units.push(unit.clone());

        let mut sii = format!(
            "SiiNunit\n{{\naccessory_paint_job_data : {unit}.{vid}.paint_job\n{{\n@include \"{mod_id}_settings.sui\"\n"
        );
        for cab in &tex.cabin_units {
            sii.push_str(&format!("\tsuitable_for[]: \"{}\"\n", cab.trim()));
        }
        sii.push_str(&format!("\tpaint_job_mask: \"/{tex_dir}/{}.tobj\"\n}}\n}}\n", tex.name));
        files.push((format!("{def_dir}/{unit}.sii"), sii.into_bytes()));
    }
    if req.textures.len() > 1 && req.textures.iter().any(|t| t.cabin_units.is_empty()) {
        warnings.push(
            "several textures were exported but at least one has no cabin assigned; it will show up for every cabin".into(),
        );
    }
    Ok((files, warnings))
}

/// Builds the mod and writes it as a folder or `.scs` (zip) into `req.output_dir`.
pub fn export_mod(req: &ExportRequest) -> Result<ExportResult> {
    let (files, warnings) = build_files(req)?;
    let out_dir = PathBuf::from(&req.output_dir);
    std::fs::create_dir_all(&out_dir)?;

    let output_path = match req.packaging.as_str() {
        "folder" => {
            let target = out_dir.join(&req.mod_id);
            if target.exists() {
                if !req.overwrite {
                    return Err(Error::Invalid(format!("{} already exists", target.display())));
                }
                std::fs::remove_dir_all(&target)?;
            }
            for (rel, data) in &files {
                let p = join_rel(&target, rel);
                if let Some(parent) = p.parent() {
                    std::fs::create_dir_all(parent)?;
                }
                std::fs::write(p, data)?;
            }
            target
        }
        "scs" => {
            let target = out_dir.join(format!("{}.scs", req.mod_id));
            if target.exists() && !req.overwrite {
                return Err(Error::Invalid(format!("{} already exists", target.display())));
            }
            let tmp = out_dir.join(format!(".{}.scs.tmp", req.mod_id));
            {
                let f = std::fs::File::create(&tmp)?;
                let mut z = zip::ZipWriter::new(f);
                let opts = zip::write::SimpleFileOptions::default()
                    .compression_method(zip::CompressionMethod::Deflated);
                for (rel, data) in &files {
                    z.start_file(rel.as_str(), opts)?;
                    z.write_all(data)?;
                }
                z.finish()?;
            }
            if target.exists() {
                std::fs::remove_file(&target)?;
            }
            std::fs::rename(&tmp, &target)?;
            target
        }
        other => return Err(Error::Invalid(format!("unknown packaging {other}"))),
    };

    Ok(ExportResult {
        output_path: output_path.to_string_lossy().to_string(),
        files: files.into_iter().map(|(p, _)| p).collect(),
        warnings,
    })
}

fn join_rel(base: &Path, rel: &str) -> PathBuf {
    let mut p = base.to_path_buf();
    for part in rel.split('/') {
        p.push(part);
    }
    p
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hashfs::{open_archive, Vfs};

    fn png_b64(w: u32, h: u32) -> String {
        let img = RgbaImage::from_pixel(w, h, image::Rgba([200, 30, 30, 255]));
        let mut buf = Vec::new();
        DynamicImage::ImageRgba8(img)
            .write_to(&mut Cursor::new(&mut buf), image::ImageFormat::Png)
            .unwrap();
        base64::engine::general_purpose::STANDARD.encode(buf)
    }

    fn request(dir: &Path, packaging: &str, textures: Vec<ExportTexture>) -> ExportRequest {
        ExportRequest {
            mod_id: "red_line".into(),
            display_name: "Red \"Line\"".into(),
            author: "Tester".into(),
            version: "1.0".into(),
            description: String::new(),
            price: 5000,
            unlock_level: 0,
            vehicle_type: "truck".into(),
            vehicle_id: "scania.r_2016".into(),
            textures,
            alternate_uvset: false,
            base_color: [1.0, 1.0, 1.0],
            base_color_locked: true,
            format: "bc3".into(),
            mipmaps: true,
            icon_png_base64: None,
            mod_manager_png_base64: Some(png_b64(64, 64)),
            packaging: packaging.into(),
            output_dir: dir.to_string_lossy().to_string(),
            overwrite: false,
        }
    }

    #[test]
    fn exports_folder_single_texture() {
        let dir = tempfile::tempdir().unwrap();
        let req = request(
            dir.path(),
            "folder",
            vec![ExportTexture { name: "cab_a".into(), png_base64: png_b64(64, 32), cabin_units: vec![] }],
        );
        let res = export_mod(&req).unwrap();
        let root = PathBuf::from(&res.output_path);
        let def = std::fs::read_to_string(root.join("def/vehicle/truck/scania.r_2016/paint_job/red_line.sii")).unwrap();
        assert!(def.contains("accessory_paint_job_data : red_line.scania.r_2016.paint_job"));
        assert!(def.contains("paint_job_mask: \"/vehicle/truck/upgrade/paintjob/red_line/scania.r_2016/cab_a.tobj\""));
        assert!(!def.contains("suitable_for"));
        let settings = std::fs::read_to_string(root.join("def/vehicle/truck/scania.r_2016/paint_job/red_line_settings.sui")).unwrap();
        assert!(settings.contains("name: \"Red \\\"Line\\\"\""));
        assert!(settings.contains("airbrush: true"));
        let dds = std::fs::read(root.join("vehicle/truck/upgrade/paintjob/red_line/scania.r_2016/cab_a.dds")).unwrap();
        assert_eq!(&dds[84..88], b"DXT5");
        let tobj = std::fs::read(root.join("vehicle/truck/upgrade/paintjob/red_line/scania.r_2016/cab_a.tobj")).unwrap();
        assert!(tobj.ends_with(b"/vehicle/truck/upgrade/paintjob/red_line/scania.r_2016/cab_a.dds"));
        assert!(root.join("manifest.sii").is_file());
        assert!(root.join("mod_manager.jpg").is_file());
        assert!(root.join("material/ui/accessory/red_line_icon.mat").is_file());

        // the generated mod parses with our own reader
        let mut vfs = Vfs::new();
        vfs.mount(open_archive(&root).unwrap());
        let units = crate::game::read_sii(&vfs, "/def/vehicle/truck/scania.r_2016/paint_job/red_line.sii").unwrap();
        assert_eq!(units[0].get("name"), Some("Red \"Line\""));

        // refuses to overwrite
        assert!(export_mod(&req).is_err());
        let mut again = req.clone();
        again.overwrite = true;
        assert!(export_mod(&again).is_ok());
    }

    #[test]
    fn exports_scs_multi_texture() {
        let dir = tempfile::tempdir().unwrap();
        let mut req = request(
            dir.path(),
            "scs",
            vec![
                ExportTexture { name: "cab_a".into(), png_base64: png_b64(32, 32), cabin_units: vec!["cab_a.scania.r_2016.cabin".into()] },
                ExportTexture { name: "cab_b".into(), png_base64: png_b64(32, 32), cabin_units: vec!["cab_b.scania.r_2016.cabin".into()] },
            ],
        );
        req.format = "rgba8".into();
        let res = export_mod(&req).unwrap();
        assert!(res.output_path.ends_with("red_line.scs"));
        let a = open_archive(Path::new(&res.output_path)).unwrap();
        assert_eq!(a.kind(), "zip");
        let def = String::from_utf8(a.read("/def/vehicle/truck/scania.r_2016/paint_job/red_line_cab.sii").unwrap()).unwrap();
        assert!(def.contains("suitable_for[]: \"cab_a.scania.r_2016.cabin\""));
        // second texture gets a unique, ≤12 char unit name
        let listing = a.list_dir("/def/vehicle/truck/scania.r_2016/paint_job").unwrap().unwrap();
        assert!(listing.files.contains(&"red_line_ca1.sii".to_string()), "{:?}", listing.files);
        for f in &listing.files {
            if f.ends_with(".sii") {
                assert!(f.trim_end_matches(".sii").len() <= 12);
            }
        }
    }

    #[test]
    fn validates_input() {
        let dir = tempfile::tempdir().unwrap();
        let mut req = request(
            dir.path(),
            "folder",
            vec![ExportTexture { name: "cab".into(), png_base64: png_b64(30, 32), cabin_units: vec![] }],
        );
        assert!(export_mod(&req).unwrap_err().to_string().contains("powers of two"));
        req.mod_id = "Bad-Id".into();
        assert!(export_mod(&req).is_err());
    }
}
