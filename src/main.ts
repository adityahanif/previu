import "./styles.css";

import { bridge } from "./bridge";
import { clamp, must, toast } from "./dom";
import { currentDoc, getState, setState, subscribe } from "./store";
import {
  MAX_ZOOM,
  MIN_ZOOM,
  initialView,
  isTransformed,
  zoomIn,
  zoomOut,
  type Doc,
  type FitMode,
  type Opened,
  type ViewState,
} from "./types";
import { createFindBar } from "./ui/findbar";
import { closeMenu } from "./ui/menu";
import { createSidebar } from "./ui/sidebar";
import { createStatusbar } from "./ui/statusbar";
import { createToolbar } from "./ui/toolbar";
import { Viewer } from "./viewer";
import type { FindHit } from "./viewer/types";

/** Formats the `image` crate can write back out; anything else is saved as PNG. */
const RECODABLE = new Set(["png", "jpg", "jpeg", "jfif", "webp", "bmp", "ico"]);

const stage = must<HTMLElement>("#stage");
const host = must<HTMLElement>("#document");
const empty = must<HTMLElement>("#empty");
const dropOverlay = must<HTMLElement>("#drop-overlay");
const app = must<HTMLElement>("#app");

const viewer = new Viewer(stage, host);

let dimensions: string | null = null;
let message: string | null = null;

/** Full screen with the shell hidden; the document is fitted to the screen. */
let presenting = false;
/** View to go back to when the presentation ends. */
let restoreView: { fit: FitMode; zoom: number } | null = null;
let hinted = false;

const toolbar = createToolbar({
  toggleSidebar,
  openFile,
  previous: () => stepPrimary(-1),
  next: () => stepPrimary(1),
  previousFile: () => stepFile(-1),
  nextFile: () => stepFile(1),
  goTo,
  zoomIn: () => zoomStep(1),
  zoomOut: () => zoomStep(-1),
  setZoom: (zoom) => setZoom(zoom),
  setFit: (mode) => applyView({ ...getState().view, fit: mode }),
  actualSize: () => applyView({ ...getState().view, zoom: 1, fit: "custom" }),
  rotate,
  flip,
  saveCopy: () => void saveCopy(),
  findInDocument: () => openFind(),
  present: () => togglePresentation(),
  reveal: () => {
    const doc = currentDoc();
    if (doc) void bridge.reveal(doc.path);
  },
  setDefaultApp: () => void setDefaultApp(),
});

const sidebar = createSidebar({
  selectTab: (tab) => setState({ sidebarTab: tab }, "sidebar"),
  goToPage: (page) => viewer.pdf?.goToPage(page),
  openSibling: (index) => void showAt(index),
});

const statusbar = createStatusbar();

const findBar = createFindBar({
  search: (query) => void runFind(query),
  step: (delta) => void stepFind(delta),
  close: () => closeFind(),
});

must("#toolbar").replaceWith(toolbar.element);
must("#sidebar").replaceWith(sidebar.element);
must("#statusbar").replaceWith(statusbar.element);
must("#find").replaceWith(findBar.element);

subscribe((state) => {
  const doc = currentDoc();
  toolbar.update({
    doc,
    index: state.index,
    count: state.siblings.length,
    view: state.view,
    sidebarOpen: state.sidebarOpen,
    canRotate: viewer.supportsRotation,
    busy: state.loading,
  });
  sidebar.update({
    open: state.sidebarOpen,
    tab: state.sidebarTab,
    doc,
    siblings: state.siblings,
    index: state.index,
    view: state.view,
    pdf: viewer.pdf,
  });
  statusbar.update({
    doc,
    folder: state.folder,
    view: state.view,
    dimensions,
    message,
  });
  empty.hidden = doc !== null || state.loading;
});

// --- opening -------------------------------------------------------------

async function adopt(opened: Opened): Promise<void> {
  const doc = opened.siblings[opened.index] ?? opened.siblings[0];
  if (!doc) return;
  setState(
    { siblings: opened.siblings, index: opened.index, folder: opened.folder },
    "siblings",
  );
  await show(doc);
}

async function openPath(path: string): Promise<void> {
  try {
    await adopt(await bridge.openDocument(path));
  } catch (error) {
    fail(error);
  }
}

