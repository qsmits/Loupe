// Client-side preparation of dropped interferogram images: downscale to the
// size the server actually analyses so huge photos are not uploaded in vain.
// Pure helpers are Node-importable; DOM is only touched inside functions.

/** Mirrors _MAX_ANALYSIS_DIM in backend/api_fringe.py. */
export const FRINGE_UPLOAD_MAX_DIM = 2048;
/** Mirrors HOSTED_UPLOAD_BYTES in backend/image_upload.py. */
export const HOSTED_UPLOAD_MAX_BYTES = 20 * 1024 * 1024;

const JPEG_MIMES = new Set(["image/jpeg", "image/jpg", "image/pjpeg"]);

/**
 * Read pixel dimensions from PNG or JPEG header bytes.
 * JPEG dimensions are pre-EXIF-orientation (may be swapped for rotated
 * photos); callers only use the longest side, so that does not matter.
 * @param {Uint8Array} u8
 * @returns {{width:number,height:number}|null}
 */
export function imageDimensions(u8) {
  if (!u8 || u8.length < 4) return null;
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (u8.length >= 24 && sig.every((b, i) => u8[i] === b)) {
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    const width = dv.getUint32(16, false);
    const height = dv.getUint32(20, false);
    return width > 0 && height > 0 ? { width, height } : null;
  }
  if (u8[0] === 0xff && u8[1] === 0xd8) {
    let i = 2;
    while (i + 3 < u8.length) {
      if (u8[i] !== 0xff) return null;
      let marker = u8[i + 1];
      if (marker === 0xff) { i++; continue; } // fill byte
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) { i += 2; continue; }
      if (marker === 0xd9 || marker === 0xda) return null; // EOI / SOS before SOF
      const len = (u8[i + 2] << 8) | u8[i + 3];
      if (len < 2) return null;
      const isSof = marker >= 0xc0 && marker <= 0xcf &&
        marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isSof) {
        if (i + 9 > u8.length) return null;
        const height = (u8[i + 5] << 8) | u8[i + 6];
        const width = (u8[i + 7] << 8) | u8[i + 8];
        return width > 0 && height > 0 ? { width, height } : null;
      }
      i += 2 + len;
    }
    return null;
  }
  return null;
}

/**
 * Decide whether/how to resample an upload.
 * Returns null when the original bytes can be sent unchanged.
 *
 * A JPEG source has already lost what JPEG loses, so re-encoding as JPEG at
 * 0.95 after a >=2x area reduction is harmless for the DFT pipeline (the
 * carrier is low-passed with sigma ~ 0.76 periods, far below 8x8 block
 * artefacts); a lossless source stays lossless (PNG).
 */
export function planUpload(
  { width, height, type, size },
  maxDim = FRINGE_UPLOAD_MAX_DIM,
  maxBytes = HOSTED_UPLOAD_MAX_BYTES,
) {
  const longest = Math.max(width, height);
  if (longest <= maxDim && size <= maxBytes) return null;
  const scale = Math.min(1, maxDim / longest);
  const isJpeg = JPEG_MIMES.has(String(type || "").toLowerCase());
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
    mime: isJpeg ? "image/jpeg" : "image/png",
    quality: isJpeg ? 0.95 : undefined,
  };
}

/** @param {Uint8Array} u8 */
export function bytesToBase64(u8) {
  let binary = "";
  const chunk = 8192;
  for (let i = 0; i < u8.length; i += chunk) {
    binary += String.fromCharCode.apply(null, u8.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/** Sniff MIME from the start of a base64 image string. */
export function mimeFromBase64(b64) {
  if (typeof b64 === "string") {
    if (b64.startsWith("iVBORw0KGgo")) return "image/png";
    if (b64.startsWith("/9j/")) return "image/jpeg";
  }
  return "application/octet-stream";
}

function sniffMime(u8) {
  if (u8[0] === 0x89 && u8[1] === 0x50) return "image/png";
  if (u8[0] === 0xff && u8[1] === 0xd8) return "image/jpeg";
  return "application/octet-stream";
}

async function decodeFull(file) {
  if (typeof createImageBitmap === "function") return await createImageBitmap(file);
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return img;
  } finally {
    URL.revokeObjectURL(url);
  }
}

function closeSource(src) {
  try { if (src && typeof src.close === "function") src.close(); } catch { /* ignore */ }
}

/**
 * Browser only. Downscale/re-encode the file if the server would reject or
 * downsample it anyway; otherwise return the original bytes.
 */
export async function prepareInterferogramUpload(file) {
  const u8 = new Uint8Array(await file.arrayBuffer());
  const mimeOrig = file.type || sniffMime(u8);
  const unchanged = (w = 0, h = 0) => ({
    bytes: u8, blob: file, mime: mimeOrig, width: w, height: h,
    scaled: false, originalWidth: w, originalHeight: h,
  });
  let dims = null;
  try {
    // Header dimensions are pre-EXIF-orientation, but the longest side is
    // invariant under rotation, so they are enough to skip the decode when
    // nothing needs to change (the common case for camera frames).
    const headerDims = imageDimensions(u8);
    if (headerDims && !planUpload({ ...headerDims, type: file.type, size: u8.length })) {
      return unchanged(headerDims.width, headerDims.height);
    }

    // Decode first and plan from the ORIENTED size: a portrait phone photo is
    // stored as landscape sensor data plus an EXIF rotation, which the decoder
    // applies. Resizing straight from the file with header width/height would
    // squash such an image anisotropically.
    const full = await decodeFull(file);
    dims = { width: full.naturalWidth || full.width, height: full.naturalHeight || full.height };
    const plan = planUpload({ ...dims, type: file.type, size: u8.length });
    if (!plan) {
      closeSource(full);
      return unchanged(dims.width, dims.height);
    }

    let src = full;
    if (typeof createImageBitmap === "function") {
      try {
        const resized = await createImageBitmap(full, {
          resizeWidth: plan.width, resizeHeight: plan.height, resizeQuality: "high",
        });
        if (resized.width === plan.width && resized.height === plan.height) {
          closeSource(full);
          src = resized;
        } else {
          closeSource(resized);
        }
      } catch { /* fall back to drawImage scaling of the full bitmap */ }
    }
    try {
      const canvas = document.createElement("canvas");
      canvas.width = plan.width;
      canvas.height = plan.height;
      const ctx = canvas.getContext("2d");
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(src, 0, 0, plan.width, plan.height);
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, plan.mime, plan.quality));
      if (!blob) throw new Error("canvas.toBlob returned null");
      const bytes = new Uint8Array(await blob.arrayBuffer());
      return {
        bytes, blob, mime: plan.mime, width: plan.width, height: plan.height,
        scaled: true, originalWidth: dims.width, originalHeight: dims.height,
      };
    } finally {
      closeSource(src);
    }
  } catch (e) {
    console.warn("Interferogram downscale failed; uploading original:", e);
    return unchanged(dims ? dims.width : 0, dims ? dims.height : 0);
  }
}
