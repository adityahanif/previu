//! Registers Previu as a candidate handler for images and PDFs.
//!
//! Windows deliberately makes it impossible for an app to silently become the
//! default handler: `UserChoice` is hash-signed and only Explorer may write it.
//! So this module does everything an app *can* do — register ProgIDs, add
//! `OpenWithProgids`, publish capabilities — and then hands the final decision to
//! the user through Settings.

use serde::Serialize;

/// Types Previu offers to handle. SVG and ICO are viewable but deliberately left
/// out: claiming `.svg` would steal it from browsers, and `.ico` from shortcuts.
pub const REGISTERED_EXTS: &[&str] = &[
    "png", "jpg", "jpeg", "jfif", "gif", "webp", "bmp", "avif", "pdf",
];

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AssocStatus {
    /// True once the ProgIDs and application entry exist in the registry.
    pub registered: bool,
    /// Extensions Windows currently routes to Previu.
    pub default_for: Vec<String>,
    /// Extensions Previu can handle at all.
    pub supported: Vec<String>,
}

fn type_name(ext: &str) -> &'static str {
    match ext {
        "png" => "PNG image",
        "jpg" | "jpeg" | "jfif" => "JPEG image",
        "gif" => "GIF image",
        "webp" => "WebP image",
        "bmp" => "Bitmap image",
        "avif" => "AVIF image",
        "pdf" => "PDF document",
        _ => "Image",
    }
}

#[cfg(windows)]
mod platform {
    use super::{type_name, AssocStatus, REGISTERED_EXTS};
    use winreg::enums::{HKEY_CURRENT_USER, REG_NONE};
    use winreg::{RegKey, RegValue};

    const APP_KEY: &str = "Software\\Classes\\Applications\\Previu.exe";
    const CAPS_KEY: &str = "Software\\Previu\\Capabilities";

    fn open_command(exe: &str) -> String {
        format!("\"{exe}\" \"%1\"")
    }

    fn icon(exe: &str) -> String {
        format!("\"{exe}\",0")
    }

    /// Icon for one file type. Falls back to the app icon when the .ico is not
    /// next to the executable (for example in `npm run app` development builds).
    fn file_icon(exe: &str, ext: &str) -> String {
        let name = if ext == "pdf" { "pdf.ico" } else { "image.ico" };
        let path = std::path::Path::new(exe)
            .parent()
            .map(|dir| dir.join("filetypes").join(name));
        match path {
            Some(p) if p.exists() => format!("\"{}\"", p.display()),
            _ => icon(exe),
        }
    }

