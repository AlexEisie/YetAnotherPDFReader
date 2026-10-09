/**
 * Image helpers for image stamps and signatures: decoding, down-scaling and RGBA extraction.
 */
import type { StampImage } from "./model";

/** Images are down-scaled to this size before embedding (keeps documents small). */
const MAX_DIMENSION = 2048;
export const MAX_IMAGE_BYTES = 40 * 1024 * 1024;

async function hashBytes(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return Array.from(new Uint8Array(digest).slice(0, 12), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Rasterise a canvas into a stamp image (non-premultiplied RGBA + PNG data URL). */
export async function imageFromCanvas(canvas: HTMLCanvasElement): Promise<StampImage> {
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("2D canvas unavailable");
  const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const rgba = new Uint8Array(data.data.buffer.slice(0));
  return {
    id: await hashBytes(rgba),
    width: canvas.width,
    height: canvas.height,
    rgba,
    url: canvas.toDataURL("image/png"),
  };
}

async function imageFromBitmap(bitmap: ImageBitmap): Promise<StampImage> {
  const scale = Math.min(1, MAX_DIMENSION / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("2D canvas unavailable");
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const image = await imageFromCanvas(canvas);
  canvas.width = canvas.height = 0;
  return image;
}

/** Decode encoded image bytes (PNG, JPEG, WebP, GIF, BMP, SVG). */
export async function decodeImageBytes(bytes: Uint8Array, mime?: string): Promise<StampImage> {
  const blob = new Blob([bytes as BlobPart], mime ? { type: mime } : undefined);
  if (mime === "image/svg+xml") return decodeImageUrl(URL.createObjectURL(blob), true);
  return imageFromBitmap(await createImageBitmap(blob));
}

/** Decode an image from a (data or blob) URL. */
export async function decodeImageUrl(url: string, revoke = false): Promise<StampImage> {
  const img = new Image();
  img.decoding = "async";
  img.src = url;
  try {
    await img.decode();
    return await imageFromBitmap(await createImageBitmap(img));
  } finally {
    if (revoke) URL.revokeObjectURL(url);
  }
}

export function mimeFromPath(path: string): string | undefined {
  const ext = path.split(".").pop()?.toLowerCase();
  switch (ext) {
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "webp":
      return "image/webp";
    case "gif":
      return "image/gif";
    case "bmp":
      return "image/bmp";
    case "svg":
      return "image/svg+xml";
    default:
      return undefined;
  }
}

export const IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "webp", "gif", "bmp", "svg"];

/** Size (in PDF points) for placing an image so it fits within `maxW × maxH`. */
export function fitImage(image: Pick<StampImage, "width" | "height">, maxW: number, maxH: number): [number, number] {
  const scale = Math.min(maxW / image.width, maxH / image.height, 1);
  return [Math.max(8, image.width * scale), Math.max(8, image.height * scale)];
}
