// Copies the pdf.js runtime assets that are resolved at render time (standard fonts
// and CJK CMaps) into `public/pdfjs` so they ship with the app and no CDN is needed.
//
// Runs from `postinstall` and from the `build` npm script. Safe to re-run.
import { cp, mkdir, rm, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const require = createRequire(import.meta.url);

let pdfjsDir;
try {
  pdfjsDir = dirname(require.resolve("pdfjs-dist/package.json"));
} catch {
  console.error("[pdfjs-assets] pdfjs-dist is not installed yet; nothing to copy.");
  process.exit(0);
}

const SOURCES = [
  { name: "standard_fonts", required: true },
  // Rasterized page content for scanned documents (jbig2, JPEG2000) and colour
  // management. Without these, scans render as blank pages.
  {
    name: "wasm",
    required: false,
    // PDF JavaScript is disabled, so the QuickJS runtime would be dead weight.
    skip: ["quickjs-eval.wasm", "quickjs-eval.js"],
  },
  { name: "iccs", required: false },
  // CJK encodings; only fetched for documents that use them.
  { name: "cmaps", required: false },
];

const dest = join(root, "public", "pdfjs");
await mkdir(dest, { recursive: true });

for (const { name, required, skip } of SOURCES) {
  const from = join(pdfjsDir, name);
  const to = join(dest, name);
  try {
    const info = await stat(from);
    if (!info.isDirectory()) throw new Error("not a directory");
  } catch {
    const message = `[pdfjs-assets] missing ${name} in pdfjs-dist`;
    if (required) {
      console.error(message);
      process.exit(1);
    }
    console.warn(`${message}; skipping.`);
    continue;
  }
  await rm(to, { recursive: true, force: true });
  await cp(from, to, {
    recursive: true,
    filter: (source) => !skip?.includes(basename(source)),
  });
}

console.log(`[pdfjs-assets] copied pdf.js assets into ${dest}`);
