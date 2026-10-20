//! Serves local files to the webview over a custom `previu://` scheme.
//!
//! The webview never gets a general-purpose filesystem API. A path becomes
//! readable only after `open_document` has added it to the [`Allowlist`], so a
//! compromised or buggy frontend cannot walk the disk. HTTP range requests are
//! supported so pdf.js can stream large documents instead of buffering them.

use std::collections::HashSet;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use tauri::http::{header, HeaderValue, Method, Request, Response, StatusCode};
use tauri::{AppHandle, Manager, Runtime};

pub const SCHEME: &str = "previu";

/// Files the frontend is permitted to read through the protocol handler.
#[derive(Default)]
pub struct Allowlist {
    files: Mutex<HashSet<PathBuf>>,
}

impl Allowlist {
    pub fn allow(&self, paths: impl IntoIterator<Item = PathBuf>) {
        let mut files = self.files.lock().unwrap_or_else(|e| e.into_inner());
        files.extend(paths);
    }

    pub fn permits(&self, path: &Path) -> bool {
        let files = self.files.lock().unwrap_or_else(|e| e.into_inner());
        files.contains(path)
    }
}

/// Content type for an extension. The webview relies on these to decide whether
/// a buffer belongs in `<img>` or in pdf.js.
pub fn mime_for(path: &Path) -> &'static str {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();

    match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" | "jfif" | "jpe" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        "ico" => "image/x-icon",
        "svg" => "image/svg+xml",
        "avif" => "image/avif",
        "pdf" => "application/pdf",
        _ => "application/octet-stream",
    }
}

/// Extracts the `p` query parameter, which holds the percent-encoded file path.
fn requested_path(uri: &tauri::http::Uri) -> Option<PathBuf> {
    let query = uri.query()?;
    let encoded = query.split('&').find_map(|pair| pair.strip_prefix("p="))?;
    let decoded = percent_encoding::percent_decode_str(encoded)
        .decode_utf8()
        .ok()?;
    Some(PathBuf::from(decoded.as_ref()))
}

/// Parses a single-range `bytes=start-end` header into an inclusive range.
fn parse_range(value: &str, len: u64) -> Option<(u64, u64)> {
    let spec = value.strip_prefix("bytes=")?;
    // Multi-range requests are legal but pdf.js only ever asks for one.
    let (start, end) = spec.split_once('-')?;
    if len == 0 {
        return None;
    }
    let last = len - 1;

    let (start, end) = if start.is_empty() {
        // Suffix range: the trailing N bytes.
        let n: u64 = end.parse().ok()?;
        (len.checked_sub(n)?, last)
    } else {
        let start: u64 = start.parse().ok()?;
        let end = if end.is_empty() {
            last
        } else {
            end.parse::<u64>().ok()?.min(last)
        };
        (start, end)
    };

    if start > end || start > last {
        return None;
    }
    Some((start, end))
}

fn with_cors(mut response: Response<Vec<u8>>) -> Response<Vec<u8>> {
    let headers = response.headers_mut();
    headers.insert(
        header::ACCESS_CONTROL_ALLOW_ORIGIN,
        HeaderValue::from_static("*"),
    );
    headers.insert(
        header::ACCESS_CONTROL_ALLOW_METHODS,
        HeaderValue::from_static("GET, HEAD, OPTIONS"),
    );
    headers.insert(
        header::ACCESS_CONTROL_ALLOW_HEADERS,
        HeaderValue::from_static("Range, Content-Type"),
    );
    headers.insert(
        header::ACCESS_CONTROL_EXPOSE_HEADERS,
        HeaderValue::from_static("Content-Range, Content-Length, Accept-Ranges"),
    );
    response
}

fn plain(status: StatusCode, message: &str) -> Response<Vec<u8>> {
    let mut response = Response::new(message.as_bytes().to_vec());
    *response.status_mut() = status;
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("text/plain; charset=utf-8"),
    );
    response.headers_mut().insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    with_cors(response)
}

