#!/usr/bin/env node
/**
 * Runs the Tauri CLI with a build environment that works on machines where the
 * system drive is tight, which is the situation this project was built in.
 *
 * Three environment values have to be redirected:
 *
 *   PATH       Tauri's build script embeds the app icon and manifest into the
 *              executable, which shells out to the C compiler. The `windows-gnu`
 *              toolchain ships only a stub linker, so a real MinGW-w64 binutils
 *              (dlltool, windres, as) must be reachable.
 *   CARGO_HOME The crate registry and its extracted sources run to roughly a
 *              gigabyte, which is more than a full system drive can take.
 *   TEMP/TMP   rustc and the linker stage large intermediates there.
 *
 * One file is placed as well: the driver's own application manifest has to be
 * displaced so it does not collide with Tauri's (see `writeManifestShim`).
 *
 * Every value is only defaulted, never forced: an explicit setting in the
 * environment always wins, so CI and machines with a healthy C: are unaffected.
 *
 * Point PREVIU_TOOLCHAIN at a directory containing `mingw/` (plus optionally
 * `cargo-home/` and `tmp/`) to relocate all of it.
 */
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function firstExisting(candidates) {
  return candidates.find((candidate) => candidate && existsSync(candidate)) ?? null;
}

function toolchainRoot() {
  if (process.env.PREVIU_TOOLCHAIN) return process.env.PREVIU_TOOLCHAIN;

  const beside = join(root, ".toolchain");
  const shared = "D:\\previu-toolchain";
  // Prefer the shared root so several checkouts reuse one download.
  if (existsSync(join(shared, "mingw"))) return shared;
  return beside;
}

/** The `windows-gnu` toolchain's own binutils, which need `as`/`windres` from MinGW. */
function rustGnuBin() {
  const rustup = process.env.RUSTUP_HOME ?? (process.env.USERPROFILE ? join(process.env.USERPROFILE, ".rustup") : null);
  if (!rustup) return null;

  const toolchains = join(rustup, "toolchains");
  if (!existsSync(toolchains)) return null;

  for (const name of readdirSync(toolchains)) {
    if (!name.includes("windows-gnu")) continue;
    const bin = join(toolchains, name, "lib", "rustlib", "x86_64-pc-windows-gnu", "bin");
    if (existsSync(bin)) return bin;
  }
  return null;
}

/**
 * Writes an empty object named `default-manifest.o` for the driver to pick up.
 *
 * `windows-gnu` links its own application manifest into every executable via a
 * `%:if-exists(default-manifest.o%s)` spec in `gcc`'s `link` rules. Tauri embeds
 * one too, so `ld` ends up with two and prints
 * `.rsrc merge failure: multiple non-default manifests`, leaving which one
 * Windows reads down to resource ordering. The driver prefers a file of that
 * name found earlier on its search path, so an empty object takes the slot and
 * leaves Tauri's manifest as the only one in the image.
 *
 * The bytes are a bare COFF header: the AMD64 machine type, no sections. That
 * is all `ld` needs to accept the file and contribute nothing.
 */
function writeManifestShim(dir) {
  const file = join(dir, "default-manifest.o");
  mkdirSync(dir, { recursive: true });

  const header = Buffer.alloc(20);
  header.writeUInt16LE(0x8664, 0); // IMAGE_FILE_MACHINE_AMD64
  writeFileSync(file, header);

  return dir;
}

const toolchain = toolchainRoot();
const mingwBin = firstExisting([
  process.env.PREVIU_MINGW_BIN,
  join(toolchain, "mingw", "mingw64", "bin"),
  join(toolchain, "mingw", "bin"),
  "C:\\msys64\\mingw64\\bin",
]);

const gnuBin = rustGnuBin();
const env = { ...process.env };

// MinGW first: its `as` and `windres` are the ones `cc` will pick up. rustup's
// bin directory stays on PATH too, so `cargo` and its proxies still resolve.
//
// Windows spells this variable `Path`, and writing a second key called `PATH`
// alongside it leaves the child unable to resolve anything on either list, so
// the existing key is the one that gets extended.
const pathKey = Object.keys(env).find((key) => key.toUpperCase() === "PATH") ?? "PATH";
const prepend = [mingwBin, gnuBin].filter(Boolean);
if (prepend.length) env[pathKey] = [...prepend, env[pathKey] ?? ""].join(";");
else console.warn("[tauri] no MinGW binutils found; the build will only succeed with a C toolchain on PATH");

// Redirecting cargo's home also moves what it hands rustc as TEMP, so the two
// stay on the same drive as each other and as the target directory.
env.CARGO_HOME ??= join(toolchain, "cargo-home");
const tmp = join(toolchain, "tmp");
env.TEMP ??= tmp;
env.TMP ??= tmp;

// The trailing separator is what marks this as a directory for the driver.
env.PREVIU_MANIFEST_SHIM = `${writeManifestShim(join(tmp, "manifest-shim"))}\\`;

console.log(`[tauri] mingw      ${mingwBin ?? "(none found)"}`);
console.log(`[tauri] CARGO_HOME ${env.CARGO_HOME}`);
console.log(`[tauri] TEMP       ${env.TEMP}`);

const cli = join(root, "node_modules", "@tauri-apps", "cli", "tauri.js");
if (!existsSync(cli)) {
  console.error(`[tauri] ${cli} is missing; run \`npm install\` first.`);
  process.exit(1);
}

const child = spawn(process.execPath, [cli, ...process.argv.slice(2)], {
  stdio: "inherit",
  env,
});

// Forward the interrupt instead of dying first, so cargo can clean up its
// half-written artefacts rather than leaving them to poison the next build.
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => child.kill(signal));
}

child.on("exit", (code, signal) => {
  process.exit(signal ? 1 : (code ?? 0));
});
