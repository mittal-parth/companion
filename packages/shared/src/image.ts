/**
 * The images a person can attach to one message.
 * The chat offers this list, and the daemon stores a file only when it matches.
 */

export const imageMimeTypes = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
] as const;

export type ImageMimeType = (typeof imageMimeTypes)[number];

/** How many images one message can carry. */
export const maxImagesPerMessage = 4;

/** The largest image the daemon will store. */
export const maxImageBytes = 5_000_000;

/**
 * A pasted image.
 * `data` is the file's base64, with no `data:` prefix, so a text-only model
 * can be handed a path instead of the bytes.
 */
export type AttachedImage = {
  mimeType: ImageMimeType;
  data: string;
};

/** Whether a type is one this app will store. */
export function isImageMime(value: string): value is ImageMimeType {
  switch (value) {
    case "image/png":
    case "image/jpeg":
    case "image/gif":
    case "image/webp":
      return true;
    default:
      return false;
  }
}
