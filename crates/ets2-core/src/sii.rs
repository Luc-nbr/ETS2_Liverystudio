//! Tolerant parser for text SII (and SUI fragments).
//!
//! Supports `SiiNunit { ... }`, units `class : name { ... }`, attributes `key: value`,
//! `key[]: value`, `key[3]: value`, comments (`#`, `//`, `/* */`), quoted strings, tuples
//! (kept as raw text) and `@include "file"` (resolved through a caller-provided closure).
//! Encrypted (`ScsC`), binary (`BSII`) and `3nK` encoded files are detected and rejected.

use crate::{Error, Result};

#[derive(Debug, Clone, PartialEq)]
pub struct Attr {
    pub key: String,
    /// `Some(None)` for `key[]`, `Some(Some(n))` for `key[n]`, `None` for plain `key`
    pub index: Option<Option<usize>>,
    /// Unquoted string contents, or the raw token text for numbers/tuples/tokens
    pub value: String,
    pub quoted: bool,
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct Unit {
    pub class: String,
    pub name: String,
    pub attrs: Vec<Attr>,
}

impl Unit {
    /// First value for `key` (array or not).
    pub fn get(&self, key: &str) -> Option<&str> {
        self.attrs
            .iter()
            .find(|a| a.key == key)
            .map(|a| a.value.as_str())
    }

    /// All values for `key` in file order.
    pub fn get_all(&self, key: &str) -> Vec<&str> {
        self.attrs
            .iter()
            .filter(|a| a.key == key)
            .map(|a| a.value.as_str())
            .collect()
    }

    pub fn get_bool(&self, key: &str) -> Option<bool> {
        self.get(key).map(|v| v.eq_ignore_ascii_case("true"))
    }

