import { GlobalWorkerOptions, getDocument } from "pdfjs-dist";
import type { PDFDocumentProxy, RenderTask } from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

import { clamp, el } from "../dom";
import type { Doc } from "../types";
import type { PdfLayer, Size } from "./types";

GlobalWorkerOptions.workerSrc = workerUrl;

/**
 * pdf.js resolves fonts, CMaps and its WASM decoders at render time. They are
 * copied out of `pdfjs-dist` into `public/pdfjs` by `scripts/pdfjs-assets.mjs`,
 * so the app never reaches for a CDN.
 */
const ASSET_BASE = new URL("pdfjs/", document.baseURI).href;

/** Keeps the set of rasterized pages bounded on documents with hundreds of them. */
const MAX_LIVE_PAGES = 24;

/** Width of a sidebar thumbnail in CSS pixels; must match `.pdf-thumb canvas`. */
export const THUMBNAIL_WIDTH = 132;

/** Gap between stacked pages; must match `.pdf-stack` in the stylesheet. */
const PAGE_GAP = 12;

interface PageSlot {
  box: HTMLDivElement;
  canvas: HTMLCanvasElement;
  /** Measured page size at 100%, overriding the page-1 default when it differs. */
  size: Size | null;
  /** Zoom the canvas currently holds, or null when nothing is rasterized. */
  renderedAt: number | null;
  task: RenderTask | null;
}

const nextFrame = () => new Promise(requestAnimationFrame);

