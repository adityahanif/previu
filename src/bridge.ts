// Single seam between the UI and its host. Everything the viewer needs from the
// outside world goes through here, so the same UI can run inside Tauri and in a
// plain browser tab (`npm run dev`) for fast iteration on rendering.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";

import type { Doc, DocKind, Opened } from "./types";

export const isNative =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export const BROWSER_FOLDER = "browser preview";

const IMAGE_EXTS = [
  "png", "jpg", "jpeg", "jfif", "jpe", "gif", "webp", "bmp", "ico", "svg", "avif",
];

export function kindOfExtension(ext: string): DocKind | null {
  const lower = ext.toLowerCase();
  if (lower === "pdf") return "pdf";
  return IMAGE_EXTS.includes(lower) ? "image" : null;
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot < 0 ? "" : name.slice(dot + 1).toLowerCase();
}

export interface AppInfo {
  version: string;
  platform: string;
}

export interface AssocStatus {
  registered: boolean;
  defaultFor: string[];
  supported: string[];
}

const FILE_FILTERS = [
  {
    name: "Images and PDFs",
    extensions: [...IMAGE_EXTS, "pdf"],
  },
  { name: "Images", extensions: IMAGE_EXTS },
  { name: "PDF", extensions: ["pdf"] },
];

/** Documents picked in browser mode, keyed by the pseudo-path we hand the UI. */
const browserDocs = new Map<string, Doc>();

function blobDocs(files: File[]): Opened | null {
  const docs: Doc[] = [];
  for (const file of files) {
    const ext = extensionOf(file.name);
    const kind = kindOfExtension(ext);
    if (!kind) continue;
    const doc: Doc = {
      path: file.name,
      name: file.name,
      url: URL.createObjectURL(file),
      kind,
      ext,
      size: file.size,
      modified: file.lastModified,
    };
    browserDocs.set(doc.path, doc);
    docs.push(doc);
  }
  if (!docs.length) return null;
  return { folder: BROWSER_FOLDER, siblings: docs, index: 0 };
}

function pickFiles(): Promise<Opened | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = true;
    input.accept = [...IMAGE_EXTS, "pdf"].map((e) => `.${e}`).join(",");
    input.addEventListener("change", () => {
      resolve(input.files ? blobDocs([...input.files]) : null);
    });
    // `cancel` is not universally supported, so also resolve if the picker is
    // dismissed and focus returns without a selection.
    input.addEventListener("cancel", () => resolve(null));
    input.click();
  });
}

