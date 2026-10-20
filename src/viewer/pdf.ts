import { GlobalWorkerOptions, TextLayer, getDocument } from "pdfjs-dist";
import type { PDFDocumentProxy, PDFPageProxy, RenderTask } from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

import { clamp, el } from "../dom";
import type { Doc } from "../types";
import type { FindHit, FindResult, PdfLayer, Size } from "./types";

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

/** Highlight names registered with the CSS Custom Highlight API. */
const FIND_ALL = "previu-find";
const FIND_CURRENT = "previu-find-current";

type TextContent = Awaited<ReturnType<PDFPageProxy["getTextContent"]>>;

interface PageSlot {
  box: HTMLDivElement;
  canvas: HTMLCanvasElement;
  /** Invisible glyph boxes over the canvas; this is what selection copies. */
  text: HTMLDivElement;
  /** Page text, fetched once and shared by rescales and by find. */
  content: TextContent | null;
  /** Text layer kept for its spans, which is how a match becomes a highlight. */
  textLayer: TextLayer | null;
  /** Zoom the text layer is laid out at, or null while one is being built. */
  textAt: number | null;
  textBuilding: number | null;
  /** Measured page size at 100%, overriding the page-1 default when it differs. */
  size: Size | null;
  /** Zoom the canvas currently holds, or null when nothing is rasterized. */
  renderedAt: number | null;
  task: RenderTask | null;
}

/** A stretch of one text node, offset into the page's concatenated text. */
interface TextPart {
  node: Text;
  start: number;
}

const nextFrame = () => new Promise(requestAnimationFrame);

/**
 * Lowercases and collapses whitespace so a query matches the way a reader sees
 * the page, and keeps a map from each surviving character back to its offset in
 * the raw string. Without that map a match could not be turned into a selection.
 */
function normalize(text: string): { text: string; map: number[] } {
  const out: string[] = [];
  const map: number[] = [];
  let gap = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]!;
    if (/\s/.test(char)) {
      gap = out.length > 0;
      continue;
    }
    if (gap) {
      out.push(" ");
      map.push(i);
      gap = false;
    }
    out.push(char.toLowerCase());
    map.push(i);
  }
  return { text: out.join(""), map };
}

/** Page text as pdf.js describes it, with a line break wherever it reports one. */
function textOf(content: TextContent): string {
  let out = "";
  for (const item of content.items) {
    if ("str" in item) out += item.str;
    if ("hasEOL" in item && item.hasEOL) out += "\n";
  }
  return out;
}

/** Counts non-overlapping matches of `needle` in already-normalized text. */
function countIn(text: string, needle: string): number {
  let count = 0;
  let at = text.indexOf(needle);
  while (at !== -1) {
    count += 1;
    at = text.indexOf(needle, at + needle.length);
  }
  return count;
}

/**
 * The text layer's runs in document order, joined the way the page reads: runs
 * on a new line are separated, runs on the same line are not, so a word split
 * across two runs still matches as one word.
 */
function domText(layer: TextLayer): { text: string; parts: TextPart[] } | null {
  let text = "";
  let previousTop: number | null = null;
  const parts: TextPart[] = [];

  for (const div of layer.textDivs) {
    const node = div.firstChild;
    if (!(node instanceof Text) || !node.data) continue;
    if (previousTop !== null && Math.abs(div.offsetTop - previousTop) > 1) text += "\n";
    previousTop = div.offsetTop;
    parts.push({ node, start: text.length });
    text += node.data;
  }

  return parts.length ? { text, parts } : null;
}