async function openFile(): Promise<void> {
  setState({ loading: true }, "loading");
  try {
    const opened = await bridge.chooseDocument();
    if (opened) await adopt(opened);
  } catch (error) {
    fail(error);
  } finally {
    setState({ loading: false }, "loading");
  }
}

async function showAt(index: number): Promise<void> {
  const doc = getState().siblings[index];
  if (!doc) return;
  setState({ index }, "siblings");
  await show(doc);
}

/**
 * Renders `doc` and resets the view. A new document always opens fitted, which
 * is what makes double-clicking a file in Explorer feel immediate.
 */
async function show(doc: Doc): Promise<void> {
  closeFind();
  setState({ loading: true, error: null }, "loading");
  dimensions = null;
  message = null;

  try {
    await viewer.open(doc);
    viewer.watchPageChanges((page) => {
      const state = getState();
      setState(
        { view: { ...state.view, page, pageCount: viewer.pdf?.pageCount ?? 1 } },
        "view",
      );
    });

    const base = viewer.baseSize();
    if (base) dimensions = `${Math.round(base.width)} × ${Math.round(base.height)}`;

    const start: ViewState = {
      ...initialView(),
      pageCount: viewer.pdf?.pageCount ?? 1,
    };
    applyView(start);
    void bridge.setTitle(`${doc.name} — Previu`);
  } catch (error) {
    fail(error);
  } finally {
    setState({ loading: false }, "loading");
  }
}

function fail(error: unknown): void {
  message = error instanceof Error ? error.message : String(error);
  toast(message, "error");
  setState({ error: message }, "loading");
}

// --- view ----------------------------------------------------------------

/** Resolves the fit mode into a concrete zoom and pushes both to the layer. */
function applyView(next: ViewState): void {
  const zoom = next.fit === "custom" ? next.zoom : viewer.fitZoom(next.fit);
  const view = { ...next, zoom };
  setState({ view }, "view");
  viewer.render(view.zoom, view.rotation, view.flipH, view.flipV);
}

function setZoom(zoom: number, anchor?: { x: number; y: number }): void {
  const clamped = clamp(zoom, MIN_ZOOM, MAX_ZOOM);
  const view = { ...getState().view, zoom: clamped, fit: "custom" as const };

  if (anchor && viewer.isOpen) {
    viewer.zoomAroundClientPoint(clamped, anchor.x, anchor.y);
    setState({ view }, "view");
  } else {
    applyView(view);
  }
}

/** Zoom steps stay centred so the document does not drift while stepping. */
function zoomStep(direction: 1 | -1, wheel?: WheelEvent): void {
  const state = getState();
  if (!state.siblings.length) return;
  const next = direction > 0 ? zoomIn(state.view.zoom) : zoomOut(state.view.zoom);

  const bounds = stage.getBoundingClientRect();
  setZoom(next, {
    x: wheel ? wheel.clientX : bounds.left + stage.clientWidth / 2,
    y: wheel ? wheel.clientY : bounds.top + stage.clientHeight / 2,
  });
}

function rotate(delta: number): void {
  const state = getState();
  if (!viewer.supportsRotation) return;
  const rotation = (((state.view.rotation + delta) % 360) + 360) % 360;
  // Fit modes are preserved so a fitted page stays fitted after turning it.
  applyView({ ...state.view, rotation });
}

function flip(axis: "horizontal" | "vertical"): void {
  const state = getState();
  if (!viewer.supportsRotation) return;
  applyView(
    axis === "horizontal"
      ? { ...state.view, flipH: !state.view.flipH }
      : { ...state.view, flipV: !state.view.flipV },
  );
}

// --- navigation ----------------------------------------------------------

/** Arrow keys move pages in a PDF and files otherwise. */
function stepPrimary(delta: number): void {
  const state = getState();
  const doc = currentDoc();
  if (doc?.kind === "pdf" && state.view.pageCount > 1) {
    viewer.pdf?.goToPage(state.view.page + delta);
    return;
  }
  stepFile(delta);
}

function stepFile(delta: number): void {
  const state = getState();
  const next = state.index + delta;
  if (next < 0 || next >= state.siblings.length) return;
  void showAt(next);
}

