//! Archive readers (HashFS v1/v2, zip, plain folders) and a layered virtual file system.
//!
//! The HashFS layouts follow TruckLib.HashFs (sk-zk, MIT). Paths inside archives are
//! addressed as absolute virtual paths such as `/def/vehicle/truck`.

use std::collections::{BTreeSet, HashMap};
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use flate2::read::ZlibDecoder;
use serde::Serialize;

use crate::cityhash::hash_path;
use crate::{Error, Result};

const HASHFS_MAGIC: u32 = 0x2353_4353; // "SCS#"

#[derive(Debug, Clone, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DirListing {
    pub dirs: Vec<String>,
    pub files: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EntryKind {
    File,
    Dir,
}

/// Common interface for every archive type.
pub trait Archive: Send + Sync {
    /// "hashfs1" | "hashfs2" | "zip" | "folder"
    fn kind(&self) -> &'static str;
    /// Display name (file name of the archive)
    fn name(&self) -> &str;
    fn entry_count(&self) -> usize;
    fn exists(&self, path: &str) -> Option<EntryKind>;
    fn read(&self, path: &str) -> Result<Vec<u8>>;
    /// Names (not full paths) of the direct children, or `None` when `path` is not a directory here.
    fn list_dir(&self, path: &str) -> Result<Option<DirListing>>;
}

/// Normalises a virtual path to `/a/b` form (root = `/`).
pub fn normalize(path: &str) -> String {
    let p = path.replace('\\', "/");
    let parts: Vec<&str> = p.split('/').filter(|s| !s.is_empty() && *s != ".").collect();
    let mut out: Vec<&str> = Vec::new();
    for part in parts {
        if part == ".." {
            out.pop();
        } else {
            out.push(part);
        }
    }
    format!("/{}", out.join("/"))
}

/// Joins a child name onto a virtual directory path.
pub fn join(dir: &str, name: &str) -> String {
    if name.starts_with('/') {
        return normalize(name);
    }
    let d = normalize(dir);
    if d == "/" {
        normalize(&format!("/{name}"))
    } else {
        normalize(&format!("{d}/{name}"))
    }
}

/// Parent directory of a virtual path.
pub fn parent(path: &str) -> String {
    let p = normalize(path);
    match p.rfind('/') {
        Some(0) | None => "/".to_string(),
        Some(i) => p[..i].to_string(),
    }
}

fn zlib_decompress(data: &[u8], size_hint: usize) -> Result<Vec<u8>> {
    let mut out = Vec::with_capacity(size_hint);
    ZlibDecoder::new(data)
        .read_to_end(&mut out)
        .map_err(|e| Error::Invalid(format!("zlib: {e}")))?;
    Ok(out)
}

fn rd_u16(b: &[u8], o: usize) -> u16 {
    u16::from_le_bytes([b[o], b[o + 1]])
}
fn rd_u32(b: &[u8], o: usize) -> u32 {
    u32::from_le_bytes(b[o..o + 4].try_into().unwrap())
}
fn rd_u64(b: &[u8], o: usize) -> u64 {
    u64::from_le_bytes(b[o..o + 8].try_into().unwrap())
}

// ---------------------------------------------------------------------------
// HashFS
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
struct HashEntry {
    offset: u64,
    size: u32,
    compressed_size: u32,
    is_dir: bool,
    is_compressed: bool,
    /// v2 packed texture (tobj+dds), data is GDeflate compressed
    is_image: bool,
}

pub struct HashFsArchive {
    name: String,
    version: u16,
    salt: u16,
    file: Mutex<File>,
    entries: HashMap<u64, HashEntry>,
    /// v1 only: directory listings split across several entries with the same hash
    extra_dirs: HashMap<u64, Vec<HashEntry>>,
    /// v2 entries whose primary chunk type is unknown
    pub skipped_entries: usize,
}