/** Turns an offset range in the joined text back into a DOM range. */
function rangeBetween(parts: TextPart[], start: number, end: number): Range | null {
  let from: { node: Text; offset: number } | null = null;
  let to: { node: Text; offset: number } | null = null;

  for (const part of parts) {
    const length = part.node.data.length;
    if (!from && start < part.start + length) {
      from = { node: part.node, offset: start - part.start };
    }
    if (end <= part.start + length) {
      to = { node: part.node, offset: end - part.start };
      break;
    }
  }
  if (!from || !to) return null;

  const range = document.createRange();
  range.setStart(from.node, clamp(from.offset, 0, from.node.data.length));
  range.setEnd(to.node, clamp(to.offset, 0, to.node.data.length));
  return range;
}

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
    const text = el("div", { class: "textLayer" });
    const box = el("div", { class: "pdf-page", "data-page": String(number) }, [canvas, text]);
    stack.append(box);
    slots.push({
      box,
      canvas,
      text,
      content: null,
      textLayer: null,
      textAt: null,
      textBuilding: null,
      size: null,
      renderedAt: null,
      task: null,
    });
  }

  let zoom = 1;
  /** Bumped on every zoom change so in-flight renders can tell they are stale. */
  let generation = 0;
  let page = 1;
  let destroyed = false;

  const pageListeners = new Set<(page: number) => void>();

  /** Search state while the find bar is open; null keeps find out of the paint path. */
  let findState: { needle: string; current: FindHit | null } | null = null;
  /** Ranges per page, rebuilt whenever a page's text layer is rebuilt. */
  const highlights = new Map<number, Range[]>();
  /** Distinguishes the newest query from one still scanning the document. */
  let findToken = 0;

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

  function dropCanvas(index: number): void {
    const slot = slots[index];
    if (!slot) return;
    slot.task?.cancel();
    slot.task = null;
    // Dropping the backing store is what actually frees the memory: a 1x1
    // canvas still occupies its slot in the layout without retaining pixels.
    slot.canvas.width = 1;
    slot.canvas.height = 1;
    slot.renderedAt = null;
    slot.box.classList.remove("is-rendered");
  }

  function dropText(index: number): void {
    const slot = slots[index];
    if (!slot) return;
    slot.textLayer?.cancel();
    slot.textLayer = null;
    slot.textAt = null;
    slot.textBuilding = null;
    slot.text.replaceChildren();
    highlights.delete(index);
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
      .forEach((entry) => dropCanvas(entry.index));
  }

  async function contentOf(index: number): Promise<TextContent> {
    const slot = slots[index]!;
    if (!slot.content) {
      const rendered = await pdf.getPage(index + 1);
      slot.content = await rendered.getTextContent();
    }
    return slot.content;
  }

  /**
   * Builds the invisible text over a rendered page. Selection, copy and find all
   * depend on it, and pdf.js lays the runs out in page units scaled by the CSS
   * variables below, so a rescale simply builds the layer again.
   */
  async function buildText(index: number, scale: number): Promise<void> {
    const slot = slots[index];
    if (!slot || destroyed || slot.textAt === scale || slot.textBuilding === scale) return;

    const epoch = generation;
    slot.textBuilding = scale;

    try {
      const content = await contentOf(index);
      if (destroyed || epoch !== generation) return;

      const rendered = await pdf.getPage(index + 1);
      const viewport = rendered.getViewport({ scale });

      // A fresh container, swapped in before the runs are written: a layer that
      // a zoom left half-built then writes into a detached node instead of
      // racing the newer one for the live page.
      const container = el("div", { class: "textLayer" });
      slot.box.replaceChild(container, slot.text);
      slot.text = container;
      slot.textLayer?.cancel();
      slot.textLayer = null;
      slot.textAt = null;

      container.style.setProperty("--total-scale-factor", String(scale));
      container.style.setProperty("--scale-round-x", "1px");
      container.style.setProperty("--scale-round-y", "1px");

      const layer = new TextLayer({
        textContentSource: content,
        container,
        viewport,
      });
      await layer.render();
      if (destroyed || epoch !== generation) return;

      slot.textLayer = layer;
      slot.textAt = scale;

      if (findState) {
        paintFind(index);
        refreshHighlights();
      }
    } catch {
      // Cancellation on rescale is the normal outcome; the next render retries.
    } finally {
      if (slot.textBuilding === scale) slot.textBuilding = null;
    }
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
      void buildText(index, scale);
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

  function goToPage(target: number): void {
    const box = slots[clamp(Math.round(target), 1, slots.length) - 1]?.box;
    if (!box) return;
    const bounds = box.getBoundingClientRect();
    const offset = bounds.top - stage.getBoundingClientRect().top;
    // The strip above a page only earns its place when the page leaves room
    // for it; a page as tall as the stage would otherwise lose its top edge.
    const gap = bounds.height + PAGE_GAP <= stage.clientHeight ? PAGE_GAP : 0;
    stage.scrollTop += offset - gap;
  }

  // --- find ----------------------------------------------------------------

  function paintFind(index: number): void {
    const needle = findState?.needle;
    const layer = slots[index]?.textLayer;
    if (!needle || !layer) return;

    const source = domText(layer);
    if (!source) return;

    const { text, map } = normalize(source.text);
    const ranges: Range[] = [];
    let at = text.indexOf(needle);
    while (at !== -1) {
      const start = map[at]!;
      const next = at + needle.length;
      // `map` points a collapsed space at the character after it, so the end
      // would carry trailing whitespace into the selection; back it off.
      let end = next < map.length ? map[next]! : source.text.length;
      while (end > start && /\s/.test(source.text[end - 1]!)) end -= 1;

      const range = rangeBetween(source.parts, start, end);
      if (range) ranges.push(range);
      at = text.indexOf(needle, at + needle.length);
    }

    if (ranges.length) highlights.set(index, ranges);
    else highlights.delete(index);
  }

  function refreshHighlights(): void {
    if (!("highlights" in CSS)) return;
    CSS.highlights.delete(FIND_ALL);
    CSS.highlights.delete(FIND_CURRENT);
    if (!findState) return;

    const all = [...highlights.values()].flat();
    if (all.length) CSS.highlights.set(FIND_ALL, new Highlight(...all));

    const current = findState.current;
    const range = current ? highlights.get(current.page - 1)?.[current.index] : undefined;
    if (range) CSS.highlights.set(FIND_CURRENT, new Highlight(range));
  }

  /** Waits for a page's text layer, which only appears once the page is on screen. */
  function whenTextReady(index: number, deadline: number): Promise<boolean> {
    return new Promise((resolve) => {
      const step = () => {
        if (destroyed) resolve(false);
        else if (slots[index]?.textAt === zoom) resolve(true);
        else if (performance.now() > deadline) resolve(false);
        else requestAnimationFrame(step);
      };
      step();
    });
  }

  /** Centres a match in the stage rather than merely making its page visible. */
  function reveal(range: Range): void {
    const box = range.getBoundingClientRect();
    if (!box.width && !box.height) return;
    const bounds = stage.getBoundingClientRect();
    stage.scrollTop += box.top - bounds.top - (stage.clientHeight - box.height) / 2;
    stage.scrollLeft += box.left - bounds.left - (stage.clientWidth - box.width) / 2;
  }

  function clearFind(): void {
    findToken += 1;
    findState = null;
    highlights.clear();
    refreshHighlights();
  }

  async function findAll(query: string): Promise<FindResult> {
    const token = ++findToken;
    const needle = normalize(query).text.trim();
    const counts = new Array<number>(pdf.numPages).fill(0);

    if (!needle) {
      findState = null;
      highlights.clear();
      refreshHighlights();
      return { counts };
    }

    for (let index = 0; index < pdf.numPages; index += 1) {
      if (destroyed || token !== findToken) return { counts };
      const content = await contentOf(index);
      const { text } = normalize(textOf(content));
      counts[index] = countIn(text, needle);
    }

    findState = { needle, current: null };
    highlights.clear();
    refreshHighlights();
    return { counts };
  }

  async function showHit(hit: FindHit): Promise<void> {
    if (!findState || destroyed) return;
    findState.current = hit;

    const index = hit.page - 1;
    goToPage(hit.page);

    // The page has to reach the viewport before its text exists; the observer
    // renders it and buildText resolves this wait.
    const ready = await whenTextReady(index, performance.now() + 2500);
    if (!ready || !findState) return;

    paintFind(index);
    refreshHighlights();

    const range = highlights.get(index)?.[hit.index];
    if (range) reveal(range);
  }

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
      for (let index = 0; index < slots.length; index += 1) {
        dropCanvas(index);
        dropText(index);
      }
      refreshHighlights();
      layout();

      // Releasing drops every canvas, and the observer only reports changes in
      // intersection: a page that stays in view across the rescale never fires
      // again, so it would sit blank until it scrolled out and back. Ask for the
      // visible ones again, which is what makes zooming repaint at all.
      for (const index of inView) void render(index);
    },

    currentPage,

    goToPage,

    onPageChange(listener: (next: number) => void): () => void {
      pageListeners.add(listener);
      return () => {
        pageListeners.delete(listener);
      };
    },

    findAll,
    showHit,
    clearFind,

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
      clearFind();
      for (let index = 0; index < slots.length; index += 1) {
        dropCanvas(index);
        dropText(index);
      }
      void loadingTask.destroy();
    },
  };
}
