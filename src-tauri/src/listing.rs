//! Folder scanning for "next/previous file" navigation, the way macOS Preview
//! walks through the siblings of the document you opened.

use std::cmp::Ordering;
use std::path::Path;

use serde::Serialize;

use crate::protocol;

pub const IMAGE_EXTS: &[&str] = &[
    "png", "jpg", "jpeg", "jfif", "jpe", "gif", "webp", "bmp", "ico", "svg", "avif",
];

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Image,
    Pdf,
}

impl Kind {
    pub fn as_str(self) -> &'static str {
        match self {
            Kind::Image => "image",
            Kind::Pdf => "pdf",
        }
    }
}

pub fn kind_of(ext: &str) -> Option<Kind> {
    let ext = ext.to_ascii_lowercase();
    if ext == "pdf" {
        Some(Kind::Pdf)
    } else if IMAGE_EXTS.contains(&ext.as_str()) {
        Some(Kind::Image)
    } else {
        None
    }
}

#[derive(Serialize)]
pub struct DocInfo {
    pub path: String,
    pub name: String,
    pub ext: String,
    pub kind: &'static str,
    pub size: u64,
    /// Milliseconds since the Unix epoch, or 0 when the filesystem will not say.
    pub modified: u64,
    pub url: String,
}

impl DocInfo {
    pub fn new(path: &Path, kind: Kind) -> Option<Self> {
        let name = path.file_name()?.to_string_lossy().into_owned();
        let ext = path
            .extension()
            .map(|e| e.to_string_lossy().to_ascii_lowercase())
            .unwrap_or_default();
        // One stat call answers both: the listing shows sizes and lets the
        // sidebar sort by date.
        let metadata = std::fs::metadata(path).ok();
        let size = metadata.as_ref().map(|m| m.len()).unwrap_or(0);
        let modified = metadata
            .and_then(|m| m.modified().ok())
            .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|elapsed| elapsed.as_millis() as u64)
            .unwrap_or(0);
        Some(Self {
            url: protocol::url_for(path),
            path: path.to_string_lossy().into_owned(),
            name,
            ext,
            kind: kind.as_str(),
            size,
            modified,
        })
    }
}

/// Compares file names so that `page2.png` sorts before `page10.png`, which is
/// what people expect when arrowing through a folder of exports.
fn natural_cmp(a: &str, b: &str) -> Ordering {
    let mut left = a.chars().peekable();
    let mut right = b.chars().peekable();

    loop {
        match (left.peek().copied(), right.peek().copied()) {
            (None, None) => return Ordering::Equal,
            (None, Some(_)) => return Ordering::Less,
            (Some(_), None) => return Ordering::Greater,
            (Some(x), Some(y)) => {
                if x.is_ascii_digit() && y.is_ascii_digit() {
                    let mut xs = String::new();
                    while let Some(c) = left.peek().copied() {
                        if !c.is_ascii_digit() {
                            break;
                        }
                        xs.push(c);
                        left.next();
                    }
                    let mut ys = String::new();
                    while let Some(c) = right.peek().copied() {
                        if !c.is_ascii_digit() {
                            break;
                        }
                        ys.push(c);
                        right.next();
                    }
                    // Compare by magnitude so arbitrarily long runs still sort.
                    let xs = xs.trim_start_matches('0');
                    let ys = ys.trim_start_matches('0');
                    match xs.len().cmp(&ys.len()).then_with(|| xs.cmp(ys)) {
                        Ordering::Equal => {}
                        other => return other,
                    }
                } else {
                    match x.to_ascii_lowercase().cmp(&y.to_ascii_lowercase()) {
                        Ordering::Equal => {
                            left.next();
                            right.next();
                        }
                        other => return other,
                    }
                }
            }
        }
    }
}

/// Supported files in `dir`, naturally sorted by name.
pub fn scan(dir: &Path) -> Vec<DocInfo> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };

    let mut docs: Vec<DocInfo> = entries
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().map(|t| t.is_file()).unwrap_or(false))
        .filter_map(|entry| {
            let path = entry.path();
            let ext = path.extension()?.to_string_lossy().to_ascii_lowercase();
            let kind = kind_of(&ext)?;
            DocInfo::new(&path, kind)
        })
        .collect();

    docs.sort_by(|a, b| {
        natural_cmp(&a.name, &b.name).then_with(|| natural_cmp(&a.path, &b.path))
    });
    docs
}
