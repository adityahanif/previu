import { el, formatBytes } from "../dom";
import type { Doc, ViewState } from "../types";

export interface StatusbarState {
  doc: Doc | null;
  folder: string | null;
  view: ViewState;
  /** Pixel dimensions once the viewer knows them, e.g. `1920 × 1080`. */
  dimensions: string | null;
  /** Transient note such as a load error; replaces the folder path. */
  message: string | null;
}

export interface Statusbar {
  element: HTMLElement;
  update(state: StatusbarState): void;
}

export function createStatusbar(): Statusbar {
  const name = el("span", { class: "status-name" });
  const meta = el("span", { class: "status-meta" });
  const right = el("span", { class: "status-right" });

  const element = el("footer", { id: "statusbar", class: "statusbar" }, [
    el("div", { class: "status-left" }, [name, meta]),
    right,
  ]);

  return {
    element,
    update(state) {
      const { doc, view, dimensions, message, folder } = state;
      name.textContent = doc?.name ?? "";

      const parts: string[] = [];
      if (dimensions) parts.push(dimensions);
      if (doc) parts.push(formatBytes(doc.size));
      if (doc?.kind === "pdf") {
        parts.push(`${view.pageCount} ${view.pageCount === 1 ? "page" : "pages"}`);
      }
      if (doc) parts.push(`${Math.round(view.zoom * 100)}%`);
      meta.textContent = parts.join("  ·  ");

      right.textContent = message ?? folder ?? "";
      right.title = folder ?? "";
      right.classList.toggle("is-error", message !== null);
    },
  };
}
