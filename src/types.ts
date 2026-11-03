export type DocKind = "image" | "pdf";

/** How the zoom level is derived. `custom` means the user set it explicitly. */
export type FitMode = "custom" | "width" | "page";

export interface Doc {
  path: string;
  name: string;
  url: string;
  kind: DocKind;
  ext: string;
  size: number;
  /** Milliseconds since the Unix epoch; 0 when the host cannot tell. */
  modified: number;
}

export interface Opened {
  folder: string;
  siblings: Doc[];
  index: number;
}

export interface ViewState {
  /** 1 renders at 100%. */
  zoom: number;
  fit: FitMode;
  /** Degrees, clockwise. Images only; PDFs stay upright. */
  rotation: number;
  flipH: boolean;
  flipV: boolean;
  /** 1-based. PDF only. */
  page: number;
  pageCount: number;
}

export function initialView(): ViewState {
  return {
    zoom: 1,
    fit: "page",
    rotation: 0,
    flipH: false,
    flipV: false,
    page: 1,
    pageCount: 1,
  };
}

/** True when rotation or flips would need baking in to be preserved. */
export function isTransformed(view: ViewState): boolean {
  return view.rotation % 360 !== 0 || view.flipH || view.flipV;
}

export const MIN_ZOOM = 0.05;
export const MAX_ZOOM = 16;

/** Zoom steps that feel right at typical document sizes. */
const ZOOM_STOPS = [
  0.05, 0.1, 0.15, 0.25, 0.33, 0.5, 0.67, 0.75, 0.9, 1, 1.25, 1.5, 2, 3, 4, 6, 8, 12, 16,
];

export function zoomIn(zoom: number): number {
  return ZOOM_STOPS.find((stop) => stop > zoom + 1e-6) ?? MAX_ZOOM;
}

export function zoomOut(zoom: number): number {
  const smaller = ZOOM_STOPS.filter((stop) => stop < zoom - 1e-6);
  return smaller.length ? (smaller[smaller.length - 1] as number) : MIN_ZOOM;
}
