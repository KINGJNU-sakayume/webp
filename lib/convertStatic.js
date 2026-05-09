// Static WebP → JPEG via Canvas. Quality 0.92 per spec.

const JPEG_QUALITY = 0.92;
const MSG_DECODE_FAIL = '이미지를 디코딩하지 못했습니다';
const MSG_ENCODE_FAIL = 'JPEG으로 변환하지 못했습니다';

async function decodeBitmap(file) {
  if (typeof createImageBitmap === 'function') {
    try {
      return await createImageBitmap(file);
    } catch (_) {
      // Fall through to <img> path.
    }
  }
  return decodeViaImage(file);
}

function decodeViaImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.decoding = 'async';
    img.onload = async () => {
      try {
        if (typeof img.decode === 'function') await img.decode();
        resolve({
          width: img.naturalWidth,
          height: img.naturalHeight,
          source: img,
          revoke: () => URL.revokeObjectURL(url),
        });
      } catch (err) {
        URL.revokeObjectURL(url);
        reject(err);
      }
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error(MSG_DECODE_FAIL));
    };
    img.src = url;
  });
}

function drawAndEncode(bitmap, width, height) {
  if (typeof OffscreenCanvas === 'function') {
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error(MSG_ENCODE_FAIL);
    ctx.drawImage(bitmap, 0, 0);
    if (typeof canvas.convertToBlob === 'function') {
      return canvas.convertToBlob({ type: 'image/jpeg', quality: JPEG_QUALITY });
    }
  }
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error(MSG_ENCODE_FAIL);
  ctx.drawImage(bitmap, 0, 0);
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error(MSG_ENCODE_FAIL))),
      'image/jpeg',
      JPEG_QUALITY,
    );
  });
}

export async function convertStaticToJpeg(file) {
  let bitmap = null;
  let width = 0;
  let height = 0;
  let revoke = null;
  let source = null;

  try {
    const decoded = await decodeBitmap(file);
    if (decoded && typeof decoded.width === 'number' && decoded.source) {
      // Image-element path.
      width = decoded.width;
      height = decoded.height;
      source = decoded.source;
      revoke = decoded.revoke;
    } else {
      bitmap = decoded;
      width = bitmap.width;
      height = bitmap.height;
      source = bitmap;
    }

    if (!width || !height) throw new Error(MSG_DECODE_FAIL);

    const blob = await drawAndEncode(source, width, height);
    if (!blob) throw new Error(MSG_ENCODE_FAIL);
    return blob;
  } finally {
    if (bitmap && typeof bitmap.close === 'function') bitmap.close();
    if (typeof revoke === 'function') revoke();
  }
}