impl HashFsArchive {
    pub fn open(path: &Path) -> Result<Self> {
        let mut file = File::open(path)?;
        let mut hdr = [0u8; 64];
        let n = read_up_to(&mut file, &mut hdr)?;
        if n < 24 {
            return Err(Error::Invalid("file too small for a HashFS header".into()));
        }
        let magic = rd_u32(&hdr, 0);
        if magic & 0xFFFF == 0x4B50 {
            return Err(Error::Unsupported("this is a zip file".into()));
        }
        if magic != HASHFS_MAGIC {
            return Err(Error::Invalid("not a HashFS archive (bad magic)".into()));
        }
        let version = rd_u16(&hdr, 4);
        let salt = rd_u16(&hdr, 6);
        let method = &hdr[8..12];
        if method != b"CITY" {
            return Err(Error::Unsupported(format!(
                "hash method {:?}",
                String::from_utf8_lossy(method)
            )));
        }
        let name = path
            .file_name()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_default();
        let mut archive = HashFsArchive {
            name,
            version,
            salt,
            file: Mutex::new(file),
            entries: HashMap::new(),
            extra_dirs: HashMap::new(),
            skipped_entries: 0,
        };
        match version {
            1 => {
                let num_entries = rd_u32(&hdr, 12) as usize;
                let start = rd_u64(&hdr, 16);
                archive.parse_v1(num_entries, start)?;
            }
            2 => {
                if n < 49 {
                    return Err(Error::Invalid("truncated HashFS v2 header".into()));
                }
                let num_entries = rd_u32(&hdr, 12) as usize;
                let entry_table_len = rd_u32(&hdr, 16) as usize;
                let _num_meta = rd_u32(&hdr, 20);
                let meta_table_len = rd_u32(&hdr, 24) as usize;
                let entry_table_start = rd_u64(&hdr, 28);
                let meta_table_start = rd_u64(&hdr, 36);
                archive.parse_v2(
                    num_entries,
                    entry_table_len,
                    meta_table_len,
                    entry_table_start,
                    meta_table_start,
                )?;
            }
            v => return Err(Error::Unsupported(format!("HashFS version {v}"))),
        }
        Ok(archive)
    }

    pub fn version(&self) -> u16 {
        self.version
    }

    fn read_at(&self, offset: u64, len: usize) -> Result<Vec<u8>> {
        let mut f = self.file.lock().map_err(|_| Error::Invalid("poisoned lock".into()))?;
        f.seek(SeekFrom::Start(offset))?;
        let mut buf = vec![0u8; len];
        f.read_exact(&mut buf)?;
        Ok(buf)
    }

    fn parse_v1(&mut self, num_entries: usize, start: u64) -> Result<()> {
        let table = self.read_at(start, num_entries * 32)?;
        for i in 0..num_entries {
            let o = i * 32;
            let hash = rd_u64(&table, o);
            let flags = rd_u32(&table, o + 16);
            let entry = HashEntry {
                offset: rd_u64(&table, o + 8),
                size: rd_u32(&table, o + 24),
                compressed_size: rd_u32(&table, o + 28),
                is_dir: flags & 1 != 0,
                is_compressed: flags & 2 != 0,
                is_image: false,
            };
            match self.entries.get(&hash) {
                None => {
                    self.entries.insert(hash, entry);
                }
                Some(existing) => {
                    if existing.is_dir && entry.is_dir {
                        self.extra_dirs.entry(hash).or_default().push(entry);
                    }
                }
            }
        }
        Ok(())
    }

