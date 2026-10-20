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

export interface PdfLayer extends Layer {
  pageCount: number;
  currentPage(): number;
  goToPage(page: number): void;
  onPageChange(listener: (page: number) => void): () => void;
  renderThumbnail(page: number, canvas: HTMLCanvasElement): Promise<void>;
}
