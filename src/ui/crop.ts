import { clamp, el } from "../dom";
import type { CropRect } from "../types";
import type { Size } from "../viewer/types";

/** A rectangle in the image frame's own coordinates (CSS pixels). */
export interface Selection {
  left: number;
  top: number;
  width: number;
  height: number;
}

interface Ratio {
  label: string;
  /** Width / height; null is freehand; 0 means "the image's own ratio". */
  value: number | null;
}

const RATIOS: Ratio[] = [
  { label: "Free", value: null },
  { label: "Original", value: 0 },
  { label: "1:1", value: 1 },
  { label: "4:3", value: 4 / 3 },
  { label: "3:2", value: 3 / 2 },
  { label: "16:9", value: 16 / 9 },
  { label: "5:4", value: 5 / 4 },
  { label: "3:4", value: 3 / 4 },
  { label: "2:3", value: 2 / 3 },
  { label: "9:16", value: 9 / 16 },
  { label: "4:5", value: 4 / 5 },
];

const MIN_DISPLAY = 12;
const HANDLES = ["nw", "n", "ne", "e", "se", "s", "sw", "w"] as const;
type Handle = (typeof HANDLES)[number];

const CURSORS: Record<Handle, string> = {
  nw: "nwse-resize",
  se: "nwse-resize",
  ne: "nesw-resize",
  sw: "nesw-resize",
  n: "ns-resize",
  s: "ns-resize",
  e: "ew-resize",
  w: "ew-resize",
};

/** Converts a frame-local selection to pixels of the displayed image. */
export function selectionToPixels(sel: Selection, bounds: Selection, displayed: Size): CropRect {
  const scaleX = displayed.width / bounds.width;
  const scaleY = displayed.height / bounds.height;
  const x = clamp(Math.round((sel.left - bounds.left) * scaleX), 0, displayed.width - 1);
  const y = clamp(Math.round((sel.top - bounds.top) * scaleY), 0, displayed.height - 1);
  const width = clamp(Math.round(sel.width * scaleX), 1, displayed.width - x);
  const height = clamp(Math.round(sel.height * scaleY), 1, displayed.height - y);
  return { x, y, width, height };
}

/**
 * Sizes a selection from an anchor corner towards the drag point. With a
 * ratio, the width leads and the height follows, shrinking both when the
 * height would run past the image edge the drag is heading towards.
 */
export function dragSelection(
  anchor: { x: number; y: number },
  point: { x: number; y: number },
  bounds: Selection,
  ratio: number | null,
): Selection {
  const dx = clamp(point.x, bounds.left, bounds.left + bounds.width) - anchor.x;
  const dy = clamp(point.y, bounds.top, bounds.top + bounds.height) - anchor.y;

  let width = Math.abs(dx);
  let height = Math.abs(dy);

  if (ratio !== null) {
    const maxWidth = dx >= 0 ? bounds.left + bounds.width - anchor.x : anchor.x - bounds.left;
    const maxHeight = dy >= 0 ? bounds.top + bounds.height - anchor.y : anchor.y - bounds.top;
    width = Math.min(width, maxWidth);
    height = width / ratio;
    if (height > maxHeight) {
      height = maxHeight;
      width = height * ratio;
    }
  }

  return {
    left: dx >= 0 ? anchor.x : anchor.x - width,
    top: dy >= 0 ? anchor.y : anchor.y - height,
    width,
    height,
  };
}

