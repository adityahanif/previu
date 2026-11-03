import { clamp } from "../dom";
import { MAX_ZOOM, MIN_ZOOM, type Doc, type FitMode } from "../types";
import { createImageLayer } from "./image";
import type { Layer, PdfLayer, Size } from "./types";

/**
 * Inset the stage keeps around its content, asked of the stylesheet instead of
 * duplicated here: presentation mode drops the vertical padding so a fitted page
 * fills the screen exactly.
 */
function stageInsets(stage: HTMLElement): { x: number; y: number } {
  const style = getComputedStyle(stage);
  return {
    x: parseFloat(style.paddingLeft) + parseFloat(style.paddingRight),
    y: parseFloat(style.paddingTop) + parseFloat(style.paddingBottom),
  };
}

/**
 * Owns the on-screen document and the zoom plumbing. Which of scrolling or
 * `setZoom` does the work is the layer's business: every layer lays its content
 * out at the zoomed size, so the stage's own scrolling pans in all cases.
 */
export class Viewer {
  #stage: HTMLElement;
  #host: HTMLElement;
  #layer: Layer | null = null;
  #pdf: PdfLayer | null = null;
  #unwatchPages: (() => void) | null = null;
  /** Zoom the layer is currently laid out at; layers start at 1:1. */
  #zoom = 1;
  /** Cursor point a rescale must hold steady, and the box it started from. */
  #anchor: {
    x: number;
    y: number;
    fx: number;
    fy: number;
    width: number;
    height: number;
    tries: number;
  } | null = null;
  #anchorFrame = 0;

  constructor(stage: HTMLElement, host: HTMLElement) {
    this.#stage = stage;
    this.#host = host;
  }

  get isOpen(): boolean {
    return this.#layer !== null;
  }

  get pdf(): PdfLayer | null {
    return this.#pdf;
  }

  /** PDFs stay upright, so their layer omits `setRotation`. */
  get supportsRotation(): boolean {
    return Boolean(this.#layer?.setRotation);
  }

  async open(doc: Doc): Promise<void> {
    this.close();

    let layer: Layer;
    if (doc.kind === "pdf") {
      // Imported on demand: pdf.js is most of the bundle, and opening an image
      // should not pay to parse it.
      const { createPdfLayer } = await import("./pdf");
      layer = await createPdfLayer(doc, this.#stage);
    } else {
      layer = await createImageLayer(doc);
    }

    this.#layer = layer;
    this.#zoom = 1;
    if (doc.kind === "pdf") this.#pdf = layer as PdfLayer;
    this.#host.replaceChildren(layer.element);
  }

  watchPageChanges(listener: (page: number) => void): void {
    this.#unwatchPages?.();
    this.#unwatchPages = this.#pdf?.onPageChange(listener) ?? null;
  }

  baseSize(): Size | null {
    return this.#layer?.baseSize() ?? null;
  }

  /** Zoom that makes the document fill the stage in the requested direction. */
  fitZoom(mode: Exclude<FitMode, "custom">): number {
    const base = this.#layer?.baseSize();
    if (!base) return 1;

    const insets = stageInsets(this.#stage);
    const width = Math.max(64, this.#stage.clientWidth - insets.x);
    const height = Math.max(64, this.#stage.clientHeight - insets.y);
    const byWidth = width / base.width;

    if (mode === "width") return clamp(byWidth, MIN_ZOOM, MAX_ZOOM);
    return clamp(Math.min(byWidth, height / base.height), MIN_ZOOM, MAX_ZOOM);
  }

  render(zoom: number, rotation: number, flipH: boolean, flipV: boolean): void {
    this.#zoom = zoom;
    this.#layer?.setZoom(zoom);
    this.#layer?.setRotation?.(rotation, flipH, flipV);
  }

  /**
   * Rescales while keeping the content point under the given viewport point
   * where it is.
   *
   * The correction is measured on a later frame, not in this one. A resize only
   * reaches this box's layout at the frame boundary, so a box read sooner still
   * describes the document as it stood before the rescale -- and since that box
   * is the one already sitting under the pointer, its correction works out to
   * exactly zero and the rescale looks as if it ignored the pointer. Asking
   * again next frame is not belt-and-braces: the retry is what makes the
   * difference between a correction and no correction at all.
   */
  zoomAroundClientPoint(zoom: number, clientX: number, clientY: number): void {
    const layer = this.#layer;
    if (!layer || zoom === this.#zoom) return;

    const before = this.#host.getBoundingClientRect();
    const fx = before.width ? (clientX - before.left) / before.width : 0.5;
    const fy = before.height ? (clientY - before.top) / before.height : 0.5;

    this.#zoom = zoom;
    layer.setZoom(zoom);

    // Steps arrive one per frame and share a pointer, so the newest anchor
    // simply supersedes the one still waiting on a box that has caught up.
    this.#anchor = {
      x: clientX,
      y: clientY,
      fx,
      fy,
      width: before.width,
      height: before.height,
      tries: 0,
    };
    this.#scheduleAnchor();
  }

  #scheduleAnchor(): void {
    if (this.#anchorFrame) return;
    this.#anchorFrame = requestAnimationFrame(() => {
      this.#anchorFrame = 0;
      this.#settleAnchor();
    });
  }

  #settleAnchor(): void {
    const anchor = this.#anchor;
    if (!anchor || !this.#layer) return;

    const box = this.#host.getBoundingClientRect();
    const laid =
      Math.abs(box.width - anchor.width) > 0.5 || Math.abs(box.height - anchor.height) > 0.5;

    // Same size means the same pre-rescale box, and this step would scroll by
    // nothing. Give layout a few frames to land; past that, take what there is
    // rather than leave an animation frame pending forever.
    if (!laid && anchor.tries < 5) {
      anchor.tries += 1;
      this.#scheduleAnchor();
      return;
    }

    this.#anchor = null;
    this.#stage.scrollLeft += box.left + anchor.fx * box.width - anchor.x;
    this.#stage.scrollTop += box.top + anchor.fy * box.height - anchor.y;
  }

  close(): void {
    this.#unwatchPages?.();
    this.#unwatchPages = null;
    if (this.#anchorFrame) cancelAnimationFrame(this.#anchorFrame);
    this.#anchorFrame = 0;
    this.#anchor = null;
    this.#layer?.destroy();
    this.#layer = null;
    this.#pdf = null;
    this.#host.replaceChildren();
  }
}