export async function createPdfLayer(doc: Doc, stage: HTMLElement): Promise<PdfLayer> {
  const loadingTask = getDocument({
    url: doc.url,
    wasmUrl: `${ASSET_BASE}wasm/`,
    cMapUrl: `${ASSET_BASE}cmaps/`,
    cMapPacked: true,
    standardFontDataUrl: `${ASSET_BASE}standard_fonts/`,
    iccUrl: `${ASSET_BASE}iccs/`,
  });
  const pdf: PDFDocumentProxy = await loadingTask.promise;

  const firstPage = await pdf.getPage(1);
  const firstViewport = firstPage.getViewport({ scale: 1 });
  const base: Size = { width: firstViewport.width, height: firstViewport.height };

  const stack = el("div", { class: "pdf-stack" });
  const slots: PageSlot[] = [];

  for (let number = 1; number <= pdf.numPages; number += 1) {
    const canvas = el("canvas", { class: "pdf-canvas" });
    const box = el("div", { class: "pdf-page", "data-page": String(number) }, [canvas]);
    stack.append(box);
    slots.push({ box, canvas, size: null, renderedAt: null, task: null });
  }

  let zoom = 1;
  /** Bumped on every zoom change so in-flight renders can tell they are stale. */
  let generation = 0;
  let page = 1;
  let destroyed = false;

  const pageListeners = new Set<(page: number) => void>();

  function sizeOf(slot: PageSlot): Size {
    return slot.size ?? base;
  }

  function layout(): void {
    let widest = 0;
    for (const slot of slots) {
      const size = sizeOf(slot);
      const width = size.width * zoom;
      if (width > widest) widest = width;
      slot.box.style.width = `${width}px`;
      slot.box.style.height = `${size.height * zoom}px`;
    }

    // The stack gets an explicit width so the parent's `max-content` resolves in
    // one pass. Left to derived sizing, the container's width would depend on
    // the pages and each page's stretched width on the container, and the
    // browser would report the pre-zoom box until the next frame -- which is
    // precisely the box the cursor-anchored zoom reads when it rescales.
    stack.style.width = `${widest}px`;
  }

  function release(slot: PageSlot): void {
    slot.task?.cancel();
    slot.task = null;
    // Dropping the backing store is what actually frees the memory: a 1x1
    // canvas still occupies its slot in the layout without retaining pixels.
    slot.canvas.width = 1;
    slot.canvas.height = 1;
    slot.renderedAt = null;
    slot.box.classList.remove("is-rendered");
  }

  /** Drops canvases farthest from the current page once too many are live. */
  function trim(): void {
    const live = slots
      .map((slot, index) => ({ slot, index }))
      .filter((entry) => entry.slot.renderedAt !== null);
    if (live.length <= MAX_LIVE_PAGES) return;

    live
      .sort((a, b) => Math.abs(b.index - (page - 1)) - Math.abs(a.index - (page - 1)))
      .slice(0, live.length - MAX_LIVE_PAGES)
      .forEach((entry) => release(entry.slot));
  }

  async function render(index: number): Promise<void> {
    const slot = slots[index];
    if (!slot || destroyed || slot.renderedAt === zoom || slot.task) return;

    const epoch = generation;
    const scale = zoom;
    let task: RenderTask | null = null;
    try {
      const rendered = await pdf.getPage(index + 1);
      if (destroyed || epoch !== generation) return;

      const unscaled = rendered.getViewport({ scale: 1 });
      if (Math.abs(unscaled.width - base.width) > 0.5) {
        slot.size = { width: unscaled.width, height: unscaled.height };
        layout();
      }

      // Rasterizing above the display's density costs memory without looking better.
      const density = clamp(window.devicePixelRatio || 1, 1, 2);
      const viewport = rendered.getViewport({ scale: scale * density });
      const width = Math.max(1, Math.floor(viewport.width));
      const height = Math.max(1, Math.floor(viewport.height));

      slot.canvas.width = width;
      slot.canvas.height = height;
      slot.canvas.style.width = `${width / density}px`;
      slot.canvas.style.height = `${height / density}px`;

      const context = slot.canvas.getContext("2d");
      if (!context) return;

      task = rendered.render({ canvas: slot.canvas, canvasContext: context, viewport });
      slot.task = task;
      await task.promise;
      if (destroyed || epoch !== generation) return;

      slot.renderedAt = scale;
      slot.box.classList.add("is-rendered");
      trim();
    } catch {
      // Cancellation is the normal outcome while zooming or scrolling quickly.
    } finally {
      // Only clear our own task: a zoom change may have replaced it already, and
      // clearing theirs would leave an uncancellable render writing to a canvas
      // that a newer render has since resized.
      if (slot.task === task) slot.task = null;
    }
  }

  /** Pages the observer currently reports as visible, used to repaint after a rescale. */
  const inView = new Set<number>();

  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        const index = Number((entry.target as HTMLElement).dataset.page) - 1;
        if (!Number.isFinite(index)) continue;
        if (!entry.isIntersecting) {
          inView.delete(index);
          continue;
        }
        inView.add(index);
        void render(index);
      }
    },
    // One viewport of lead time keeps the next page ready before it scrolls in.
    { root: stage, rootMargin: "100% 0px" },
  );
  for (const slot of slots) observer.observe(slot.box);

  layout();

  function currentPage(): number {
    const bounds = stage.getBoundingClientRect();
    const middle = bounds.top + stage.clientHeight / 2;

    // Pages are laid out top to bottom, so their bottom edges are monotonic and
    // the first one past the midpoint can be bisected instead of scanned. This
    // runs on every scroll frame, including on thousand-page documents.
    let low = 0;
    let high = slots.length - 1;
    let found = slots.length;
    while (low <= high) {
      const middleIndex = (low + high) >> 1;
      if (slots[middleIndex]!.box.getBoundingClientRect().bottom > middle) {
        found = middleIndex + 1;
        high = middleIndex - 1;
      } else {
        low = middleIndex + 1;
      }
    }
    return found;
  }

  let scrollQueued = false;
  function onScroll(): void {
    if (scrollQueued) return;
    scrollQueued = true;
    void nextFrame().then(() => {
      scrollQueued = false;
      const next = currentPage();
      if (next === page) return;
      page = next;
      for (const listener of pageListeners) listener(page);
    });
  }
  stage.addEventListener("scroll", onScroll, { passive: true });

  return {
    element: stack,
    pageCount: pdf.numPages,

    /** Unscaled page size: the caller needs it to compute a zoom to fit. */
    baseSize(): Size {
      return { ...base };
    },

    setZoom(next: number): void {
      if (Math.abs(next - zoom) < 1e-6) return;
      zoom = next;
      generation += 1;
      for (const slot of slots) release(slot);
      layout();

      // Releasing drops every canvas, and the observer only reports changes in
      // intersection: a page that stays in view across the rescale never fires
      // again, so it would sit blank until it scrolled out and back. Ask for the
      // visible ones again, which is what makes zooming repaint at all.
      for (const index of inView) void render(index);
    },

    currentPage,

    goToPage(target: number): void {
      const box = slots[clamp(Math.round(target), 1, slots.length) - 1]?.box;
      if (!box) return;
      const bounds = box.getBoundingClientRect();
      const offset = bounds.top - stage.getBoundingClientRect().top;
      // The strip above a page only earns its place when the page leaves room
      // for it; a page as tall as the stage would otherwise lose its top edge.
      const gap = bounds.height + PAGE_GAP <= stage.clientHeight ? PAGE_GAP : 0;
      stage.scrollTop += offset - gap;
    },

    onPageChange(listener: (next: number) => void): () => void {
      pageListeners.add(listener);
      return () => {
        pageListeners.delete(listener);
      };
    },

    async renderThumbnail(number: number, canvas: HTMLCanvasElement): Promise<void> {
      const rendered = await pdf.getPage(number);
      const unscaled = rendered.getViewport({ scale: 1 });
      if (!unscaled.width) return;

      const density = clamp(window.devicePixelRatio || 1, 1, 2);
      const viewport = rendered.getViewport({
        scale: (THUMBNAIL_WIDTH / unscaled.width) * density,
      });
      canvas.width = Math.max(1, Math.floor(viewport.width));
      canvas.height = Math.max(1, Math.floor(viewport.height));
      canvas.style.width = `${Math.floor(viewport.width / density)}px`;
      canvas.style.height = `${Math.floor(viewport.height / density)}px`;

      const context = canvas.getContext("2d");
      if (!context) return;
      await rendered.render({ canvas, canvasContext: context, viewport }).promise;
    },

    destroy(): void {
      destroyed = true;
      generation += 1;
      observer.disconnect();
      stage.removeEventListener("scroll", onScroll);
      pageListeners.clear();
      for (const slot of slots) release(slot);
      void loadingTask.destroy();
    },
  };
}