/** Resizes `sel` by one handle; the opposite edge or corner stays put. */
export function resizeSelection(
  sel: Selection,
  handle: Handle,
  point: { x: number; y: number },
  bounds: Selection,
  ratio: number | null,
): Selection {
  const right = sel.left + sel.width;
  const bottom = sel.top + sel.height;

  if (ratio !== null) {
    // With a locked ratio only the corners resize; they drag against the
    // corner diagonally opposite.
    const anchor =
      handle === "se"
        ? { x: sel.left, y: sel.top }
        : handle === "nw"
          ? { x: right, y: bottom }
          : handle === "ne"
            ? { x: sel.left, y: bottom }
            : handle === "sw"
              ? { x: right, y: sel.top }
              : null;
    if (!anchor) return sel;
    return dragSelection(anchor, point, bounds, ratio);
  }

  let { left, top, width, height } = sel;
  if (handle.includes("e"))
    width = clamp(point.x, sel.left + MIN_DISPLAY, bounds.left + bounds.width) - sel.left;
  if (handle.includes("s"))
    height = clamp(point.y, sel.top + MIN_DISPLAY, bounds.top + bounds.height) - sel.top;
  if (handle.includes("w")) {
    const nextLeft = clamp(point.x, bounds.left, right - MIN_DISPLAY);
    width = right - nextLeft;
    left = nextLeft;
  }
  if (handle.includes("n")) {
    const nextTop = clamp(point.y, bounds.top, bottom - MIN_DISPLAY);
    height = bottom - nextTop;
    top = nextTop;
  }
  return { left, top, width, height };
}

/** Keeps a selection wholly inside the image box. */
export function clampToBounds(sel: Selection, bounds: Selection): Selection {
  const width = Math.min(sel.width, bounds.width);
  const height = Math.min(sel.height, bounds.height);
  return {
    left: clamp(sel.left, bounds.left, bounds.left + bounds.width - width),
    top: clamp(sel.top, bounds.top, bounds.top + bounds.height - height),
    width,
    height,
  };
}

export interface CropOptions {
  /** The image layer's frame; the overlay mounts inside it, over the image. */
  frame: HTMLElement;
  /** The rendered image; its box inside the frame is the croppable area. */
  image: HTMLImageElement;
  /** Intrinsic size in the displayed orientation. */
  displayed: Size;
  onApply(rect: CropRect): void;
  onCancel(): void;
}

export interface CropSession {
  destroy(): void;
  readonly active: boolean;
}

type DragMode =
  | { kind: "draw"; anchor: { x: number; y: number }; origin: { x: number; y: number } }
  | { kind: "move"; start: Selection; at: { x: number; y: number }; origin: { x: number; y: number } }
  | { kind: "resize"; handle: Handle; start: Selection; origin: { x: number; y: number } };

/**
 * The crop interaction. Its overlay lives inside the image frame itself, and
 * every coordinate is frame-local: the overlay moves with the image when the
 * stage scrolls, and the image's box is re-measured at the start of every
 * drag, so the frame the user places is always the frame that is applied.
 *
 * Drag on the image to frame an area freehand, or pick a ratio first and the
 * frame keeps it. Handles resize, the frame moves, arrow keys nudge it,
 * Enter applies and Escape cancels.
 */