    fn parse_v2(
        &mut self,
        num_entries: usize,
        entry_table_len: usize,
        meta_table_len: usize,
        entry_table_start: u64,
        meta_table_start: u64,
    ) -> Result<()> {
        let raw = self.read_at(entry_table_start, entry_table_len)?;
        let entry_table = zlib_decompress(&raw, num_entries * 16)?;
        let raw = self.read_at(meta_table_start, meta_table_len)?;
        let meta = zlib_decompress(&raw, meta_table_len * 4)?;

        let _ = num_entries;
        let count = entry_table.len() / 16;
        for i in 0..count {
            let o = i * 16;
            let hash = rd_u64(&entry_table, o);
            let meta_index = rd_u32(&entry_table, o + 8) as usize;
            let meta_count = rd_u16(&entry_table, o + 12) as usize;
            let mut pos = meta_index * 4;
            if meta_count == 0 || pos + meta_count * 4 > meta.len() {
                self.skipped_entries += 1;
                continue;
            }
            let first_type = meta[pos + 3];
            pos += meta_count * 4; // chunk headers (u24 index + u8 type)
            let (is_image, main_pos) = match first_type {
                128 | 129 => (false, pos),
                1 => (true, pos + 12), // PackedTobjDdsMetadata precedes the main metadata
                _ => {
                    self.skipped_entries += 1;
                    continue;
                }
            };
            if main_pos + 16 > meta.len() {
                self.skipped_entries += 1;
                continue;
            }
            let m = &meta[main_pos..main_pos + 16];
            let compressed_size = (m[0] as u32)
                | ((m[1] as u32) << 8)
                | ((m[2] as u32) << 16)
                | (((m[3] & 0x0F) as u32) << 24);
            let is_compressed = m[3] & 0x10 != 0;
            let size = (m[4] as u32)
                | ((m[5] as u32) << 8)
                | ((m[6] as u32) << 16)
                | (((m[7] & 0x0F) as u32) << 24);
            let offset_block = rd_u32(m, 12) as u64;
            self.entries.insert(
                hash,
                HashEntry {
                    offset: offset_block * 16,
                    size: if is_image { compressed_size } else { size },
                    compressed_size,
                    is_dir: first_type == 129,
                    is_compressed,
                    is_image,
                },
            );
        }
        Ok(())
    }

    fn entry_content(&self, e: &HashEntry) -> Result<Vec<u8>> {
        if e.is_image {
            return Err(Error::Unsupported(
                "packed HashFS v2 textures (GDeflate) cannot be read yet".into(),
            ));
        }
        if e.is_compressed {
            let raw = self.read_at(e.offset, e.compressed_size as usize)?;
            zlib_decompress(&raw, e.size as usize)
        } else {
            self.read_at(e.offset, e.size as usize)
        }
    }

    fn lookup(&self, path: &str) -> Option<&HashEntry> {
        let p = normalize(path);
        let key = if p == "/" { "" } else { &p[1..] };
        self.entries.get(&hash_path(key, self.salt))
    }

    fn parse_listing(&self, data: &[u8], out: &mut DirListing) {
        if self.version == 1 {
            let text = String::from_utf8_lossy(data);
            for line in text.split(['\r', '\n']).filter(|l| !l.is_empty()) {
                if let Some(d) = line.strip_prefix('*') {
                    out.dirs.push(d.to_string());
                } else {
                    out.files.push(line.to_string());
                }
            }
        } else {
            if data.len() < 4 {
                return;
            }
            let count = rd_u32(data, 0) as usize;
            if 4 + count > data.len() {
                return;
            }
            let lens = &data[4..4 + count];
            let mut pos = 4 + count;
            for &l in lens {
                let l = l as usize;
                if pos + l > data.len() {
                    break;
                }
                let s = String::from_utf8_lossy(&data[pos..pos + l]).to_string();
                pos += l;
                if let Some(d) = s.strip_prefix('/') {
                    out.dirs.push(d.to_string());
                } else {
                    out.files.push(s);
                }
            }
        }
    }
}

fn read_up_to(f: &mut File, buf: &mut [u8]) -> Result<usize> {
    let mut total = 0;
    while total < buf.len() {
        let n = f.read(&mut buf[total..])?;
        if n == 0 {
            break;
        }
        total += n;
    }
    Ok(total)
}

impl Archive for HashFsArchive {
    fn kind(&self) -> &'static str {
        if self.version == 1 {
            "hashfs1"
        } else {
            "hashfs2"
        }
    }
    fn name(&self) -> &str {
        &self.name
    }
    fn entry_count(&self) -> usize {
        self.entries.len()
    }
    fn exists(&self, path: &str) -> Option<EntryKind> {
        self.lookup(path)
            .map(|e| if e.is_dir { EntryKind::Dir } else { EntryKind::File })
    }
    fn read(&self, path: &str) -> Result<Vec<u8>> {
        match self.lookup(path) {
            Some(e) if !e.is_dir => self.entry_content(e),
            Some(_) => Err(Error::Invalid(format!("{path} is a directory"))),
            None => Err(Error::NotFound(path.to_string())),
        }
    }
    fn list_dir(&self, path: &str) -> Result<Option<DirListing>> {
        let p = normalize(path);
        let key = if p == "/" { "" } else { &p[1..] };
        let hash = hash_path(key, self.salt);
        let Some(e) = self.entries.get(&hash) else {
            return Ok(None);
        };
        if !e.is_dir {
            return Ok(None);
        }
        let mut out = DirListing::default();
        let data = self.entry_content(e)?;
        self.parse_listing(&data, &mut out);
        if let Some(extra) = self.extra_dirs.get(&hash) {
            for e in extra {
                let data = self.entry_content(e)?;
                self.parse_listing(&data, &mut out);
            }
        }
        Ok(Some(out))
    }
}

