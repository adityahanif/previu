mod assoc;
mod listing;
mod protocol;

use std::io::BufWriter;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::Serialize;
use tauri::{Emitter, Manager};

use listing::DocInfo;

/// A path handed to us on the command line that the frontend has not picked up
/// yet. Kept here rather than emitted from `setup`, because the webview is not
/// listening for events that early.
#[derive(Default)]
struct PendingOpen(Mutex<Option<PathBuf>>);

impl PendingOpen {
    fn set(&self, path: PathBuf) {
        *self.0.lock().unwrap_or_else(|e| e.into_inner()) = Some(path);
    }

    fn take(&self) -> Option<PathBuf> {
        self.0.lock().unwrap_or_else(|e| e.into_inner()).take()
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct OpenedDocument {
    /// Directory whose siblings are being offered for arrow-key navigation.
    folder: String,
    siblings: Vec<DocInfo>,
    index: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AppInfo {
    version: String,
    platform: String,
}

#[tauri::command]
fn app_info(app: tauri::AppHandle) -> AppInfo {
    AppInfo {
        version: app.package_info().version.to_string(),
        platform: std::env::consts::OS.to_string(),
    }
}

fn extension_of(path: &Path) -> String {
    path.extension()
        .map(|e| e.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default()
}

/// Resolves what the user asked to open into a document plus its folder
/// siblings, and grants the protocol handler read access to all of them.
#[tauri::command]
fn open_document(path: String, app: tauri::AppHandle) -> Result<OpenedDocument, String> {
    let requested = PathBuf::from(&path);

    let metadata = std::fs::metadata(&requested)
        .map_err(|error| format!("Cannot open {}: {error}", requested.display()))?;

    // Dropping a folder opens the first supported file inside it.
    let target = if metadata.is_dir() {
        listing::scan(&requested)
            .into_iter()
            .next()
            .map(|doc| PathBuf::from(doc.path))
            .ok_or_else(|| format!("No images or PDFs in {}", requested.display()))?
    } else {
        requested
    };

    let ext = extension_of(&target);
    let kind = listing::kind_of(&ext)
        .ok_or_else(|| format!("{ext} is not a supported file type"))?;

    let folder = target
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from("."));

    let mut siblings = listing::scan(&folder);
    if siblings.is_empty() {
        let fallback = DocInfo::new(&target, kind)
            .ok_or_else(|| format!("Cannot read {}", target.display()))?;
        siblings.push(fallback);
    }

    let target_string = target.to_string_lossy().into_owned();
    let index = siblings
        .iter()
        .position(|doc| doc.path == target_string)
        .unwrap_or(0);

    // Grant before returning, so any URL the frontend immediately renders is
    // already readable.
    app.state::<protocol::Allowlist>()
        .allow(siblings.iter().map(|doc| PathBuf::from(&doc.path)));

    Ok(OpenedDocument {
        folder: folder.to_string_lossy().into_owned(),
        siblings,
        index,
    })
}

#[tauri::command]
fn take_pending_open(pending: tauri::State<'_, PendingOpen>) -> Option<String> {
    pending
        .take()
        .map(|path| path.to_string_lossy().into_owned())
}

fn write_image(image: &image::DynamicImage, dest: &Path) -> Result<(), String> {
    let error = |e: image::ImageError| format!("Cannot write {}: {e}", dest.display());

    match extension_of(dest).as_str() {
        "jpg" | "jpeg" | "jfif" => {
            let file = std::fs::File::create(dest)
                .map_err(|e| format!("Cannot create {}: {e}", dest.display()))?;
            let rgb = image.to_rgb8();
            // `DynamicImage::save` would use a lossy default quality; 92 keeps
            // a rotated copy visually indistinguishable from the original.
            image::codecs::jpeg::JpegEncoder::new_with_quality(BufWriter::new(file), 92)
                .encode_image(&rgb)
                .map_err(error)
        }
        _ => image.save(dest).map_err(error),
    }
}

/// Writes a copy of `src` with the viewer's rotation and flips baked in. The
/// original file is never modified.
#[tauri::command]
fn save_copy(
    src: String,
    dest: String,
    rotation: u16,
    flip_h: bool,
    flip_v: bool,
) -> Result<(), String> {
    let mut image = image::open(&src).map_err(|e| format!("Cannot read {src}: {e}"))?;

    if flip_h {
        image = image.fliph();
    }
    if flip_v {
        image = image.flipv();
    }
    image = match rotation % 360 {
        90 => image.rotate90(),
        180 => image.rotate180(),
        270 => image.rotate270(),
        _ => image,
    };

    write_image(&image, Path::new(&dest))
}

#[tauri::command]
fn assoc_status() -> assoc::AssocStatus {
    assoc::status()
}

#[tauri::command]
fn register_assoc() -> Result<assoc::AssocStatus, String> {
    assoc::register()
}

#[tauri::command]
fn open_default_apps_settings() -> Result<(), String> {
    assoc::open_default_apps()
}

/// First positional argument that names an existing file. Explorer passes the
/// document path as `argv[1]` when the app is launched as a file handler.
fn first_file_arg() -> Option<PathBuf> {
    std::env::args()
        .skip(1)
        .filter(|arg| !arg.starts_with('-'))
        .map(PathBuf::from)
        .find(|path| path.is_file())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default();

    // Registered first: a second launch should forward its path to the window
    // that is already open instead of starting another viewer.
    #[cfg(windows)]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            let file = argv
                .iter()
                .skip(1)
                .filter(|arg| !arg.starts_with('-'))
                .map(PathBuf::from)
                .find(|path| path.is_file());

            if let Some(path) = file {
                if let Some(pending) = app.try_state::<PendingOpen>() {
                    pending.set(path.clone());
                }
                let _ = app.emit("previu:open-file", path.to_string_lossy().into_owned());
            }

            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }));
    }

    builder
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(PendingOpen::default())
        .manage(protocol::Allowlist::default())
        .register_asynchronous_uri_scheme_protocol(protocol::SCHEME, |ctx, request, responder| {
            let app = ctx.app_handle().clone();
            // Disk reads must not run on the webview's protocol thread.
            tauri::async_runtime::spawn_blocking(move || {
                responder.respond(protocol::handle(&app, request));
            });
        })
        .invoke_handler(tauri::generate_handler![
            app_info,
            open_document,
            take_pending_open,
            save_copy,
            assoc_status,
            register_assoc,
            open_default_apps_settings,
        ])
        .setup(|app| {
            if let Some(path) = first_file_arg() {
                app.state::<PendingOpen>().set(path);
            }
            // An install that is already registered keeps its registry entries
            // across updates, so renew them on launch: that is how a new
            // release's file icons reach the shell without the user pressing
            // "Set as default viewer" again.
            if assoc::status().registered {
                let _ = assoc::register();
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Previu");
}
