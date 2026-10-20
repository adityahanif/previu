import { clamp, el, svgIcon } from "../dom";
import type { PdfLayer } from "../viewer/types";
import type { Doc, ViewState } from "../types";

export type SidebarTab = "pages" | "files";

/** Order the Files tab can list a folder in. */
type FileSort = "name-asc" | "name-desc" | "newest" | "oldest";

/** Natural, case-insensitive order, so `page2` sorts before `page10`. */
const NAMES = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

const SORTS: { value: FileSort; label: string }[] = [
  { value: "name-asc", label: "Name A–Z" },
  { value: "name-desc", label: "Name Z–A" },
  { value: "newest", label: "Newest first" },
  { value: "oldest", label: "Oldest first" },
];

export interface SidebarActions {
  selectTab(tab: SidebarTab): void;
  goToPage(page: number): void;
  openSibling(index: number): void;
}

export interface SidebarState {
  open: boolean;
  tab: SidebarTab;
  doc: Doc | null;
  siblings: Doc[];
  index: number;
  view: ViewState;
  pdf: PdfLayer | null;
}

export interface Sidebar {
  element: HTMLElement;
  update(state: SidebarState): void;
}

export function createSidebar(actions: SidebarActions): Sidebar {
  const pagesTab = el("button", {
    class: "sidebar-tab",
    type: "button",
    text: "Pages",
    onclick: () => actions.selectTab("pages"),
  });
  const filesTab = el("button", {
    class: "sidebar-tab",
    type: "button",
    text: "Files",
    onclick: () => actions.selectTab("files"),
  });

  const pagesList = el("div", { class: "sidebar-list" });
  const filesList = el("div", { class: "sidebar-list" });

  const filesSearch = el("input", {
    class: "files-search",
    type: "search",
    placeholder: "Filter by name",
    "aria-label": "Filter files by name",
    autocomplete: "off",
    spellcheck: "false",
  });
  const sortSelect = el(
    "select",
    { class: "files-sort", "aria-label": "Sort files" },
    SORTS.map((entry) => el("option", { value: entry.value, text: entry.label })),
  );
  const filesEmpty = el("p", { class: "files-empty", text: "No files match", hidden: true });

  // The list is one scrolling pane, so the controls sit in their own grid rather
  // than inside it, where they would scroll away.
  const filesPanel = el("div", { class: "files-panel" }, [
    el("div", { class: "files-controls" }, [filesSearch, sortSelect]),
    filesEmpty,
    filesList,
  ]);

  const element = el("aside", { id: "sidebar", class: "sidebar" }, [
    el("div", { class: "sidebar-tabs" }, [pagesTab, filesTab]),
    pagesList,
    filesPanel,
  ]);

  /** Identity of the document whose thumbnails are currently built. */
  let built: { pdf: PdfLayer; count: number } | null = null;
  let thumbnails: HTMLButtonElement[] = [];
  let observer: IntersectionObserver | null = null;

  /** Filter text and sort order, owned here so typing never waits on the store. */
  let query = "";
  let sort: FileSort = "name-asc";
  /** What the list currently shows; null forces the next pass to apply. */
  let applied: { query: string; sort: FileSort } | null = null;
  let lastState: SidebarState | null = null;

  function clearThumbnails(): void {
    observer?.disconnect();
    observer = null;
    thumbnails = [];
    built = null;
    pagesList.replaceChildren();
  }

  function buildThumbnails(pdf: PdfLayer): void {
    clearThumbnails();
    built = { pdf, count: pdf.pageCount };

    // Only pages near the visible strip are rasterized, so a 900-page document
    // costs the same to open as a 3-page one.
    observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const thumb = entry.target as HTMLButtonElement;
          if (thumb.dataset.done === "1") continue;
          thumb.dataset.done = "1";
          const canvas = thumb.querySelector("canvas");
          const page = Number(thumb.dataset.page);
          if (canvas instanceof HTMLCanvasElement && Number.isFinite(page)) {
            void pdf.renderThumbnail(page, canvas).catch(() => {
              // A page that fails to rasterize keeps its blank placeholder.
            });
          }
        }
      },
      { root: pagesList, rootMargin: "256px 0px" },
    );

    for (let page = 1; page <= pdf.pageCount; page += 1) {
      const canvas = el("canvas");
      const thumb = el(
        "button",
        { class: "pdf-thumb", type: "button", "data-page": String(page) },
        [canvas, el("span", { class: "pdf-thumb-label", text: String(page) })],
      );
      thumb.addEventListener("click", () => actions.goToPage(page));
      pagesList.append(thumb);
      thumbnails.push(thumb);
      observer.observe(thumb);
    }
  }

  /** Sibling indices in the order the list should show them. */
  function displayOrder(docs: Doc[]): number[] {
    const order = docs.map((_, index) => index);
    order.sort((a, b) => {
      if (sort === "newest" || sort === "oldest") {
        const byDate = docs[a]!.modified - docs[b]!.modified;
        if (byDate) return (sort === "newest" ? -1 : 1) * byDate;
      }
      const byName = NAMES.compare(docs[a]!.name, docs[b]!.name);
      return sort === "name-desc" ? -byName : byName;
    });
    return order;
  }

  function applyFilterAndSort(docs: Doc[]): void {
    const needle = query.trim().toLowerCase();
    const entries = [...filesList.children] as HTMLElement[];
    const byIndex = new Map(entries.map((entry) => [Number(entry.dataset.index), entry]));

    let shown = 0;
    for (const index of displayOrder(docs)) {
      const entry = byIndex.get(index);
      if (!entry) continue;
      const matches = !needle || docs[index]!.name.toLowerCase().includes(needle);
      entry.hidden = !matches;
      if (matches) shown += 1;
      filesList.append(entry);
    }

    filesEmpty.hidden = shown > 0;
    applied = { query, sort };
  }

  function renderFiles(state: SidebarState): void {
    const signature = state.siblings.map((doc) => doc.path).join("\u0000");

    if (filesList.dataset.signature !== signature) {
      filesList.dataset.signature = signature;
      // A different folder starts unfiltered: a filter typed for the last one
      // would otherwise hide the file the user just opened from Explorer.
      query = "";
      filesSearch.value = "";
      applied = null;

      filesList.replaceChildren(
        ...state.siblings.map((doc, index) => {
          const entry = el("button", {
            class: "file-entry",
            type: "button",
            title: doc.name,
            "data-index": String(index),
          });
          entry.append(
            svgIcon(doc.kind === "pdf" ? "file" : "image", 14),
            el("span", { class: "file-name", text: doc.name }),
          );
          entry.addEventListener("click", () => actions.openSibling(index));
          return entry;
        }),
      );
    }

    if (!applied || applied.query !== query || applied.sort !== sort) {
      applyFilterAndSort(state.siblings);
    }

    for (const entry of filesList.children) {
      entry.classList.toggle(
        "is-current",
        Number((entry as HTMLElement).dataset.index) === state.index,
      );
    }
  }

  filesSearch.addEventListener("input", () => {
    query = filesSearch.value;
    if (lastState) renderFiles(lastState);
  });

  sortSelect.addEventListener("change", () => {
    sort = sortSelect.value as FileSort;
    if (lastState) renderFiles(lastState);
  });

  // Escape clears the filter before it reaches the window handler, which would
  // otherwise close whatever menu is open behind the panel.
  filesSearch.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || !filesSearch.value) return;
    event.stopPropagation();
    filesSearch.value = "";
    query = "";
    if (lastState) renderFiles(lastState);
  });

  return {
    element,
    update(state) {
      lastState = state;
      element.hidden = !state.open;
      if (!state.open) return;

      const showPages = state.doc?.kind === "pdf" && state.tab === "pages";
      pagesTab.classList.toggle("is-active", showPages);
      filesTab.classList.toggle("is-active", !showPages);
      pagesList.hidden = !showPages;
      filesPanel.hidden = showPages;

      if (showPages && state.pdf) {
        if (built?.pdf !== state.pdf || built.count !== state.pdf.pageCount) {
          buildThumbnails(state.pdf);
        }
        const current = clamp(state.view.page, 1, thumbnails.length);
        for (const [index, thumb] of thumbnails.entries()) {
          thumb.classList.toggle("is-current", index === current - 1);
        }
      } else if (!showPages) {
        clearThumbnails();
        renderFiles(state);
      }
    },
  };
}