    pub fn register() -> Result<AssocStatus, String> {
        let exe = std::env::current_exe()
            .map_err(|e| format!("cannot locate the running executable: {e}"))?;
        let exe = exe.to_string_lossy().into_owned();
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        let fail = |e: std::io::Error| format!("cannot write to the registry: {e}");

        for ext in REGISTERED_EXTS {
            let prog_id = format!("Previu.{ext}");

            let (key, _) = hkcu
                .create_subkey(format!("Software\\Classes\\{prog_id}"))
                .map_err(fail)?;
            key.set_value("", &type_name(ext)).map_err(fail)?;
            key.set_value("FriendlyTypeName", &type_name(ext)).map_err(fail)?;

            let (icon_key, _) = hkcu
                .create_subkey(format!("Software\\Classes\\{prog_id}\\DefaultIcon"))
                .map_err(fail)?;
            icon_key.set_value("", &file_icon(&exe, ext)).map_err(fail)?;

            let (cmd_key, _) = hkcu
                .create_subkey(format!("Software\\Classes\\{prog_id}\\shell\\open\\command"))
                .map_err(fail)?;
            cmd_key.set_value("", &open_command(&exe)).map_err(fail)?;

            // Listing in the shell's "Open with" menu. REG_NONE with an empty
            // payload is the documented shape for an OpenWithProgids entry.
            let (open_with, _) = hkcu
                .create_subkey(format!("Software\\Classes\\.{ext}\\OpenWithProgids"))
                .map_err(fail)?;
            open_with
                .set_raw_value(
                    &prog_id,
                    &RegValue {
                        bytes: Vec::new(),
                        vtype: REG_NONE,
                    },
                )
                .map_err(fail)?;

            let (supported, _) = hkcu
                .create_subkey(format!("{APP_KEY}\\SupportedTypes"))
                .map_err(fail)?;
            supported.set_value(&format!(".{ext}"), &"").map_err(fail)?;

            let (caps, _) = hkcu
                .create_subkey(format!("{CAPS_KEY}\\FileAssociations"))
                .map_err(fail)?;
            caps.set_value(&format!(".{ext}"), &prog_id).map_err(fail)?;
        }

        let (app, _) = hkcu.create_subkey(APP_KEY).map_err(fail)?;
        app.set_value("FriendlyAppName", &"Previu").map_err(fail)?;

        let (app_icon, _) = hkcu
            .create_subkey(format!("{APP_KEY}\\DefaultIcon"))
            .map_err(fail)?;
        app_icon.set_value("", &icon(&exe)).map_err(fail)?;

        let (app_cmd, _) = hkcu
            .create_subkey(format!("{APP_KEY}\\shell\\open\\command"))
            .map_err(fail)?;
        app_cmd.set_value("", &open_command(&exe)).map_err(fail)?;

        // Capabilities are what make the app appear under Settings > Default apps.
        let (caps, _) = hkcu.create_subkey(CAPS_KEY).map_err(fail)?;
        caps.set_value("ApplicationName", &"Previu").map_err(fail)?;
        caps.set_value(
            "ApplicationDescription",
            &"Lightweight image and PDF viewer",
        )
        .map_err(fail)?;
        caps.set_value("ApplicationIcon", &icon(&exe)).map_err(fail)?;

        let (registered, _) = hkcu
            .create_subkey("Software\\RegisteredApplications")
            .map_err(fail)?;
        registered
            .set_value("Previu", &CAPS_KEY)
            .map_err(fail)?;

        // Tell Explorer that file associations changed so it reloads the icons.
        // `SHCNE_ASSOCCHANGED` is a u32 constant but the exported function takes
        // a plain i32, so the value is cast rather than converted at runtime.
        unsafe {
            windows_sys::Win32::UI::Shell::SHChangeNotify(
                windows_sys::Win32::UI::Shell::SHCNE_ASSOCCHANGED as i32,
                windows_sys::Win32::UI::Shell::SHCNF_IDLIST,
                std::ptr::null(),
                std::ptr::null(),
            );
        }

        Ok(status())
    }

    pub fn status() -> AssocStatus {
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        let registered = hkcu.open_subkey(APP_KEY).is_ok();

        let default_for = REGISTERED_EXTS
            .iter()
            .filter(|ext| {
                let path = format!(
                    "Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\FileExts\\.{ext}\\UserChoice"
                );
                hkcu.open_subkey(path)
                    .and_then(|key| key.get_value::<String, _>("ProgId"))
                    .map(|prog_id| prog_id == format!("Previu.{ext}"))
                    .unwrap_or(false)
            })
            .map(|ext| format!(".{ext}"))
            .collect();

        AssocStatus {
            registered,
            default_for,
            supported: REGISTERED_EXTS.iter().map(|e| format!(".{e}")).collect(),
        }
    }

    pub fn open_default_apps() -> Result<(), String> {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;

        // `ms-settings:` is a ShellExecute verb, reachable through `start`.
        std::process::Command::new("cmd.exe")
            .args([
                "/C",
                "start",
                "",
                "ms-settings:defaultapps?registeredAppUser=Previu",
            ])
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .map(|_| ())
            .map_err(|e| format!("cannot open Windows Settings: {e}"))
    }
}

#[cfg(not(windows))]
mod platform {
    use super::AssocStatus;

    pub fn register() -> Result<AssocStatus, String> {
        Err("file association setup is only implemented for Windows".into())
    }

    pub fn status() -> AssocStatus {
        AssocStatus {
            registered: false,
            default_for: Vec::new(),
            supported: Vec::new(),
        }
    }

    pub fn open_default_apps() -> Result<(), String> {
        Err("file association setup is only implemented for Windows".into())
    }
}

pub use platform::{open_default_apps, register, status};
