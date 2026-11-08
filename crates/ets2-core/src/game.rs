//! Game installation detection and vehicle indexing.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::hashfs::{game_archive_order, join, normalize, open_archive, parent, EntryKind, Vfs};
use crate::sii::{self, Unit};
use crate::{Error, Result};

pub const ETS2_DIR_NAME: &str = "Euro Truck Simulator 2";
pub const ATS_DIR_NAME: &str = "American Truck Simulator";

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Installation {
    pub game_dir: String,
    pub mod_dir: Option<String>,
    pub source: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveInfo {
    pub name: String,
    pub kind: String,
    pub entry_count: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CabinInfo {
    pub unit_name: String,
    pub name: String,
    pub def_path: String,
    pub models: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PaintJobInfo {
    pub unit_name: String,
    pub def_path: String,
    pub name: String,
    pub mask_path: Option<String>,
    pub airbrush: bool,
    pub alternate_uvset: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VehicleInfo {
    pub id: String,
    pub vehicle_type: String,
    pub name: String,
    pub cabins: Vec<CabinInfo>,
    pub other_models: Vec<String>,
    pub paint_jobs: Vec<PaintJobInfo>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GameIndex {
    pub game_dir: String,
    pub archives: Vec<ArchiveInfo>,
    pub vehicles: Vec<VehicleInfo>,
    pub warnings: Vec<String>,
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

fn game_name_for(dir: &Path) -> &'static str {
    let s = dir.to_string_lossy().to_ascii_lowercase();
    if s.contains("american truck") {
        ATS_DIR_NAME
    } else {
        ETS2_DIR_NAME
    }
}

/// `Documents/<game>/mod` (Windows) or the equivalent data folder on other OSes.
pub fn mod_dir_for(game_name: &str) -> Option<PathBuf> {
    #[cfg(windows)]
    let base = dirs::document_dir();
    #[cfg(not(windows))]
    let base = dirs::data_local_dir();
    base.map(|d| d.join(game_name).join("mod"))
}

pub fn default_mod_dir() -> Option<String> {
    mod_dir_for(ETS2_DIR_NAME).map(|p| p.to_string_lossy().to_string())
}

/// A folder looks like a game root when it contains the base archives.
pub fn is_game_dir(dir: &Path) -> bool {
    dir.join("base.scs").is_file() || dir.join("def.scs").is_file()
}

/// Extracts library paths from Steam's `libraryfolders.vdf`.
pub fn parse_library_folders(vdf: &str) -> Vec<PathBuf> {
    let mut out = Vec::new();
    for line in vdf.lines() {
        let parts: Vec<&str> = line.split('"').collect();
        // "path"		"D:\\SteamLibrary"  -> ["", "path", "\t\t", "D:\\\\SteamLibrary", ""]
        if parts.len() >= 4 && parts[1].eq_ignore_ascii_case("path") {
            out.push(PathBuf::from(parts[3].replace("\\\\", "\\")));
        }
    }
    out
}

fn steam_roots() -> Vec<(PathBuf, &'static str)> {
    let mut roots: Vec<(PathBuf, &'static str)> = Vec::new();
    #[cfg(windows)]
    {
        use winreg::enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE};
        use winreg::RegKey;
        if let Ok(k) = RegKey::predef(HKEY_CURRENT_USER).open_subkey("Software\\Valve\\Steam") {
            if let Ok(p) = k.get_value::<String, _>("SteamPath") {
                roots.push((PathBuf::from(p.replace('/', "\\")), "registry"));
            }
        }
        for key in ["SOFTWARE\\WOW6432Node\\Valve\\Steam", "SOFTWARE\\Valve\\Steam"] {
            if let Ok(k) = RegKey::predef(HKEY_LOCAL_MACHINE).open_subkey(key) {
                if let Ok(p) = k.get_value::<String, _>("InstallPath") {
                    roots.push((PathBuf::from(p), "registry"));
                }
            }
        }
        roots.push((PathBuf::from("C:\\Program Files (x86)\\Steam"), "default-path"));
        roots.push((PathBuf::from("C:\\Program Files\\Steam"), "default-path"));
    }
    #[cfg(not(windows))]
    {
        if let Some(home) = dirs::home_dir() {
            roots.push((home.join(".steam/steam"), "default-path"));
            roots.push((home.join(".local/share/Steam"), "default-path"));
            roots.push((home.join("Library/Application Support/Steam"), "default-path"));
        }
    }
    roots
}

/// Finds ETS2 (and ATS) installations via Steam libraries and default paths.
pub fn detect_installations() -> Vec<Installation> {
    let mut candidates: Vec<(PathBuf, String)> = Vec::new();
    for (root, src) in steam_roots() {
        candidates.push((root.join("steamapps").join("common").join(ETS2_DIR_NAME), src.to_string()));
        candidates.push((root.join("steamapps").join("common").join(ATS_DIR_NAME), src.to_string()));
        let vdf = root.join("steamapps").join("libraryfolders.vdf");
        if let Ok(text) = std::fs::read_to_string(&vdf) {
            for lib in parse_library_folders(&text) {
                for g in [ETS2_DIR_NAME, ATS_DIR_NAME] {
                    candidates.push((lib.join("steamapps").join("common").join(g), "steam-library".into()));
                }
            }
        }
    }
    #[cfg(windows)]
    {
        for drive in ["C", "D", "E", "F"] {
            for g in [ETS2_DIR_NAME, ATS_DIR_NAME] {
                candidates.push((PathBuf::from(format!("{drive}:\\SteamLibrary\\steamapps\\common\\{g}")), "default-path".into()));
                candidates.push((PathBuf::from(format!("{drive}:\\Games\\{g}")), "default-path".into()));
            }
        }
    }

    let mut seen = BTreeSet::new();
    let mut out = Vec::new();
    for (dir, source) in candidates {
        if !is_game_dir(&dir) {
            continue;
        }
        let canon = std::fs::canonicalize(&dir).unwrap_or(dir.clone());
        let key = canon.to_string_lossy().to_ascii_lowercase();
        if !seen.insert(key) {
            continue;
        }
        let mod_dir = mod_dir_for(game_name_for(&dir)).map(|p| p.to_string_lossy().to_string());
        out.push(Installation {
            game_dir: dir.to_string_lossy().to_string(),
            mod_dir,
            source,
        });
    }
    // ETS2 first
    out.sort_by_key(|i| i.game_dir.to_ascii_lowercase().contains("american"));
    out
}

// ---------------------------------------------------------------------------
// Session (mounted game + extra mods)
// ---------------------------------------------------------------------------

pub struct GameSession {
    pub game_dir: String,
    pub vfs: Vfs,
    pub mount_warnings: Vec<String>,
}

impl GameSession {
    /// Mounts every `.scs` in the game root in game order.
    pub fn open(game_dir: &str) -> Result<Self> {
        let dir = PathBuf::from(game_dir);
        if !dir.is_dir() {
            return Err(Error::NotFound(game_dir.to_string()));
        }
        let mut names: Vec<String> = std::fs::read_dir(&dir)?
            .filter_map(|e| e.ok())
            .filter(|e| e.path().is_file())
            .map(|e| e.file_name().to_string_lossy().to_string())
            .filter(|n| n.to_ascii_lowercase().ends_with(".scs"))
            .collect();
        if names.is_empty() {
            return Err(Error::Invalid(format!(
                "no .scs archives found in {game_dir} — is this the game folder?"
            )));
        }
        names.sort_by_key(|n| game_archive_order(n));
        let mut vfs = Vfs::new();
        let mut warnings = Vec::new();
        for n in names {
            match open_archive(&dir.join(&n)) {
                Ok(a) => vfs.mount(a),
                Err(e) => warnings.push(format!("{n}: {e}")),
            }
        }
        Ok(GameSession {
            game_dir: game_dir.to_string(),
            vfs,
            mount_warnings: warnings,
        })
    }

    /// Mounts an extra archive/folder (e.g. a truck mod) on top.
    pub fn mount_extra(&mut self, path: &str) -> Result<()> {
        let a = open_archive(Path::new(path))?;
        self.vfs.mount(a);
        Ok(())
    }

    pub fn index(&self) -> GameIndex {
        let mut warnings = self.mount_warnings.clone();
        let vehicles = index_vehicles(&self.vfs, &mut warnings);
        GameIndex {
            game_dir: self.game_dir.clone(),
            archives: self
                .vfs
                .archives()
                .iter()
                .map(|a| ArchiveInfo {
                    name: a.name().to_string(),
                    kind: a.kind().to_string(),
                    entry_count: a.entry_count(),
                })
                .collect(),
            vehicles,
            warnings,
        }
    }
}

/// Reads and parses a SII file, resolving `@include` relative to it.
pub fn read_sii(vfs: &Vfs, path: &str) -> Result<Vec<Unit>> {
    let data = vfs.read(path)?;
    let text = sii::decode(&data)?;
    let dir = parent(path);
    Ok(sii::parse_with_includes(&text, |inc| {
        let p = join(&dir, inc);
        vfs.read(&p).ok().and_then(|d| sii::decode(&d).ok())
    }))
}

fn pmd_values(units: &[Unit]) -> Vec<String> {
    let mut out = Vec::new();
    for u in units {
        for v in u.values() {
            if v.to_ascii_lowercase().ends_with(".pmd") {
                let p = normalize(v);
                if !out.contains(&p) {
                    out.push(p);
                }
            }
        }
    }
    out
}

fn sii_files(vfs: &Vfs, dir: &str) -> Vec<String> {
    vfs.list_dir(dir)
        .map(|l| {
            l.files
                .into_iter()
                .filter(|f| f.to_ascii_lowercase().ends_with(".sii"))
                .map(|f| join(dir, &f))
                .collect()
        })
        .unwrap_or_default()
}

const SKIP_DIRS: &[&str] = &["paint_job", "cabin", "sound", "interior", "accessory", "addon_hookups"];
const MAX_OTHER_MODELS: usize = 200;
const MAX_OTHER_FILES: usize = 400;

/// Indexes `/def/vehicle/truck/*` and `/def/vehicle/trailer_owned/*`.
pub fn index_vehicles(vfs: &Vfs, warnings: &mut Vec<String>) -> Vec<VehicleInfo> {
    let mut vehicles = Vec::new();
    for vtype in ["truck", "trailer_owned"] {
        let root = format!("/def/vehicle/{vtype}");
        let ids = vfs.list_dir(&root).map(|l| l.dirs).unwrap_or_default();
        for id in ids {
            let vdir = join(&root, &id);
            let mut v = VehicleInfo {
                id: id.clone(),
                vehicle_type: vtype.to_string(),
                name: id.clone(),
                cabins: Vec::new(),
                other_models: Vec::new(),
                paint_jobs: Vec::new(),
            };

            let data_path = join(&vdir, "data.sii");
            if vfs.exists(&data_path) == Some(EntryKind::File) {
                match read_sii(vfs, &data_path) {
                    Ok(units) => {
                        if let Some(n) = units.iter().find_map(|u| u.get("name")) {
                            if !n.is_empty() && !n.starts_with('@') {
                                v.name = n.to_string();
                            }
                        }
                    }
                    Err(e) => warnings.push(format!("{data_path}: {e}")),
                }
            }

            for f in sii_files(vfs, &join(&vdir, "cabin")) {
                match read_sii(vfs, &f) {
                    Ok(units) => {
                        for u in units.iter().filter(|u| u.class.contains("cabin")) {
                            v.cabins.push(CabinInfo {
                                unit_name: u.name.clone(),
                                name: u.get("name").unwrap_or_default().to_string(),
                                def_path: f.clone(),
                                models: pmd_values(std::slice::from_ref(u)),
                            });
                        }
                    }
                    Err(e) => warnings.push(format!("{f}: {e}")),
                }
            }

            for f in sii_files(vfs, &join(&vdir, "paint_job")) {
                match read_sii(vfs, &f) {
                    Ok(units) => {
                        for u in units.iter().filter(|u| u.class == "accessory_paint_job_data") {
                            v.paint_jobs.push(PaintJobInfo {
                                unit_name: u.name.clone(),
                                def_path: f.clone(),
                                name: u.get("name").unwrap_or_default().to_string(),
                                mask_path: u.get("paint_job_mask").filter(|s| !s.is_empty()).map(String::from),
                                airbrush: u.get_bool("airbrush").unwrap_or(false),
                                alternate_uvset: u.get_bool("alternate_uvset").unwrap_or(false),
                            });
                        }
                    }
                    Err(e) => warnings.push(format!("{f}: {e}")),
                }
            }

            // Other models (chassis, trailer bodies, ...)
            let mut files = Vec::new();
            let mut stack = vec![vdir.clone()];
            while let Some(d) = stack.pop() {
                if files.len() >= MAX_OTHER_FILES {
                    break;
                }
                if let Ok(l) = vfs.list_dir(&d) {
                    for f in l.files {
                        if f.to_ascii_lowercase().ends_with(".sii") {
                            files.push(join(&d, &f));
                        }
                    }
                    for s in l.dirs {
                        if !SKIP_DIRS.contains(&s.as_str()) {
                            stack.push(join(&d, &s));
                        }
                    }
                }
            }
            let mut seen: BTreeSet<String> = v.cabins.iter().flat_map(|c| c.models.iter().cloned()).collect();
            for f in files.into_iter().take(MAX_OTHER_FILES) {
                if let Ok(units) = read_sii(vfs, &f) {
                    for m in pmd_values(&units) {
                        if v.other_models.len() < MAX_OTHER_MODELS && seen.insert(m.clone()) {
                            v.other_models.push(m);
                        }
                    }
                }
            }
            vehicles.push(v);
        }
    }
    vehicles.sort_by(|a, b| a.vehicle_type.cmp(&b.vehicle_type).then(a.name.to_lowercase().cmp(&b.name.to_lowercase())));
    vehicles
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hashfs::tests::write_v1;

    #[test]
    fn library_folders() {
        let vdf = "\"libraryfolders\"\n{\n\t\"0\"\n\t{\n\t\t\"path\"\t\t\"C:\\\\Program Files (x86)\\\\Steam\"\n\t}\n\t\"1\"\n\t{\n\t\t\"path\"\t\t\"D:\\\\SteamLibrary\"\n\t}\n}";
        let libs = parse_library_folders(vdf);
        assert_eq!(libs, vec![PathBuf::from("C:\\Program Files (x86)\\Steam"), PathBuf::from("D:\\SteamLibrary")]);
    }

    #[test]
    fn indexes_fake_game() {
        let dir = tempfile::tempdir().unwrap();
        let cabin = br#"SiiNunit {
accessory_cabin_data : cab_a.test.truck_x.cabin {
	name: "Normal cab"
	model: "/vehicle/truck/test_x/cab_a.pmd"
}
}"#;
        let data = b"SiiNunit { accessory_truck_data : test.truck_x.data { name: \"Truck X\" } }";
        let pj = b"SiiNunit {\naccessory_paint_job_data : def.test.truck_x.paint_job\n{\n@include \"def_settings.sui\"\n\tpaint_job_mask: \"/vehicle/truck/upgrade/paintjob/a/cab.tobj\"\n}\n}";
        let sui = b"\tname: \"Default\"\n\tairbrush: true\n";
        let chassis = b"SiiNunit { accessory_chassis_data : c.test.truck_x.chassis { model: \"/vehicle/truck/test_x/chassis.pmd\" } }";
        write_v1(
            &dir.path().join("def.scs"),
            &[
                ("/def/vehicle/truck/test.truck_x/cabin/cab_a.sii", cabin),
                ("/def/vehicle/truck/test.truck_x/data.sii", data),
                ("/def/vehicle/truck/test.truck_x/paint_job/def.sii", pj),
                ("/def/vehicle/truck/test.truck_x/paint_job/def_settings.sui", sui),
                ("/def/vehicle/truck/test.truck_x/chassis/c.sii", chassis),
            ],
            true,
        );
        let s = GameSession::open(dir.path().to_str().unwrap()).unwrap();
        let idx = s.index();
        assert_eq!(idx.archives.len(), 1);
        assert_eq!(idx.vehicles.len(), 1, "{:?}", idx.warnings);
        let v = &idx.vehicles[0];
        assert_eq!(v.id, "test.truck_x");
        assert_eq!(v.name, "Truck X");
        assert_eq!(v.cabins[0].unit_name, "cab_a.test.truck_x.cabin");
        assert_eq!(v.cabins[0].models, vec!["/vehicle/truck/test_x/cab_a.pmd"]);
        assert_eq!(v.paint_jobs[0].name, "Default");
        assert!(v.paint_jobs[0].airbrush);
        assert_eq!(v.other_models, vec!["/vehicle/truck/test_x/chassis.pmd"]);
    }
}
