export interface Size {
  width: number;
  height: number;
}

/**
 * A rendered representation of one document. Panning and scrolling belong to the
 * stage, not the layer: every layer lays its content out at the zoomed size, so
 * the stage's native scrolling handles navigation in all cases.
 */
export interface Layer {
  element: HTMLElement;
  /** Intrinsic size of one page at 100%, already accounting for rotation. */
  baseSize(): Size;
  setZoom(zoom: number): void;
  /** Absent for layers that cannot be rotated, such as a multi-page PDF. */
  setRotation?(rotation: number, flipH: boolean, flipV: boolean): void;
  destroy(): void;
}

/** One match inside a PDF, addressed by page and position on that page. */
export interface FindHit {
  /** 1-based page number. */
  page: number;
  /** Zero-based position of the match among that page's matches. */
  index: number;
}

export interface FindResult {
  /** Matches per page; element 0 belongs to page 1. */
  counts: number[];
}

export interface PdfLayer extends Layer {
  pageCount: number;
  currentPage(): number;
  goToPage(page: number): void;
  onPageChange(listener: (page: number) => void): () => void;
  renderThumbnail(page: number, canvas: HTMLCanvasElement): Promise<void>;
  /** Counts `query` on every page without touching the DOM. */
  findAll(query: string): Promise<FindResult>;
  /** Scrolls to a match, highlights it, and leaves it as the current one. */
  showHit(hit: FindHit): Promise<void>;
  /** Drops the search state and its highlights. */
  clearFind(): void;
}