/// Entry point for the `previu://` scheme.
pub fn handle<R: Runtime>(app: &AppHandle<R>, request: Request<Vec<u8>>) -> Response<Vec<u8>> {
    let method = request.method().clone();

    if method == Method::OPTIONS {
        let mut response = Response::new(Vec::new());
        *response.status_mut() = StatusCode::NO_CONTENT;
        return with_cors(response);
    }

    let Some(path) = requested_path(request.uri()) else {
        return plain(StatusCode::BAD_REQUEST, "missing ?p= parameter");
    };

    // Consent is checked per request: the webview caches URLs across document
    // switches, but the frontend only vouches for what the user actually opened.
    if !app.state::<Allowlist>().permits(&path) {
        return plain(StatusCode::FORBIDDEN, "path was not opened by the user");
    }

    let Ok(mut file) = std::fs::File::open(&path) else {
        return plain(StatusCode::NOT_FOUND, "cannot open file");
    };

    let len = match file.metadata() {
        Ok(meta) if meta.is_file() => meta.len(),
        Ok(_) => return plain(StatusCode::FORBIDDEN, "not a regular file"),
        Err(_) => return plain(StatusCode::INTERNAL_SERVER_ERROR, "cannot stat file"),
    };

    let range = request
        .headers()
        .get(header::RANGE)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| parse_range(value, len));

    let (status, offset, count) = match range {
        Some((start, end)) => (StatusCode::PARTIAL_CONTENT, start, end - start + 1),
        None => (StatusCode::OK, 0, len),
    };

    if offset != 0 && file.seek(SeekFrom::Start(offset)).is_err() {
        return plain(StatusCode::INTERNAL_SERVER_ERROR, "cannot seek");
    }

    // A HEAD probe only wants the headers, so skip the read but keep
    // Content-Length reporting the length a GET would return.
    let buffer = if method == Method::HEAD {
        Vec::new()
    } else {
        let mut buffer = Vec::with_capacity(count.min(16 * 1024 * 1024) as usize);
        if let Err(error) = file.take(count).read_to_end(&mut buffer) {
            return plain(
                StatusCode::INTERNAL_SERVER_ERROR,
                &format!("cannot read file: {error}"),
            );
        }
        buffer
    };

    let mut response = Response::new(buffer);
    *response.status_mut() = status;
    let headers = response.headers_mut();
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static(mime_for(&path)),
    );
    headers.insert(header::CONTENT_LENGTH, HeaderValue::from(count));
    headers.insert(header::ACCEPT_RANGES, HeaderValue::from_static("bytes"));
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-cache"));
    headers.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    headers.insert(
        header::CONTENT_DISPOSITION,
        HeaderValue::from_static("inline"),
    );
    if status == StatusCode::PARTIAL_CONTENT {
        let value = format!("bytes {}-{}/{}", offset, offset + count - 1, len);
        headers.insert(
            header::CONTENT_RANGE,
            HeaderValue::try_from(value).unwrap_or_else(|_| HeaderValue::from_static("")),
        );
    }
    with_cors(response)
}

/// Base URL the frontend builds `previu://` links against. Windows and Android
/// expose custom schemes as `http://<scheme>.localhost`.
fn base_url() -> &'static str {
    if cfg!(any(windows, target_os = "android")) {
        "http://previu.localhost/"
    } else {
        "previu://localhost/"
    }
}

/// URL for a file the viewer has already been granted access to.
pub fn url_for(path: &Path) -> String {
    // Bound to a local: `to_string_lossy` borrows a temporary `Cow`, and the
    // encoder holds a reference to it until the formatting finishes.
    let text = path.to_string_lossy();
    let encoded = percent_encoding::utf8_percent_encode(&text, percent_encoding::NON_ALPHANUMERIC);
    format!("{}?p={}", base_url(), encoded)
}
