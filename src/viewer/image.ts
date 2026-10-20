import { el } from "../dom";
import type { Doc } from "../types";
import type { Layer, Size } from "./types";

/** Fallback geometry for SVG files that declare no intrinsic size. */
const UNKNOWN_SIZE: Size = { width: 800, height: 600 };

/**
 * Rotation and flips are applied to a frame that reserves the *rotated* bounds,
 * so a quarter-turn keeps the document scrollable instead of clipping it.
 * Flips are listed outside the rotation on purpose: they mirror what the user
 * sees rather than the image's own axes.
 */
export async function createImageLayer(doc: Doc): Promise<Layer> {
  const image = new Image();
  image.src = doc.url;
  image.alt = doc.name;
  image.draggable = false;
  image.decoding = "async";

  await new Promise<void>((resolve, reject) => {
    if (image.complete && image.naturalWidth > 0) {
      resolve();
      return;
    }
    image.addEventListener("load", () => resolve(), { once: true });
    image.addEventListener(
      "error",
      () => reject(new Error(`Cannot decode ${doc.name}`)),
      { once: true },
    );
  });

  const natural: Size = {
    width: image.naturalWidth || UNKNOWN_SIZE.width,
    height: image.naturalHeight || UNKNOWN_SIZE.height,
  };

  const frame = el("div", { class: "image-frame" });
  frame.append(image);

  let zoom = 1;
  let rotation = 0;
  let flipH = false;
  let flipV = false;

  function draw(): void {
    const quarterTurn = rotation % 180 !== 0;
    const width = natural.width * zoom;
    const height = natural.height * zoom;

    frame.style.width = `${quarterTurn ? height : width}px`;
    frame.style.height = `${quarterTurn ? width : height}px`;
    image.style.width = `${width}px`;
    image.style.height = `${height}px`;
    image.style.transform =
      `translate(-50%, -50%)` +
      ` scaleX(${flipH ? -1 : 1}) scaleY(${flipV ? -1 : 1})` +
      ` rotate(${rotation}deg)`;
  }

  draw();

  return {
    element: frame,

    baseSize(): Size {
      return rotation % 180 !== 0
        ? { width: natural.height, height: natural.width }
        : { ...natural };
    },

    setZoom(next: number): void {
      zoom = next;
      draw();
    },

    setRotation(next: number, nextFlipH: boolean, nextFlipV: boolean): void {
      rotation = ((next % 360) + 360) % 360;
      flipH = nextFlipH;
      flipV = nextFlipV;
      draw();
    },

    destroy(): void {
      image.removeAttribute("src");
      frame.remove();
    },
  };
}