function goTo(position: number): void {
  const state = getState();
  const doc = currentDoc();
  if (!doc) return;
  if (doc.kind === "pdf" && state.view.pageCount > 1) {
    viewer.pdf?.goToPage(position);
    return;
  }
  void showAt(clamp(position, 1, state.siblings.length) - 1);
}

function goToLast(): void {
  const state = getState();
  const doc = currentDoc();
  if (!doc) return;
  if (doc.kind === "pdf" && state.view.pageCount > 1) viewer.pdf?.goToPage(state.view.pageCount);
  else void showAt(state.siblings.length - 1);
}

function toggleSidebar(): void {
  setState({ sidebarOpen: !getState().sidebarOpen }, "sidebar");
}

// --- find ----------------------------------------------------------------

let findHits: FindHit[] = [];
let findCursor = -1;
/** Query the hits belong to; typing something else makes them stale. */
let findQuery = "";

function openFind(): void {
  if (presenting) return;
  if (currentDoc()?.kind !== "pdf") {
    toast("Find works in PDF files.");
    return;
  }
  findBar.open();
}

function closeFind(): void {
  if (!findBar.isOpen()) return;
  findBar.close();
  findHits = [];
  findCursor = -1;
  findQuery = "";
  viewer.pdf?.clearFind();
}

function findLabel(): string {
  if (findHits.length) return `${findCursor + 1} of ${findHits.length}`;
  return findQuery.trim() ? "No matches" : "";
}

async function runFind(query: string): Promise<void> {
  const pdf = viewer.pdf;
  findQuery = query;

  if (!pdf || !query.trim()) {
    findHits = [];
    findCursor = -1;
    findBar.setCount("");
    pdf?.clearFind();
    return;
  }

  const result = await pdf.findAll(query);
  // A later keystroke owns the answer: dropping this one keeps the count, the
  // highlight and the field from disagreeing.
  if (findQuery !== query) return;

  findHits = [];
  result.counts.forEach((count, page) => {
    for (let index = 0; index < count; index += 1) {
      findHits.push({ page: page + 1, index });
    }
  });

  findCursor = findHits.length ? 0 : -1;
  findBar.setCount(findLabel());
  if (findCursor >= 0) await pdf.showHit(findHits[0]!);
}

async function stepFind(delta: 1 | -1): Promise<void> {
  const pdf = viewer.pdf;
  if (!pdf) return;

  const query = findBar.value();
  if (query !== findQuery) {
    // Enter straight after typing: the answer is not in yet, so this is the
    // first jump rather than a step away from it.
    await runFind(query);
    return;
  }
  if (!findHits.length) return;

  findCursor = (findCursor + delta + findHits.length) % findHits.length;
  findBar.setCount(findLabel());
  await pdf.showHit(findHits[findCursor]!);
}

// --- actions -------------------------------------------------------------