export const bridge = {
  isNative,

  async appInfo(): Promise<AppInfo> {
    if (!isNative) return { version: "dev", platform: "browser" };
    return invoke<AppInfo>("app_info");
  },

  /** Native only: resolve an absolute path into a document plus its siblings. */
  async openDocument(path: string): Promise<Opened> {
    if (!isNative) {
      const doc = browserDocs.get(path);
      if (!doc) throw new Error(`${path} is not open`);
      const siblings = [...browserDocs.values()];
      return { folder: BROWSER_FOLDER, siblings, index: siblings.indexOf(doc) };
    }
    return invoke<Opened>("open_document", { path });
  },

  /** Open a file chooser and return the chosen document with its siblings. */
  async chooseDocument(): Promise<Opened | null> {
    if (!isNative) return pickFiles();

    const picked = await openDialog({ multiple: false, directory: false, filters: FILE_FILTERS });
    if (typeof picked !== "string") return null;
    return bridge.openDocument(picked);
  },

  async takePendingOpen(): Promise<string | null> {
    if (!isNative) return null;
    return invoke<string | null>("take_pending_open");
  },

  /** Fired when a second launch forwards a path to the running window. */
  async onOpenFile(callback: (path: string) => void): Promise<() => void> {
    if (!isNative) return () => {};
    return listen<string>("previu:open-file", (event) => callback(event.payload));
  },

  /** Reports dropped paths, and whether a drag is currently hovering the window. */
  async onDrop(handlers: {
    onDrop: (paths: string[]) => void;
    onHover: (active: boolean) => void;
  }): Promise<() => void> {
    if (!isNative) {
      // dragleave also fires when moving between child elements, so depth-count.
      let depth = 0;
      const over = (event: DragEvent) => {
        event.preventDefault();
        depth += 1;
        handlers.onHover(true);
      };
      const leave = () => {
        depth = Math.max(0, depth - 1);
        if (depth === 0) handlers.onHover(false);
      };
      const drop = (event: DragEvent) => {
        event.preventDefault();
        depth = 0;
        handlers.onHover(false);
        const opened = blobDocs([...(event.dataTransfer?.files ?? [])]);
        if (opened) handlers.onDrop(opened.siblings.map((doc) => doc.path));
      };
      window.addEventListener("dragenter", over);
      window.addEventListener("dragover", over);
      window.addEventListener("dragleave", leave);
      window.addEventListener("drop", drop);
      return () => {
        window.removeEventListener("dragenter", over);
        window.removeEventListener("dragover", over);
        window.removeEventListener("dragleave", leave);
        window.removeEventListener("drop", drop);
      };
    }

    return getCurrentWebview().onDragDropEvent((event) => {
      if (event.payload.type === "over" || event.payload.type === "enter") {
        handlers.onHover(true);
      } else if (event.payload.type === "leave") {
        handlers.onHover(false);
      } else if (event.payload.type === "drop") {
        handlers.onHover(false);
        handlers.onDrop(event.payload.paths);
      }
    });
  },

  async saveDialog(defaultName: string): Promise<string | null> {
    if (!isNative) return window.prompt("Save a copy as", defaultName);
    return saveDialog({ defaultPath: defaultName, filters: FILE_FILTERS });
  },

  /**
   * Native only: write `src` to `dest` with the viewer's rotation and flips baked
   * in. Browser mode falls back to a download so the preview stays usable.
   */
  async saveCopy(
    src: string,
    dest: string,
    rotation: number,
    flipH: boolean,
    flipV: boolean,
  ): Promise<void> {
    if (isNative) {
      await invoke("save_copy", { src, dest, rotation, flipH, flipV });
      return;
    }
    const doc = browserDocs.get(src);
    if (!doc) throw new Error("Source is no longer available");
    const link = document.createElement("a");
    link.href = doc.url;
    link.download = dest;
    link.click();
  },

  async assocStatus(): Promise<AssocStatus> {
    if (!isNative) return { registered: false, defaultFor: [], supported: [] };
    return invoke<AssocStatus>("assoc_status");
  },

  async registerAssoc(): Promise<AssocStatus> {
    if (!isNative) throw new Error("File association setup needs the desktop app");
    return invoke<AssocStatus>("register_assoc");
  },

  async openDefaultAppsSettings(): Promise<void> {
    if (!isNative) throw new Error("File association setup needs the desktop app");
    await invoke("open_default_apps_settings");
  },

  async reveal(path: string): Promise<void> {
    if (!isNative) return;
    await revealItemInDir(path);
  },

  async setTitle(title: string): Promise<void> {
    if (!isNative) {
      document.title = title;
      return;
    }
    await getCurrentWindow().setTitle(title);
  },

  /** Native window full screen, or the document's where there is no window. */
  async setFullscreen(on: boolean): Promise<void> {
    if (!isNative) {
      if (on && !document.fullscreenElement) await document.documentElement.requestFullscreen();
      else if (!on && document.fullscreenElement) await document.exitFullscreen();
      return;
    }
    const window = getCurrentWindow();
    if ((await window.isFullscreen()) !== on) await window.setFullscreen(on);
  },

  async isFullscreen(): Promise<boolean> {
    if (!isNative) return Boolean(document.fullscreenElement);
    return getCurrentWindow().isFullscreen();
  },
};
