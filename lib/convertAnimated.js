// Animated WebP → MP4 (H.264) via ffmpeg.wasm single-thread.
// Uses CDN-loaded UMD globals: window.FFmpegWASM, window.FFmpegUtil.

const CORE_BASE = 'https://unpkg.com/@ffmpeg/core@0.12.6/dist/umd';

const MSG_NO_FFMPEG = '변환 엔진을 사용할 수 없습니다';
const MSG_LOAD_FAIL = '변환 엔진을 불러오지 못했습니다. 인터넷 연결을 확인하고 다시 시도해주세요';
const MSG_CONVERT_FAIL = '변환에 실패했습니다';

let ffmpegInstance = null;
let loadPromise = null;
let loadProgressCb = null;

function getGlobals() {
  const wasm = window.FFmpegWASM;
  const util = window.FFmpegUtil;
  if (!wasm || !util || !wasm.FFmpeg) {
    throw new Error(MSG_NO_FFMPEG);
  }
  return { wasm, util };
}

export function isFFmpegReady() {
  return Boolean(ffmpegInstance);
}

export function onLoadProgress(cb) {
  loadProgressCb = cb;
}

function reportLoad(value) {
  if (loadProgressCb) loadProgressCb(Math.max(0, Math.min(1, value)));
}

async function fetchWithProgress(url, mime, fromPct, toPct) {
  const response = await fetch(url, { mode: 'cors' });
  if (!response.ok) {
    throw new Error(`fetch failed: ${response.status}`);
  }
  const total = Number(response.headers.get('content-length')) || 0;
  if (!response.body || total === 0) {
    const buf = await response.arrayBuffer();
    reportLoad(toPct);
    return URL.createObjectURL(new Blob([buf], { type: mime }));
  }

  const reader = response.body.getReader();
  const chunks = [];
  let received = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.byteLength;
    if (loadProgressCb && total > 0) {
      const slice = fromPct + (received / total) * (toPct - fromPct);
      reportLoad(slice);
    }
  }
  const blob = new Blob(chunks, { type: mime });
  reportLoad(toPct);
  return URL.createObjectURL(blob);
}

export async function loadFFmpeg() {
  if (ffmpegInstance) return ffmpegInstance;
  if (loadPromise) return loadPromise;

  loadPromise = (async () => {
    const { wasm } = getGlobals();
    const ffmpeg = new wasm.FFmpeg();

    try {
      const coreURL = await fetchWithProgress(
        `${CORE_BASE}/ffmpeg-core.js`,
        'text/javascript',
        0,
        0.05,
      );
      const wasmURL = await fetchWithProgress(
        `${CORE_BASE}/ffmpeg-core.wasm`,
        'application/wasm',
        0.05,
        0.97,
      );

      await ffmpeg.load({ coreURL, wasmURL });
      ffmpegInstance = ffmpeg;
      reportLoad(1);
      return ffmpeg;
    } catch (err) {
      loadPromise = null;
      throw new Error(MSG_LOAD_FAIL);
    }
  })();

  return loadPromise;
}

export async function resetFFmpeg() {
  if (ffmpegInstance) {
    try {
      ffmpegInstance.terminate();
    } catch (_) {
      // ignore
    }
    ffmpegInstance = null;
  }
  loadPromise = null;
}

export async function convertAnimatedToMp4(file, { onProgress } = {}) {
  const ffmpeg = await loadFFmpeg();

  const inputName = `input_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.webp`;
  const outputName = `output_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.mp4`;

  const progressHandler = ({ progress }) => {
    if (typeof progress === 'number' && onProgress) {
      const clamped = Math.max(0, Math.min(1, progress));
      onProgress(clamped);
    }
  };
  ffmpeg.on('progress', progressHandler);

  try {
    const buffer = await file.arrayBuffer();
    await ffmpeg.writeFile(inputName, new Uint8Array(buffer));

    const code = await ffmpeg.exec([
      '-i', inputName,
      '-c:v', 'libx264',
      '-pix_fmt', 'yuv420p',
      '-profile:v', 'high',
      '-movflags', '+faststart',
      '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2',
      '-an',
      outputName,
    ]);

    if (code !== 0 && code !== undefined && code !== null) {
      throw new Error(MSG_CONVERT_FAIL);
    }

    const data = await ffmpeg.readFile(outputName);
    const view = data instanceof Uint8Array ? data : new Uint8Array(data);
    const blob = new Blob([view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength)], { type: 'video/mp4' });
    if (onProgress) onProgress(1);

    try { await ffmpeg.deleteFile(inputName); } catch (_) { /* ignore */ }
    try { await ffmpeg.deleteFile(outputName); } catch (_) { /* ignore */ }

    return blob;
  } catch (err) {
    // On failure, terminate the instance so the next call gets a fresh one.
    await resetFFmpeg();
    throw err instanceof Error ? err : new Error(MSG_CONVERT_FAIL);
  } finally {
    try {
      if (typeof ffmpeg.off === 'function') ffmpeg.off('progress', progressHandler);
    } catch (_) {
      // ignore
    }
  }
}