function baseName(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

function suggestedSaveName(doc: Doc): string {
  const dot = doc.name.lastIndexOf(".");
  const stem = dot > 0 ? doc.name.slice(0, dot) : doc.name;
  return `${stem}-edited.${RECODABLE.has(doc.ext) ? doc.ext : "png"}`;
}

async function saveCopy(): Promise<void> {
  const state = getState();
  const doc = currentDoc();
  if (!doc || doc.kind !== "image") return;

  if (!isTransformed(state.view)) {
    toast("Rotate or flip the image first, then save a copy.");
    return;
  }

  const dest = await bridge.saveDialog(suggestedSaveName(doc));
  if (!dest) return;

  try {
    await bridge.saveCopy(
      doc.path,
      dest,
      state.view.rotation,
      state.view.flipH,
      state.view.flipV,
    );
    toast(`Saved ${baseName(dest)}`);
  } catch (error) {
    fail(error);
  }
}

async function setDefaultApp(): Promise<void> {
  try {
    const status = await bridge.registerAssoc();
    const types = status.supported.join(" ");
    toast(`Previu now appears in Windows' "Open with" list for ${types}.`, "info");
    // Windows will not let an app take over a file type silently, so the last
    // step is always the user confirming in Settings.
    await bridge.openDefaultAppsSettings();
  } catch (error) {
    fail(error);
  }
}

/**
 * Full screen with the shell out of the way, so a PDF deck shows the way a
 * slideshow would: one page fitted to the screen, nothing else. Leaving puts the
 * view back the way it was.
 */
async function setPresentation(on: boolean): Promise<void> {
  if (on === presenting) return;
  if (on && !viewer.isOpen) return;

  presenting = on;
  try {
    await bridge.setFullscreen(on);
  } catch (error) {
    presenting = !on;
    fail(error);
    return;
  }

  app.classList.toggle("is-presenting", on);

  if (on) {
    const view = getState().view;
    restoreView = { fit: view.fit, zoom: view.zoom };
    // Presentation drops the stage's vertical padding and the fit maths read the
    // padding from the stylesheet, so a fitted page fills the screen exactly.
    applyView({ ...view, fit: "page" });
    viewer.pdf?.goToPage(view.page);
    settleSlide();
    if (!hinted) {
      hinted = true;
      toast("Press Esc to leave the presentation");
    }
    return;
  }

  if (restoreView) {
    applyView({ ...getState().view, ...restoreView });
    restoreView = null;
  }
}

function togglePresentation(): void {
  void setPresentation(!presenting);
}

/**
 * Fits and aligns the slide until the stage stops changing size. The native
 * window reaches full screen over several frames, and a fit made mid-transition
 * leaves the page the wrong size for the screen it lands on.
 */
function settleSlide(): void {
  let previous = "";
  let stable = 0;
  const step = () => {
    if (!presenting) return;
    const view = getState().view;
    applyView(view);
    viewer.pdf?.goToPage(view.page);

    const size = `${stage.clientWidth}x${stage.clientHeight}`;
    stable = size === previous ? stable + 1 : 0;
    previous = size;
    if (stable < 2) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

/** Keeps up with the window leaving full screen without going through us. */
async function syncPresentation(): Promise<void> {
  if (!viewer.isOpen) return;
  let on: boolean;
  try {
    on = await bridge.isFullscreen();
  } catch {
    return;
  }
  if (on !== presenting) await setPresentation(on);
}

// --- input ---------------------------------------------------------------

// Ctrl+wheel (and trackpad pinch, which reports ctrlKey) zooms at the cursor.
stage.addEventListener(
  "wheel",
  (event) => {
    if (!event.ctrlKey || !viewer.isOpen) return;
    event.preventDefault();
    const state = getState();
    setZoom(state.view.zoom * Math.exp(-event.deltaY / 400), {
      x: event.clientX,
      y: event.clientY,
    });
  },
  { passive: false },
);

// Dragging pans whenever the content overflows, matching Preview's grab cursor.
let pan: { x: number; y: number; left: number; top: number } | null = null;
stage.addEventListener("pointerdown", (event) => {
  if (event.button !== 0 || !viewer.isOpen) return;
  if (!(event.target instanceof Element)) return;
  if (event.target.closest(".textLayer")) {
    // Text is there to be selected; a drag across it copies, it does not pan.
    return;
  }
  if (event.target.closest("button, a")) return;

  // clientWidth/clientHeight exclude the scrollbars, so anything past them is a
  // scrollbar grab and must keep its native behaviour.
  const bounds = stage.getBoundingClientRect();
  if (event.clientX > bounds.left + stage.clientWidth) return;
  if (event.clientY > bounds.top + stage.clientHeight) return;

  pan = { x: event.clientX, y: event.clientY, left: stage.scrollLeft, top: stage.scrollTop };
  stage.classList.add("is-panning");
  stage.setPointerCapture(event.pointerId);
});
stage.addEventListener("pointermove", (event) => {
  if (!pan) return;
  stage.scrollLeft = pan.left - (event.clientX - pan.x);
  stage.scrollTop = pan.top - (event.clientY - pan.y);
});
const endPan = () => {
  pan = null;
  stage.classList.remove("is-panning");
};
stage.addEventListener("pointerup", endPan);
stage.addEventListener("pointercancel", endPan);

window.addEventListener("keydown", (event) => {
  const target = event.target;
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return;
  if (target instanceof HTMLElement && target.isContentEditable) return;

  const state = getState();
  const doc = currentDoc();

  if (event.ctrlKey || event.metaKey) {
    switch (event.key) {
      case "o":
        event.preventDefault();
        void openFile();
        return;
      case "s":
        event.preventDefault();
        void saveCopy();
        return;
      case "f":
        event.preventDefault();
        openFind();
        return;
      case "=":
      case "+":
        event.preventDefault();
        zoomStep(1);
        return;
      case "-":
      case "_":
        event.preventDefault();
        zoomStep(-1);
        return;
      case "0":
        event.preventDefault();
        applyView({ ...state.view, fit: "page" });
        return;
      case "1":
        event.preventDefault();
        applyView({ ...state.view, zoom: 1, fit: "custom" });
        return;
      case "ArrowLeft":
        event.preventDefault();
        stepFile(-1);
        return;
      case "ArrowRight":
        event.preventDefault();
        stepFile(1);
        return;
      default:
        return;
    }
  }

  if (!doc) {
    if (event.key === "o" || event.key === "O") {
      event.preventDefault();
      void openFile();
    }
    return;
  }

  switch (event.key) {
    case "ArrowLeft":
    case "PageUp":
      event.preventDefault();
      stepPrimary(-1);
      break;
    case "ArrowRight":
    case "PageDown":
      event.preventDefault();
      stepPrimary(1);
      break;
    case "Home":
      event.preventDefault();
      goTo(1);
      break;
    case "End":
      event.preventDefault();
      goToLast();
      break;
    case "=":
    case "+":
      event.preventDefault();
      zoomStep(1);
      break;
    case "-":
    case "_":
      event.preventDefault();
      zoomStep(-1);
      break;
    case "0":
      event.preventDefault();
      applyView({ ...state.view, fit: "page" });
      break;
    case "1":
      event.preventDefault();
      applyView({ ...state.view, zoom: 1, fit: "custom" });
      break;
    case "r":
      event.preventDefault();
      rotate(90);
      break;
    case "R":
      event.preventDefault();
      rotate(-90);
      break;
    case "h":
    case "H":
      event.preventDefault();
      flip("horizontal");
      break;
    case "v":
    case "V":
      event.preventDefault();
      flip("vertical");
      break;
    case "f":
    case "F":
    case "F11":
      event.preventDefault();
      if (!event.repeat) togglePresentation();
      break;
    case "s":
    case "S":
      event.preventDefault();
      void saveCopy();
      break;
    case "t":
    case "T":
      event.preventDefault();
      toggleSidebar();
      break;
    case "Escape":
      if (findBar.isOpen()) {
        event.preventDefault();
        closeFind();
      } else if (presenting) {
        event.preventDefault();
        void setPresentation(false);
      } else {
        closeMenu();
      }
      break;
    default:
      break;
  }
});

// Refit when the window or sidebar changes the available space. The content box
// is what the fit maths measure, and it is also what changes when presentation
// mode drops the stage padding.
new ResizeObserver(() => {
  const state = getState();
  if (!viewer.isOpen || state.view.fit === "custom") return;
  applyView(state.view);
  // Entering full screen resizes the stage a frame after the request, so this is
  // where a presentation lands on the right slide.
  if (presenting) viewer.pdf?.goToPage(state.view.page);
}).observe(stage, { box: "content-box" });

// A window that leaves full screen on its own (Esc, a system shortcut) has to
// put the shell back.
window.addEventListener("resize", () => void syncPresentation());
document.addEventListener("fullscreenchange", () => void syncPresentation());

// --- startup -------------------------------------------------------------

async function start(): Promise<void> {
  await bridge.onDrop({
    onDrop: (paths) => {
      const first = paths[0];
      if (first) void openPath(first);
    },
    onHover: (active) => {
      dropOverlay.hidden = !active;
    },
  });

  await bridge.onOpenFile((path) => void openPath(path));

  const pending = await bridge.takePendingOpen();
  if (pending) await openPath(pending);
  else applyView(getState().view);

  if (bridge.isNative && !currentDoc()) {
    const info = await bridge.appInfo();
    document.title = "Previu";
    if (message === null) message = `Previu ${info.version}`;
  }
  setState({}, "loading");
}

void start();
