# Previu

<p align="center">
  <img src="previu-brand.png" alt="Previu" width="150">
</p>

A small, fast image and PDF viewer for Windows, in the spirit of macOS Preview.
Built with [Tauri 2](https://tauri.app) on the WebView2 runtime that ships with
Windows, so the app is a few megabytes rather than a few hundred.

## Install

Run the installer:

```
src-tauri/target/release/bundle/nsis/Previu_0.1.0_x64-setup.exe
```

It installs for the current user only — no admin prompt — into
`%LOCALAPPDATA%\Previu`, with a Start-menu shortcut. Needs Windows 10 or 11 with
the WebView2 runtime. The installer is unsigned, so SmartScreen asks once.

Windows will not let an app take over a file type on its own: after installing,
use `⋯ › Set as default viewer…` and confirm the choice in Settings.

## Features

- Images: PNG, JPEG, JFIF, GIF, WebP, BMP, ICO, SVG, AVIF
- PDFs rendered with pdf.js, with a thumbnail sidebar
- Zoom, pan, fit width, fit page, actual size
- The rest of the folder in a Files tab, with a name filter and sorting
- Rotation and flips for images, saved as a copy — the original is never touched
- Presentation mode: full screen, page fitted, arrows or a clicker to advance
- Opens the file it was launched with, and forwards paths to the running window

## Keyboard

| | |
|---|---|
| `Ctrl`+`O` | Open a file |
| `←` / `→` | Page in a PDF, otherwise previous / next file |
| `Ctrl`+`←` / `Ctrl`+`→` | Previous / next file |
| `Home` / `End` | First / last page or file |
| `Ctrl`+`+`, `Ctrl`+`-`, `Ctrl`+wheel | Zoom |
| `Ctrl`+`0` / `Ctrl`+`1` | Fit page / actual size |
| `R` / `Shift`+`R` | Rotate right / left |
| `H` / `V` | Flip horizontal / vertical |
| `Ctrl`+`S` | Save a rotated or flipped copy |
| `F` / `F11` | Present full screen |
| `Esc` | Leave the presentation |
| `T` | Show or hide the sidebar |

## Build

Needs Node.js 20.19+ or 22.12+, Rust through [rustup](https://rustup.rs), and a C
toolchain — MSVC (Visual Studio Build Tools) or MinGW-w64.

```sh
npm install
npm run app          # development
npm run app:build    # release build plus the NSIS installer
```

Both scripts run through `scripts/tauri.mjs`, which finds a MinGW toolchain and
keeps cargo's caches off the system drive; its comments cover the search order
and the linker manifest workaround. Plain `npx tauri build` works too.

## Icons

`brand/previu-icon.png` is the icon master — `previu.png` cropped to its artwork
and squared, so the drawing fills the tile. `previu-brand.png` is the tile above.
Regenerate the set with:

```sh
npm run tauri -- icon brand/previu-icon.png -o src-tauri/icons
```

## Limits

- PDF pages are drawn to canvases, so their text cannot be selected or searched.
- PDFs cannot be rotated, and the Files tab shows the folder as it was when the
  document was opened.
- A rotated GIF, SVG or AVIF is written out as PNG.