// ---------------------------------------------------------------------------
// Zip
// ---------------------------------------------------------------------------

/// dir path -> (subdirectory names, file names)
type DirIndex = HashMap<String, (BTreeSet<String>, BTreeSet<String>)>;

pub struct ZipArchive {
    name: String,
    zip: Mutex<zip::ZipArchive<File>>,
    /// normalized path -> zip index
    files: HashMap<String, usize>,
    /// normalized dir path -> (subdirs, files)
    dirs: DirIndex,
}

impl ZipArchive {
    pub fn open(path: &Path) -> Result<Self> {
        let f = File::open(path)?;
        let mut zip = zip::ZipArchive::new(f)?;
        let mut files = HashMap::new();
        let mut dirs: DirIndex = HashMap::new();
        dirs.entry("/".into()).or_default();
        for i in 0..zip.len() {
            let entry = zip.by_index_raw(i)?;
            let is_dir = entry.is_dir();
            let p = normalize(entry.name());
            drop(entry);
            if p == "/" {
                continue;
            }
            // register every ancestor directory
            let mut cur = p.clone();
            let mut child_is_dir = is_dir;
            loop {
                let par = parent(&cur);
                let name = cur.rsplit('/').next().unwrap_or("").to_string();
                let slot = dirs.entry(par.clone()).or_default();
                if child_is_dir {
                    slot.0.insert(name);
                } else {
                    slot.1.insert(name);
                }
                if par == "/" {
                    break;
                }
                cur = par;
                child_is_dir = true;
            }
            if is_dir {
                dirs.entry(p).or_default();
            } else {
                files.insert(p, i);
            }
        }
        Ok(ZipArchive {
            name: path
                .file_name()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_default(),
            zip: Mutex::new(zip),
            files,
            dirs,
        })
    }
}

impl Archive for ZipArchive {
    fn kind(&self) -> &'static str {
        "zip"
    }
    fn name(&self) -> &str {
        &self.name
    }
    fn entry_count(&self) -> usize {
        self.files.len() + self.dirs.len()
    }
    fn exists(&self, path: &str) -> Option<EntryKind> {
        let p = normalize(path);
        if self.files.contains_key(&p) {
            Some(EntryKind::File)
        } else if self.dirs.contains_key(&p) {
            Some(EntryKind::Dir)
        } else {
            None
        }
    }
    fn read(&self, path: &str) -> Result<Vec<u8>> {
        let p = normalize(path);
        let idx = *self.files.get(&p).ok_or_else(|| Error::NotFound(p.clone()))?;
        let mut zip = self.zip.lock().map_err(|_| Error::Invalid("poisoned lock".into()))?;
        let mut f = zip.by_index(idx)?;
        let mut out = Vec::with_capacity(f.size() as usize);
        f.read_to_end(&mut out)?;
        Ok(out)
    }
    fn list_dir(&self, path: &str) -> Result<Option<DirListing>> {
        Ok(self.dirs.get(&normalize(path)).map(|(d, f)| DirListing {
            dirs: d.iter().cloned().collect(),
            files: f.iter().cloned().collect(),
        }))
    }
}

// ---------------------------------------------------------------------------
// Folder (unpacked mod)
// ---------------------------------------------------------------------------

pub struct FolderArchive {
    name: String,
    root: PathBuf,
}

