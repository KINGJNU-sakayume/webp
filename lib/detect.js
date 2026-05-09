// WebP RIFF container parser.
// Returns 'animated' | 'static' for valid WebP files.
// Throws Error with a Korean message for invalid input.

const MSG_NOT_WEBP = 'WebP 파일이 아닙니다';
const MSG_CORRUPTED = '파일이 손상되었습니다';

function fourCC(view, offset) {
  return String.fromCharCode(
    view.getUint8(offset),
    view.getUint8(offset + 1),
    view.getUint8(offset + 2),
    view.getUint8(offset + 3),
  );
}

export function detectWebP(arrayBuffer) {
  if (!arrayBuffer || arrayBuffer.byteLength < 16) {
    throw new Error(MSG_NOT_WEBP);
  }

  const view = new DataView(arrayBuffer);

  if (fourCC(view, 0) !== 'RIFF' || fourCC(view, 8) !== 'WEBP') {
    throw new Error(MSG_NOT_WEBP);
  }

  const firstChunk = fourCC(view, 12);

  if (firstChunk === 'VP8 ' || firstChunk === 'VP8L') {
    return 'static';
  }

  if (firstChunk === 'VP8X') {
    if (arrayBuffer.byteLength < 21) throw new Error(MSG_CORRUPTED);
    const flags = view.getUint8(20);
    if ((flags & 0x02) !== 0) return 'animated';
    // Defense-in-depth: walk chunks for ANMF in case the flag was omitted.
    if (scanForAnmf(view)) return 'animated';
    return 'static';
  }

  throw new Error(MSG_CORRUPTED);
}

function scanForAnmf(view) {
  const total = view.byteLength;
  let offset = 12;
  while (offset + 8 <= total) {
    const id = fourCC(view, offset);
    const size = view.getUint32(offset + 4, true);
    if (id === 'ANMF' || id === 'ANIM') return true;
    // Chunk payload is padded to even length.
    const padded = size + (size & 1);
    offset += 8 + padded;
    if (!Number.isFinite(padded) || padded < 0) return false;
  }
  return false;
}
