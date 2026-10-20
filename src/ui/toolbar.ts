import { button, el } from "../dom";
import type { Doc, ViewState } from "../types";
import { openMenu } from "./menu";

export interface ToolbarActions {
  toggleSidebar(): void;
  openFile(): void;
  previous(): void;
  next(): void;
  previousFile(): void;
  nextFile(): void;
  /** Jumps to a page in a PDF, or to a file in the folder, depending on context. */
  goTo(position: number): void;
  zoomIn(): void;
  zoomOut(): void;
  setZoom(zoom: number): void;
  setFit(mode: "width" | "page"): void;
  actualSize(): void;
  rotate(delta: number): void;
  flip(axis: "horizontal" | "vertical"): void;
  saveCopy(): void;
  findInDocument(): void;
  present(): void;
  reveal(): void;
  setDefaultApp(): void;
}

export interface ToolbarState {
  doc: Doc | null;
  index: number;
  count: number;
  view: ViewState;
  sidebarOpen: boolean;
  canRotate: boolean;
  busy: boolean;
}

export interface Toolbar {
  element: HTMLElement;
  update(state: ToolbarState): void;
}

const ZOOM_PRESETS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4];

export function createToolbar(actions: ToolbarActions): Toolbar {
  const sidebar = button({
    icon: "panel-left",
    label: "Show thumbnails",
    class: "toggle",
    onclick: () => actions.toggleSidebar(),
  });

  const open = button({
    icon: "folder-open",
    label: "Open a file",
    class: "tool-labeled",
    onclick: () => actions.openFile(),
  });
  open.append(el("span", { class: "tool-text", text: "Open" }));

  const previous = button({
    icon: "chevron-left",
    label: "Previous",
    onclick: () => actions.previous(),
  });
  const next = button({
    icon: "chevron-right",
    label: "Next",
    onclick: () => actions.next(),
  });

  const position = el("button", {
    class: "position",
    type: "button",
    text: "—",
    onclick: () => {
      const total = Number(position.dataset.count ?? "0");
      if (total <= 1) return;
      const unit = position.dataset.unit ?? "item";
      const answer = window.prompt(`Go to ${unit} (1-${total})`, position.dataset.index ?? "1");
      if (answer === null) return;
      const target = Number(answer);
      if (Number.isInteger(target) && target >= 1 && target <= total) actions.goTo(target);
    },
  });

  const zoomOut = button({
    icon: "zoom-out",
    label: "Zoom out",
    onclick: () => actions.zoomOut(),
  });
  const zoomLevel = el("button", {
    class: "zoom-level",
    type: "button",
    text: "100%",
    onclick: () =>
      openMenu(zoomLevel, [
        ...ZOOM_PRESETS.map((preset) => ({
          label: `${Math.round(preset * 100)}%`,
          onSelect: () => actions.setZoom(preset),
        })),
        { label: "Fit Width", separatorBefore: true, onSelect: () => actions.setFit("width") },
        { label: "Fit Page", onSelect: () => actions.setFit("page") },
        { label: "Actual Size", onSelect: () => actions.actualSize() },
      ]),
  });
  const zoomIn = button({
    icon: "zoom-in",
    label: "Zoom in",
    onclick: () => actions.zoomIn(),
  });

  const fitWidth = button({
    icon: "move-horizontal",
    label: "Fit width",
    onclick: () => actions.setFit("width"),
  });
  const fitPage = button({
    icon: "maximize",
    label: "Fit page",
    onclick: () => actions.setFit("page"),
  });
  const actualSize = button({
    icon: "scan",
    label: "Actual size",
    onclick: () => actions.actualSize(),
  });

  const rotateLeft = button({
    icon: "rotate-ccw",
    label: "Rotate left",
    onclick: () => actions.rotate(-90),
  });
  const rotateRight = button({
    icon: "rotate-cw",
    label: "Rotate right",
    onclick: () => actions.rotate(90),
  });
  const flipHorizontal = button({
    icon: "flip-h",
    label: "Flip horizontal",
    onclick: () => actions.flip("horizontal"),
  });
  const flipVertical = button({
    icon: "flip-v",
    label: "Flip vertical",
    onclick: () => actions.flip("vertical"),
  });

  const save = button({
    icon: "save",
    label: "Save a copy with changes applied",
    onclick: () => actions.saveCopy(),
  });

  const find = button({
    icon: "search",
    label: "Find in document",
    title: "Find in document (Ctrl+F)",
    onclick: () => actions.findInDocument(),
  });

  const present = button({
    icon: "present",
    label: "Start presentation",
    title: "Start presentation (F11)",
    onclick: () => actions.present(),
  });

  const more = button({
    icon: "info",
    label: "More actions",
    onclick: () =>
      openMenu(more, [
        { label: "Previous file", onSelect: () => actions.previousFile() },
        { label: "Next file", onSelect: () => actions.nextFile() },
        { label: "Reveal in Explorer", separatorBefore: true, onSelect: () => actions.reveal() },
        { label: "Set as default viewer…", onSelect: () => actions.setDefaultApp() },
      ]),
  });

  const element = el("header", { id: "toolbar", class: "toolbar" }, [
    el("div", { class: "toolbar-group" }, [
      sidebar,
      open,
      el("div", { class: "pill" }, [previous, position, next]),
    ]),
    el("div", { class: "toolbar-group toolbar-end" }, [
      el("div", { class: "pill" }, [zoomOut, zoomLevel, zoomIn]),
      el("div", { class: "pill" }, [fitWidth, fitPage, actualSize]),
      el("div", { class: "pill" }, [rotateLeft, rotateRight, flipHorizontal, flipVertical]),
      find,
      present,
      save,
      more,
    ]),
  ]);

  return {
    element,
    update(state) {
      const { doc, index, count, view } = state;
      const hasDoc = doc !== null;
      const pages = doc?.kind === "pdf" && view.pageCount > 1;

      sidebar.classList.toggle("is-active", state.sidebarOpen);
      sidebar.title = state.sidebarOpen ? "Hide sidebar" : "Show sidebar";

      previous.disabled = !hasDoc || index <= 0;
      next.disabled = !hasDoc || index >= count - 1;
      previous.title = pages ? "Previous page" : "Previous file";
      next.title = pages ? "Next page" : "Next file";

      const current = pages ? view.page : index + 1;
      const total = pages ? view.pageCount : count;
      position.textContent = hasDoc ? `${current} / ${total}` : "—";
      position.dataset.index = String(current);
      position.dataset.count = String(total);
      position.dataset.unit = pages ? "page" : "file";
      position.disabled = !hasDoc || total <= 1;

      zoomLevel.textContent = `${Math.round(view.zoom * 100)}%`;

      for (const control of [zoomOut, zoomIn, zoomLevel, fitWidth, fitPage, actualSize]) {
        control.disabled = !hasDoc;
      }
      for (const control of [rotateLeft, rotateRight, flipHorizontal, flipVertical]) {
        control.disabled = !hasDoc || !state.canRotate;
      }

      save.disabled = !hasDoc || doc.kind !== "image";
      find.disabled = !hasDoc || doc.kind !== "pdf";
      present.disabled = !hasDoc;
      more.disabled = !hasDoc;
      open.disabled = state.busy;
      element.classList.toggle("is-busy", state.busy);
    },
  };
}