export function createCropSession(options: CropOptions): CropSession {
  const { frame, image, displayed } = options;
  let selection: Selection | null = null;
  let ratio: number | null = null;
  let drag: DragMode | null = null;
  let active = true;

  /** The image's box in frame-local coordinates, measured fresh. */
  function measureBounds(): Selection {
    const frameRect = frame.getBoundingClientRect();
    const imageRect = image.getBoundingClientRect();
    return {
      left: imageRect.left - frameRect.left,
      top: imageRect.top - frameRect.top,
      width: imageRect.width,
      height: imageRect.height,
    };
  }
  let bounds = measureBounds();

  const sizeLabel = el("span", { class: "crop-size", text: "Drag on the image to choose an area" });
  const applyButton = el("button", {
    class: "crop-apply",
    type: "button",
    text: "Apply crop",
    disabled: "true",
  });
  const ratioSelect = el(
    "select",
    { class: "crop-ratio", "aria-label": "Aspect ratio" },
    RATIOS.map((entry) => el("option", { value: entry.label, text: entry.label })),
  );

  const bar = el("div", { class: "crop-bar" }, [
    el("span", { class: "crop-title", text: "Crop" }),
    ratioSelect,
    sizeLabel,
    el("button", {
      class: "crop-button",
      type: "button",
      text: "Select all",
      onclick: () => {
        bounds = measureBounds();
        selection = fitRatio({ ...bounds });
        paint();
      },
    }),
    el("button", {
      class: "crop-button",
      type: "button",
      text: "Cancel",
      onclick: () => finish(options.onCancel),
    }),
    applyButton,
  ]);
  applyButton.addEventListener("click", () => {
    if (!selection) return;
    const rect = selectionToPixels(selection, bounds, displayed);
    finish(() => options.onApply(rect));
  });

  // Four shades darken everything in the frame outside the selection.
  const shades = {
    top: el("div", { class: "crop-shade" }),
    bottom: el("div", { class: "crop-shade" }),
    left: el("div", { class: "crop-shade" }),
    right: el("div", { class: "crop-shade" }),
  };
  const frameEl = el("div", { class: "crop-selection", hidden: true });
  frameEl.append(el("div", { class: "crop-grid" }));
  const handleEls = new Map<Handle, HTMLElement>();
  for (const handle of HANDLES) {
    const node = el("div", { class: "crop-handle", "data-handle": handle });
    node.style.cursor = CURSORS[handle];
    frameEl.append(node);
    handleEls.set(handle, node);
  }

  const overlay = el("div", { class: "crop-overlay" }, [
    shades.top,
    shades.bottom,
    shades.left,
    shades.right,
    frameEl,
  ]);
  frame.append(overlay);
  document.body.append(bar);

  function currentRatio(): number | null {
    if (ratio === 0) return displayed.width / displayed.height;
    return ratio;
  }

  /** Reshapes a selection to the locked ratio around its own centre. */
  function fitRatio(sel: Selection): Selection {
    const locked = currentRatio();
    if (locked === null) return sel;
    let width = sel.width;
    let height = width / locked;
    if (height > bounds.height) {
      height = bounds.height;
      width = height * locked;
    }
    if (width > bounds.width) {
      width = bounds.width;
      height = width / locked;
    }
    const centreX = sel.left + sel.width / 2;
    const centreY = sel.top + sel.height / 2;
    return clampToBounds(
      { left: centreX - width / 2, top: centreY - height / 2, width, height },
      bounds,
    );
  }

  function paintShade(node: HTMLElement, left: number, top: number, width: number, height: number): void {
    node.style.left = `${left}px`;
    node.style.top = `${top}px`;
    node.style.width = `${Math.max(0, width)}px`;
    node.style.height = `${Math.max(0, height)}px`;
    node.hidden = width <= 0 || height <= 0;
  }

  function paint(): void {
    const frameWidth = frame.clientWidth;
    const frameHeight = frame.clientHeight;

    if (!selection || selection.width < 2 || selection.height < 2) {
      frameEl.hidden = true;
      paintShade(shades.top, 0, 0, frameWidth, frameHeight);
      paintShade(shades.bottom, 0, 0, 0, 0);
      paintShade(shades.left, 0, 0, 0, 0);
      paintShade(shades.right, 0, 0, 0, 0);
      applyButton.disabled = true;
      sizeLabel.textContent = "Drag on the image to choose an area";
      return;
    }

    paintShade(shades.top, 0, 0, frameWidth, selection.top);
    paintShade(shades.bottom, 0, selection.top + selection.height, frameWidth, frameHeight - selection.top - selection.height);
    paintShade(shades.left, 0, selection.top, selection.left, selection.height);
    paintShade(shades.right, selection.left + selection.width, selection.top, frameWidth - selection.left - selection.width, selection.height);

    frameEl.hidden = false;
    frameEl.style.left = `${selection.left}px`;
    frameEl.style.top = `${selection.top}px`;
    frameEl.style.width = `${selection.width}px`;
    frameEl.style.height = `${selection.height}px`;

    const locked = currentRatio() !== null;
    for (const [handle, node] of handleEls) {
      const isCorner = handle.length === 2;
      node.style.left = handle.includes("e")
        ? `${selection.width}px`
        : handle.includes("w")
          ? "0px"
          : `${selection.width / 2}px`;
      node.style.top = handle.includes("s")
        ? `${selection.height}px`
        : handle.includes("n")
          ? "0px"
          : `${selection.height / 2}px`;
      // Edge handles cannot keep a locked ratio, so they step aside.
      node.hidden = locked && !isCorner;
    }

    const px = selectionToPixels(selection, bounds, displayed);
    sizeLabel.textContent = `${px.width} × ${px.height} px`;
    applyButton.disabled = false;
  }

  ratioSelect.addEventListener("change", () => {
    const picked = RATIOS.find((entry) => entry.label === ratioSelect.value);
    ratio = picked?.value ?? null;
    bounds = measureBounds();
    if (selection) selection = fitRatio(selection);
    paint();
  });

  /** Pointer position in frame-local coordinates. */
  function localPoint(event: PointerEvent, origin: { x: number; y: number }): { x: number; y: number } {
    return { x: event.clientX - origin.x, y: event.clientY - origin.y };
  }

  overlay.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    overlay.setPointerCapture(event.pointerId);

    // Measure where the image actually is right now; the drag then works in
    // that frame-local space, untouched by scrolling.
    bounds = measureBounds();
    const frameRect = frame.getBoundingClientRect();
    const origin = { x: frameRect.left, y: frameRect.top };
    const point = localPoint(event, origin);

    if (event.target instanceof HTMLElement && event.target.dataset.handle) {
      if (selection) {
        drag = { kind: "resize", handle: event.target.dataset.handle as Handle, start: selection, origin };
      }
      return;
    }
    if (
      selection &&
      point.x >= selection.left &&
      point.x <= selection.left + selection.width &&
      point.y >= selection.top &&
      point.y <= selection.top + selection.height
    ) {
      drag = { kind: "move", start: selection, at: point, origin };
      return;
    }
    const anchor = {
      x: clamp(point.x, bounds.left, bounds.left + bounds.width),
      y: clamp(point.y, bounds.top, bounds.top + bounds.height),
    };
    drag = { kind: "draw", anchor, origin };
    selection = { left: anchor.x, top: anchor.y, width: 0, height: 0 };
    paint();
  });

  overlay.addEventListener("pointermove", (event) => {
    if (!drag) return;
    const point = localPoint(event, drag.origin);
    if (drag.kind === "draw") {
      selection = dragSelection(drag.anchor, point, bounds, currentRatio());
    } else if (drag.kind === "move") {
      selection = clampToBounds(
        {
          ...drag.start,
          left: drag.start.left + (point.x - drag.at.x),
          top: drag.start.top + (point.y - drag.at.y),
        },
        bounds,
      );
    } else {
      selection = resizeSelection(drag.start, drag.handle, point, bounds, currentRatio());
    }
    paint();
  });

  const endDrag = () => {
    if (
      drag?.kind === "draw" &&
      selection &&
      (selection.width < MIN_DISPLAY || selection.height < MIN_DISPLAY)
    ) {
      selection = null;
      paint();
    }
    drag = null;
  };
  overlay.addEventListener("pointerup", endDrag);
  overlay.addEventListener("pointercancel", endDrag);

  overlay.addEventListener("dblclick", () => {
    bounds = measureBounds();
    selection = fitRatio({ ...bounds });
    paint();
  });

  function onKey(event: KeyboardEvent): void {
    if (!active) return;
    if (event.key === "Enter" && selection) {
      event.preventDefault();
      event.stopPropagation();
      const rect = selectionToPixels(selection, bounds, displayed);
      finish(() => options.onApply(rect));
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      finish(options.onCancel);
    } else if (event.key.startsWith("Arrow") && selection) {
      event.preventDefault();
      event.stopPropagation();
      const step = event.shiftKey ? 10 : 1;
      const dx = event.key === "ArrowLeft" ? -step : event.key === "ArrowRight" ? step : 0;
      const dy = event.key === "ArrowUp" ? -step : event.key === "ArrowDown" ? step : 0;
      selection = clampToBounds({ ...selection, left: selection.left + dx, top: selection.top + dy }, bounds);
      paint();
    }
  }
  window.addEventListener("keydown", onKey, true);

  // The frame is measured in the stage's layout; a window resize can refit
  // the image under the frame, so the crop does not survive one.
  function onResize(): void {
    finish(options.onCancel);
  }
  window.addEventListener("resize", onResize);

  function finish(next: () => void): void {
    if (!active) return;
    destroy();
    next();
  }

  function destroy(): void {
    if (!active) return;
    active = false;
    window.removeEventListener("keydown", onKey, true);
    window.removeEventListener("resize", onResize);
    overlay.remove();
    bar.remove();
  }

  paint();

  return {
    destroy,
    get active() {
      return active;
    },
  };
}