impl FolderArchive {
    pub fn open(root: &Path) -> Result<Self> {
        if !root.is_dir() {
            return Err(Error::NotFound(root.display().to_string()));
        }
        Ok(FolderArchive {
            name: root
                .file_name()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_default(),
            root: root.to_path_buf(),
        })
    }

    fn real(&self, path: &str) -> PathBuf {
        let p = normalize(path);
        let mut out = self.root.clone();
        for part in p.split('/').filter(|s| !s.is_empty()) {
            out.push(part);
        }
        out
    }
}

impl Archive for FolderArchive {
    fn kind(&self) -> &'static str {
        "folder"
    }
    fn name(&self) -> &str {
        &self.name
    }
    fn entry_count(&self) -> usize {
        0
    }
    fn exists(&self, path: &str) -> Option<EntryKind> {
        let r = self.real(path);
        if r.is_dir() {
            Some(EntryKind::Dir)
        } else if r.is_file() {
            Some(EntryKind::File)
        } else {
            None
        }
    }
    fn read(&self, path: &str) -> Result<Vec<u8>> {
        let r = self.real(path);
        if !r.is_file() {
            return Err(Error::NotFound(path.to_string()));
        }
        Ok(std::fs::read(r)?)
    }
    fn list_dir(&self, path: &str) -> Result<Option<DirListing>> {
        let r = self.real(path);
        if !r.is_dir() {
            return Ok(None);
        }
        let mut out = DirListing::default();
        for e in std::fs::read_dir(r)? {
            let e = e?;
            let n = e.file_name().to_string_lossy().to_string();
            if e.file_type()?.is_dir() {
                out.dirs.push(n);
            } else {
                out.files.push(n);
            }
        }
        out.dirs.sort();
        out.files.sort();
        Ok(Some(out))
    }
}

/// Opens any supported archive: folder, HashFS (.scs) or zip (.scs/.zip).
pub fn open_archive(path: &Path) -> Result<Box<dyn Archive>> {
    if path.is_dir() {
        return Ok(Box::new(FolderArchive::open(path)?));
    }
    let mut f = File::open(path)?;
    let mut magic = [0u8; 4];
    let n = read_up_to(&mut f, &mut magic)?;
    drop(f);
    if n == 4 && u32::from_le_bytes(magic) == HASHFS_MAGIC {
        Ok(Box::new(HashFsArchive::open(path)?))
    } else if n >= 2 && &magic[..2] == b"PK" {
        Ok(Box::new(ZipArchive::open(path)?))
    } else {
        Err(Error::Unsupported(format!(
            "{}: unknown archive format",
            path.display()
        )))
    }
}

// ---------------------------------------------------------------------------
// Virtual file system
// ---------------------------------------------------------------------------

/// Archives layered on top of each other; later mounts override earlier ones.
#[derive(Default)]
pub struct Vfs {
    archives: Vec<Box<dyn Archive>>,
}

impl Vfs {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn mount(&mut self, archive: Box<dyn Archive>) {
        self.archives.push(archive);
    }

    pub fn archives(&self) -> &[Box<dyn Archive>] {
        &self.archives
    }

    pub fn is_empty(&self) -> bool {
        self.archives.is_empty()
    }

    pub fn exists(&self, path: &str) -> Option<EntryKind> {
        self.archives.iter().rev().find_map(|a| a.exists(path))
    }

    pub fn read(&self, path: &str) -> Result<Vec<u8>> {
        let mut last_err = None;
        for a in self.archives.iter().rev() {
            if a.exists(path) == Some(EntryKind::File) {
                match a.read(path) {
                    Ok(d) => return Ok(d),
                    Err(e) => last_err = Some(e),
                }
            }
        }
        Err(last_err.unwrap_or_else(|| Error::NotFound(normalize(path))))
    }

    pub fn read_text(&self, path: &str) -> Result<String> {
        let data = self.read(path)?;
        let data = data.strip_prefix(&[0xEF, 0xBB, 0xBF][..]).unwrap_or(&data);
        Ok(String::from_utf8_lossy(data).to_string())
    }

