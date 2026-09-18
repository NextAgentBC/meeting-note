import { chromium } from "playwright";

const baseUrl = process.env.BASE_URL || "http://127.0.0.1:8787";
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  const result = await page.evaluate(async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 1200;
    canvas.height = 900;
    const context = canvas.getContext("2d");
    context.fillStyle = "#365b4c";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = "#ffffff";
    context.font = "bold 72px sans-serif";
    context.fillText("JPEG → WebP", 260, 470);
    const jpeg = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", .9));
    const file = new File([jpeg], "iphone-camera.jpeg", { type: "image/jpeg" });
    const { compressPhoto } = await import("/captures.js");
    const photo = await compressPhoto(file);
    const fallback = await compressPhoto(file, { forceWasm: true });
    URL.revokeObjectURL(photo.previewUrl);
    URL.revokeObjectURL(fallback.previewUrl);
    return {
      fullType: photo.full.type,
      thumbType: photo.thumbnail.type,
      fullBytes: photo.full.size,
      thumbBytes: photo.thumbnail.size,
      width: photo.width,
      height: photo.height,
      fallbackType: fallback.full.type,
      fallbackBytes: fallback.full.size,
      fallbackSignature: [...new Uint8Array(await fallback.full.arrayBuffer()).slice(0, 12)]
    };
  });
  if (result.fullType !== "image/webp" || result.thumbType !== "image/webp") throw new Error(`Unexpected output: ${JSON.stringify(result)}`);
  if (!result.fullBytes || result.fullBytes > 2 * 1024 * 1024) throw new Error(`Full image size is invalid: ${result.fullBytes}`);
  if (!result.thumbBytes || result.thumbBytes > 320 * 1024) throw new Error(`Thumbnail size is invalid: ${result.thumbBytes}`);
  if (result.width !== 1200 || result.height !== 900) throw new Error(`Dimensions changed unexpectedly: ${result.width}×${result.height}`);
  if (result.fallbackType !== "image/webp" || !result.fallbackBytes) throw new Error(`WASM fallback failed: ${JSON.stringify(result)}`);
  const signature = String.fromCharCode(...result.fallbackSignature);
  if (!signature.startsWith("RIFF") || !signature.endsWith("WEBP")) throw new Error(`Invalid WebP signature: ${JSON.stringify(result.fallbackSignature)}`);
  console.log(`JPEG client conversion passed: native ${result.fullBytes} B, Safari fallback ${result.fallbackBytes} B.`);
} finally {
  await browser.close();
}
