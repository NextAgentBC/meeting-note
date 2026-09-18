// Local WebP fallback for Safari/PWA builds that cannot encode WebP with Canvas.
// The codec is vendored from @jsquash/webp (Apache-2.0) and never sends pixels off-device.
import createEncoder from "./webp_enc.js";

const defaults = {
  quality: 75,
  target_size: 0,
  target_PSNR: 0,
  method: 4,
  sns_strength: 50,
  filter_strength: 60,
  filter_sharpness: 0,
  filter_type: 1,
  partitions: 0,
  segments: 4,
  pass: 1,
  show_compressed: 0,
  preprocessing: 0,
  autofilter: 0,
  partition_limit: 0,
  alpha_compression: 1,
  alpha_filtering: 1,
  alpha_quality: 100,
  lossless: 0,
  exact: 0,
  image_hint: 0,
  emulate_jpeg_size: 0,
  thread_level: 0,
  low_memory: 1,
  near_lossless: 100,
  use_delta_palette: 0,
  use_sharp_yuv: 0
};

let encoder;

export async function encodeWebp(imageData, options = {}) {
  encoder ||= createEncoder({ noInitialRun: true });
  const module = await encoder;
  const result = module.encode(
    imageData.data,
    imageData.width,
    imageData.height,
    { ...defaults, ...options }
  );
  if (!result) throw new Error("WebP encoding failed.");
  return result.buffer;
}
