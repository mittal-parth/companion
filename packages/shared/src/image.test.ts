/**
 * The image list is the one the chat offers and the daemon stores.
 */
import { expect, test } from "vitest";
import { isImageMime, maxImageBytes, maxImagesPerMessage } from "./image.js";

test("an image type is one of the four stored types", () => {
  expect(isImageMime("image/png")).toBe(true);
  expect(isImageMime("image/svg+xml")).toBe(false);
  expect(maxImagesPerMessage).toBe(4);
  expect(maxImageBytes).toBe(5_000_000);
});