    /// Merged directory listing (sorted, deduplicated). Missing directories give an empty listing.
    pub fn list_dir(&self, path: &str) -> Result<DirListing> {
        let mut dirs = BTreeSet::new();
        let mut files = BTreeSet::new();
        for a in &self.archives {
            if let Ok(Some(l)) = a.list_dir(path) {
                dirs.extend(l.dirs);
                files.extend(l.files);
            }
        }
        Ok(DirListing {
            dirs: dirs.into_iter().collect(),
            files: files.into_iter().collect(),
        })
    }

    /// Recursively collects every file path below `dir` (absolute virtual paths).
    pub fn walk_files(&self, dir: &str, max: usize) -> Vec<String> {
        let mut out = Vec::new();
        let mut stack = vec![normalize(dir)];
        while let Some(d) = stack.pop() {
            if let Ok(l) = self.list_dir(&d) {
                for f in l.files {
                    out.push(join(&d, &f));
                    if out.len() >= max {
                        return out;
                    }
                }
                for s in l.dirs.into_iter().rev() {
                    stack.push(join(&d, &s));
                }
            }
        }
        out
    }
}

/// Sort key implementing the game's mount order for the root `.scs` files.
pub fn game_archive_order(name: &str) -> (u8, String) {
    let n = name.to_ascii_lowercase();
    let group = if n.starts_with("base") {
        0
    } else if n.starts_with("core") {
        1
    } else if n.starts_with("def") {
        2
    } else if n.starts_with("effect") {
        3
    } else if n.starts_with("locale") {
        4
    } else if n.starts_with("dlc_") {
        6
    } else {
        5
    };
    (group, n)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::io::Write;

    /// Minimal HashFS v1 writer used by tests. `files` are (path, data); directories are derived.
    pub fn write_v1(path: &Path, files: &[(&str, &[u8])], compress: bool) {
        use flate2::write::ZlibEncoder;
        use flate2::Compression;
        let mut dirs: HashMap<String, (BTreeSet<String>, BTreeSet<String>)> = HashMap::new();
        dirs.entry("/".into()).or_default();
        for (p, _) in files {
            let mut cur = normalize(p);
            let mut is_dir = false;
            loop {
                let par = parent(&cur);
                let name = cur.rsplit('/').next().unwrap().to_string();
                let slot = dirs.entry(par.clone()).or_default();
                if is_dir {
                    slot.0.insert(name);
                } else {
                    slot.1.insert(name);
                }
                if par == "/" {
                    break;
                }
                cur = par;
                is_dir = true;
            }
        }
        let mut blobs: Vec<(String, Vec<u8>, bool)> = Vec::new();
        for (p, d) in files {
            blobs.push((normalize(p), d.to_vec(), false));
        }
        for (d, (sub, fl)) in &dirs {
            let mut s = String::new();
            for x in sub {
                s.push('*');
                s.push_str(x);
                s.push('\n');
            }
            for x in fl {
                s.push_str(x);
                s.push('\n');
            }
            blobs.push((d.clone(), s.into_bytes(), true));
        }
        let header_len = 4 + 2 + 2 + 4 + 4 + 8;
        let mut body = Vec::new();
        let mut table = Vec::new();
        for (p, data, is_dir) in &blobs {
            let offset = (header_len + body.len()) as u64;
            let (stored, flags) = if compress {
                let mut enc = ZlibEncoder::new(Vec::new(), Compression::default());
                enc.write_all(data).unwrap();
                (enc.finish().unwrap(), 2u32)
            } else {
                (data.clone(), 0u32)
            };
            let key = if p == "/" { "" } else { &p[1..] };
            table.extend_from_slice(&hash_path(key, 0).to_le_bytes());
            table.extend_from_slice(&offset.to_le_bytes());
            table.extend_from_slice(&(flags | if *is_dir { 1 } else { 0 }).to_le_bytes());
            table.extend_from_slice(&0u32.to_le_bytes());
            table.extend_from_slice(&(data.len() as u32).to_le_bytes());
            table.extend_from_slice(&(stored.len() as u32).to_le_bytes());
            body.extend_from_slice(&stored);
        }
        let start = (header_len + body.len()) as u64;
        let mut out = Vec::new();
        out.extend_from_slice(&HASHFS_MAGIC.to_le_bytes());
        out.extend_from_slice(&1u16.to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes());
        out.extend_from_slice(b"CITY");
        out.extend_from_slice(&(blobs.len() as u32).to_le_bytes());
        out.extend_from_slice(&start.to_le_bytes());
        out.extend_from_slice(&body);
        out.extend_from_slice(&table);
        std::fs::write(path, out).unwrap();
    }

    /// Minimal HashFS v2 writer (plain files + directories only), mirroring TruckLib's layout.
    fn write_v2(path: &Path, files: &[(&str, &[u8])], dirs: &[(&str, &[&str])]) {
        use flate2::write::ZlibEncoder;
        use flate2::Compression;
        let z = |d: &[u8]| {
            let mut e = ZlibEncoder::new(Vec::new(), Compression::default());
            e.write_all(d).unwrap();
            e.finish().unwrap()
        };
        let header_len = 64usize;
        let mut body: Vec<u8> = Vec::new();
        let mut entries = Vec::new();
        let mut meta: Vec<u8> = Vec::new();
        let mut add = |vpath: &str, data: Vec<u8>, is_dir: bool, body: &mut Vec<u8>, meta: &mut Vec<u8>| {
            while !(header_len + body.len()).is_multiple_of(16) {
                body.push(0);
            }
            let block = ((header_len + body.len()) / 16) as u32;
            let stored = z(&data);
            body.extend_from_slice(&stored);
            let idx = (meta.len() / 4) as u32;
            let chunk_type: u8 = if is_dir { 129 } else { 128 };
            meta.extend_from_slice(&[0, 0, 0, chunk_type]);
            let cs = stored.len() as u32;
            meta.extend_from_slice(&[cs as u8, (cs >> 8) as u8, (cs >> 16) as u8, ((cs >> 24) & 0xF) as u8 | 0x10]);
            let sz = data.len() as u32;
            meta.extend_from_slice(&[sz as u8, (sz >> 8) as u8, (sz >> 16) as u8, ((sz >> 24) & 0xF) as u8]);
            meta.extend_from_slice(&0u32.to_le_bytes());
            meta.extend_from_slice(&block.to_le_bytes());
            let n = normalize(vpath);
            let key = if n == "/" { String::new() } else { n[1..].to_string() };
            let mut e = Vec::new();
            e.extend_from_slice(&hash_path(&key, 0).to_le_bytes());
            e.extend_from_slice(&idx.to_le_bytes());
            e.extend_from_slice(&1u16.to_le_bytes());
            e.extend_from_slice(&(is_dir as u16).to_le_bytes());
            entries.push(e);
        };
        for (p, d) in files {
            add(p, d.to_vec(), false, &mut body, &mut meta);
        }
        for (p, items) in dirs {
            let mut lens = Vec::new();
            let mut strs = Vec::new();
            for it in *items {
                lens.push(it.len() as u8);
                strs.extend_from_slice(it.as_bytes());
            }
            let mut d = (items.len() as u32).to_le_bytes().to_vec();
            d.extend_from_slice(&lens);
            d.extend_from_slice(&strs);
            add(p, d, true, &mut body, &mut meta);
        }
        let et = z(&entries.concat());
        let mt = z(&meta);
        let et_start = (header_len + body.len()) as u64;
        let mt_start = et_start + et.len() as u64;
        let mut out = Vec::new();
        out.extend_from_slice(&HASHFS_MAGIC.to_le_bytes());
        out.extend_from_slice(&2u16.to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes());
        out.extend_from_slice(b"CITY");
        out.extend_from_slice(&(entries.len() as u32).to_le_bytes());
        out.extend_from_slice(&(et.len() as u32).to_le_bytes());
        out.extend_from_slice(&((meta.len() / 4) as u32).to_le_bytes());
        out.extend_from_slice(&(mt.len() as u32).to_le_bytes());
        out.extend_from_slice(&et_start.to_le_bytes());
        out.extend_from_slice(&mt_start.to_le_bytes());
        out.extend_from_slice(&0u32.to_le_bytes());
        out.push(0);
        out.resize(header_len, 0);
        out.extend_from_slice(&body);
        out.extend_from_slice(&et);
        out.extend_from_slice(&mt);
        std::fs::write(path, out).unwrap();
    }

    #[test]
    fn hashfs_v2_reads() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("v2.scs");
        write_v2(
            &p,
            &[("/def/a.sii", b"hello v2")],
            &[("/", &["/def", "manifest.sii"]), ("/def", &["a.sii"])],
        );
        let a = open_archive(&p).unwrap();
        assert_eq!(a.kind(), "hashfs2");
        assert_eq!(a.read("/def/a.sii").unwrap(), b"hello v2");
        let root = a.list_dir("/").unwrap().unwrap();
        assert_eq!(root.dirs, vec!["def"]);
        assert_eq!(root.files, vec!["manifest.sii"]);
        assert_eq!(a.exists("/def"), Some(EntryKind::Dir));
    }

    #[test]
    fn path_helpers() {
        assert_eq!(normalize("def\\vehicle//truck/"), "/def/vehicle/truck");
        assert_eq!(normalize(""), "/");
        assert_eq!(join("/def", "a.sii"), "/def/a.sii");
        assert_eq!(join("/", "def"), "/def");
        assert_eq!(join("/a/b", "../c"), "/a/c");
        assert_eq!(parent("/def/a.sii"), "/def");
        assert_eq!(parent("/def"), "/");
    }

    #[test]
    fn hashfs_v1_roundtrip() {
        let dir = tempfile::tempdir().unwrap();
        for compress in [false, true] {
            let p = dir.path().join(format!("t{compress}.scs"));
            write_v1(
                &p,
                &[
                    ("/def/vehicle/truck/x/data.sii", b"SiiNunit {}"),
                    ("/manifest.sii", b"hello"),
                ],
                compress,
            );
            let a = open_archive(&p).unwrap();
            assert_eq!(a.kind(), "hashfs1");
            assert_eq!(a.read("/manifest.sii").unwrap(), b"hello");
            assert_eq!(a.read("def/vehicle/truck/x/data.sii").unwrap(), b"SiiNunit {}");
            let root = a.list_dir("/").unwrap().unwrap();
            assert_eq!(root.dirs, vec!["def"]);
            assert_eq!(root.files, vec!["manifest.sii"]);
            assert_eq!(a.exists("/def/vehicle"), Some(EntryKind::Dir));
            assert!(a.read("/nope").is_err());
        }
    }

    #[test]
    fn vfs_overrides_and_merges() {
        let dir = tempfile::tempdir().unwrap();
        let a = dir.path().join("a.scs");
        let b = dir.path().join("b.zip");
        write_v1(&a, &[("/def/x.sii", b"A"), ("/def/only_a.sii", b"A")], true);
        {
            let f = File::create(&b).unwrap();
            let mut z = zip::ZipWriter::new(f);
            let opts = zip::write::SimpleFileOptions::default();
            z.start_file("def/x.sii", opts).unwrap();
            z.write_all(b"B").unwrap();
            z.start_file("def/sub/y.sii", opts).unwrap();
            z.write_all(b"Y").unwrap();
            z.finish().unwrap();
        }
        let mut vfs = Vfs::new();
        vfs.mount(open_archive(&a).unwrap());
        vfs.mount(open_archive(&b).unwrap());
        assert_eq!(vfs.read("/def/x.sii").unwrap(), b"B");
        assert_eq!(vfs.read("/def/only_a.sii").unwrap(), b"A");
        let l = vfs.list_dir("/def").unwrap();
        assert_eq!(l.dirs, vec!["sub"]);
        assert_eq!(l.files, vec!["only_a.sii", "x.sii"]);
        let all = vfs.walk_files("/", 100);
        assert!(all.contains(&"/def/sub/y.sii".to_string()));
    }

    #[test]
    fn mount_order() {
        let mut names = vec!["dlc_b.scs", "def.scs", "base.scs", "core.scs", "base_vehicle.scs", "dlc_a.scs", "locale.scs", "effect.scs", "other.scs"];
        names.sort_by_key(|n| game_archive_order(n));
        assert_eq!(names, vec!["base.scs", "base_vehicle.scs", "core.scs", "def.scs", "effect.scs", "locale.scs", "other.scs", "dlc_a.scs", "dlc_b.scs"]);
    }
}