    /// Every string value of every attribute.
    pub fn values(&self) -> impl Iterator<Item = &str> {
        self.attrs.iter().map(|a| a.value.as_str())
    }
}

/// Parses a tuple such as `(1, 0.5, 0)` into floats. Hex float notation (`&3f800000`) is supported.
pub fn parse_floats(v: &str) -> Vec<f32> {
    v.trim()
        .trim_start_matches('(')
        .trim_end_matches(')')
        .split(',')
        .filter_map(|s| parse_float(s.trim()))
        .collect()
}

pub fn parse_float(s: &str) -> Option<f32> {
    if let Some(hex) = s.strip_prefix('&') {
        u32::from_str_radix(hex, 16).ok().map(f32::from_bits)
    } else {
        s.parse().ok()
    }
}

/// Checks the first bytes for unsupported encodings.
pub fn check_encoding(data: &[u8]) -> Result<()> {
    if data.starts_with(b"ScsC") {
        Err(Error::Unsupported("encrypted SII (ScsC)".into()))
    } else if data.starts_with(b"BSII") {
        Err(Error::Unsupported("binary SII (BSII)".into()))
    } else if data.starts_with(b"3nK") {
        Err(Error::Unsupported("3nK-encoded SII".into()))
    } else {
        Ok(())
    }
}

/// Decodes bytes to text after checking the encoding (BOM is stripped).
pub fn decode(data: &[u8]) -> Result<String> {
    check_encoding(data)?;
    let data = data.strip_prefix(&[0xEF, 0xBB, 0xBF][..]).unwrap_or(data);
    Ok(String::from_utf8_lossy(data).to_string())
}

/// Removes comments outside of quoted strings.
fn strip_comments(src: &str) -> String {
    let mut out = String::with_capacity(src.len());
    let chars: Vec<char> = src.chars().collect();
    let mut i = 0;
    let mut in_str = false;
    while i < chars.len() {
        let c = chars[i];
        if in_str {
            out.push(c);
            if c == '\\' && i + 1 < chars.len() {
                out.push(chars[i + 1]);
                i += 2;
                continue;
            }
            if c == '"' {
                in_str = false;
            }
            if c == '\n' {
                in_str = false; // unterminated string: recover at end of line
            }
            i += 1;
            continue;
        }
        match c {
            '"' => {
                in_str = true;
                out.push(c);
                i += 1;
            }
            '#' => {
                while i < chars.len() && chars[i] != '\n' {
                    i += 1;
                }
            }
            '/' if i + 1 < chars.len() && chars[i + 1] == '/' => {
                while i < chars.len() && chars[i] != '\n' {
                    i += 1;
                }
            }
            '/' if i + 1 < chars.len() && chars[i + 1] == '*' => {
                i += 2;
                while i + 1 < chars.len() && !(chars[i] == '*' && chars[i + 1] == '/') {
                    if chars[i] == '\n' {
                        out.push('\n');
                    }
                    i += 1;
                }
                i += 2;
            }
            _ => {
                out.push(c);
                i += 1;
            }
        }
    }
    out
}

fn unquote(v: &str) -> (String, bool) {
    let v = v.trim();
    if let Some(rest) = v.strip_prefix('"') {
        let mut s = String::new();
        let mut chars = rest.chars();
        while let Some(c) = chars.next() {
            match c {
                '\\' => match chars.next() {
                    Some('n') => s.push('\n'),
                    Some('t') => s.push('\t'),
                    Some(o) => s.push(o),
                    None => {}
                },
                '"' => break,
                _ => s.push(c),
            }
        }
        (s, true)
    } else {
        (v.to_string(), false)
    }
}

fn include_target(line: &str) -> Option<String> {
    let rest = line.trim().strip_prefix("@include")?;
    let (s, quoted) = unquote(rest);
    if quoted {
        Some(s)
    } else {
        None
    }
}

/// Expands `@include` lines recursively. `resolve(name)` returns the text of an included file.
pub fn expand_includes<F>(src: &str, resolve: &mut F, depth: usize) -> String
where
    F: FnMut(&str) -> Option<String>,
{
    let mut out = String::with_capacity(src.len());
    for line in src.lines() {
        if let Some(target) = include_target(line) {
            if depth < 8 {
                if let Some(text) = resolve(&target) {
                    let text = strip_comments(&text);
                    out.push_str(&expand_includes(&text, resolve, depth + 1));
                    out.push('\n');
                    continue;
                }
            }
            continue;
        }
        out.push_str(line);
        out.push('\n');
    }
    out
}

/// Parses SII text. Includes are dropped unless [`parse_with_includes`] is used.
pub fn parse(src: &str) -> Vec<Unit> {
    parse_with_includes(src, |_| None)
}

/// Parses SII text, resolving `@include` through `resolve`.
pub fn parse_with_includes<F>(src: &str, mut resolve: F) -> Vec<Unit>
where
    F: FnMut(&str) -> Option<String>,
{
    let cleaned = strip_comments(src);
    let text = expand_includes(&cleaned, &mut resolve, 0);

    // Split braces onto their own logical lines (outside of strings) so that
    // `unit : name {` and `}` handling is uniform.
    let mut lines: Vec<String> = Vec::new();
    for raw in text.lines() {
        let mut cur = String::new();
        let mut in_str = false;
        for c in raw.chars() {
            if c == '"' {
                in_str = !in_str;
            }
            if !in_str && (c == '{' || c == '}') {
                if !cur.trim().is_empty() {
                    lines.push(cur.trim().to_string());
                }
                lines.push(c.to_string());
                cur.clear();
            } else {
                cur.push(c);
            }
        }
        if !cur.trim().is_empty() {
            lines.push(cur.trim().to_string());
        }
    }

    let mut units = Vec::new();
    let mut pending: Option<Unit> = None;
    let mut current: Option<Unit> = None;
    for line in lines {
        match line.as_str() {
            "{" => {
                if let Some(u) = pending.take() {
                    current = Some(u);
                }
            }
            "}" => {
                if let Some(u) = current.take() {
                    units.push(u);
                }
            }
            _ => {
                if line == "SiiNunit" {
                    continue;
                }
                let Some((k, v)) = line.split_once(':') else {
                    continue;
                };
                if let Some(unit) = current.as_mut() {
                    let key_raw = k.trim();
                    let (key, index) = match key_raw.find('[') {
                        Some(i) => {
                            let inner = key_raw[i + 1..].trim_end_matches(']').trim();
                            let idx = if inner.is_empty() { None } else { inner.parse().ok() };
                            (key_raw[..i].trim().to_string(), Some(idx))
                        }
                        None => (key_raw.to_string(), None),
                    };
                    let (value, quoted) = unquote(v);
                    unit.attrs.push(Attr {
                        key,
                        index,
                        value,
                        quoted,
                    });
                } else {
                    pending = Some(Unit {
                        class: k.trim().to_string(),
                        name: v.trim().to_string(),
                        attrs: Vec::new(),
                    });
                }
            }
        }
    }
    units
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = r#"SiiNunit
{
# comment
accessory_cabin_data : cab_a.scania.r_2016.cabin
{
	name: "Normal" // trailing comment
	price: 1000
	model: "/vehicle/truck/scania_r_2016/cab_a.pmd"
	detail_model[]: "/vehicle/truck/scania_r_2016/cab_a_lod1.pmd"
	detail_model[1]: "/vehicle/truck/scania_r_2016/cab_a_lod2.pmd"
	/* block
	   comment */
	base_color: (1, 0.5, &3f800000)
	path_with_hash: "a#b"
}
accessory_paint_job_data : my_pj.scania.r_2016.paint_job {
@include "my_pj_settings.sui"
	paint_job_mask: "/vehicle/truck/upgrade/paintjob/x/cab.tobj"
}
}
"#;

    #[test]
    fn parses_units_and_includes() {
        let units = parse_with_includes(SAMPLE, |name| {
            assert_eq!(name, "my_pj_settings.sui");
            Some("\tname: \"Mine\"\n\tairbrush: true\n".to_string())
        });
        assert_eq!(units.len(), 2);
        let c = &units[0];
        assert_eq!(c.class, "accessory_cabin_data");
        assert_eq!(c.name, "cab_a.scania.r_2016.cabin");
        assert_eq!(c.get("name"), Some("Normal"));
        assert_eq!(c.get("price"), Some("1000"));
        assert_eq!(c.get_all("detail_model").len(), 2);
        assert_eq!(c.get("path_with_hash"), Some("a#b"));
        assert_eq!(parse_floats(c.get("base_color").unwrap()), vec![1.0, 0.5, 1.0]);
        let p = &units[1];
        assert_eq!(p.get("name"), Some("Mine"));
        assert_eq!(p.get_bool("airbrush"), Some(true));
        assert!(p.get("paint_job_mask").unwrap().ends_with("cab.tobj"));
    }

    #[test]
    fn rejects_encrypted() {
        assert!(decode(b"ScsC....").is_err());
        assert!(decode(b"BSII....").is_err());
        assert!(decode(b"\xEF\xBB\xBFSiiNunit {}").is_ok());
    }
}
