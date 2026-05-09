// Animated WebP → MP4 (H.264) via ffmpeg.wasm single-thread.
// Uses CDN-loaded UMD globals: window.FFmpegWASM, window.FFmpegUtil.
//
// iOS Safari quirk: ffmpeg.wasm 0.12.x's default worker URL is cross-origin
// (unpkg) which iOS silently rejects for classic workers. We pre-fetch the
// 814.ffmpeg.js chunk as a Blob URL and pass it via classWorkerURL so
// ffmpeg.load() uses a same-origin module worker instead.

const FFMPEG_BASE = 'https://unpkg.com/@ffmpeg/ffmpeg@0.12.10/dist/umd';
const FFMPEG_WORKER_CHUNK = '814.ffmpeg.js';
const CORE_BASE = 'https://unpkg.com/@ffmpeg/core@0.12.6/dist/umd';
const LOAD_TIMEOUT_MS = 120_000;

const MSG_NO_FFMPEG = '변환 엔진을 사용할 수 없습니다';
const MSG_LOAD_FAIL = '변환 엔진을 불러오지 못했습니다. 인터넷 연결을 확인하고 다시 시도해주세요';
const MSG_LOAD_TIMEOUT = '변환 엔진 초기화 시간이 너무 오래 걸립니다. 페이지를 새로고침한 뒤 다시 시도해주세요';
const MSG_CONVERT_FAIL = '변환에 실패했습니다';

const STATUS = {
  workerDownloading: '워커 다운로드 중',
  coreDownloading: '코어 다운로드 중',
  wasmDownloading: '엔진 다운로드 중',
  initializing: '초기화 중 (최대 1~2분 소요)',
  ready: '준비 완료',
};

let ffmpegInstance = null;
let loadPromise = null;
let loadProgressCb = null;
let loadStatusCb = null;

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

export function onLoadStatus(cb) {
  loadStatusCb = cb;
}

function reportLoad(value) {
  if (loadProgressCb) loadProgressCb(Math.max(0, Math.min(1, value)));
}

function reportStatus(text) {
  if (loadStatusCb) loadStatusCb(text);
}

async function fetchAsBlobURL(url, mime, fromPct, toPct) {
  const response = await fetch(url, { mode: 'cors' });
  if (!response.ok) {
    throw new Error(`fetch failed: ${response.status} ${url}`);
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

function withTimeout(promise, ms, message) {
  let timer = null;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([
    promise.finally(() => {
      if (timer !== null) clearTimeout(timer);
    }),
    timeoutPromise,
  ]);
}

export async function loadFFmpeg() {
  if (ffmpegInstance) return ffmpegInstance;
  if (loadPromise) return loadPromise;

  loadPromise = (async () => {
    const { wasm } = getGlobals();
    const ffmpeg = new wasm.FFmpeg();

    try {
      reportStatus(STATUS.workerDownloading);
      let classWorkerURL = null;
      try {
        classWorkerURL = await fetchAsBlobURL(
          `${FFMPEG_BASE}/${FFMPEG_WORKER_CHUNK}`,
          'text/javascript',
          0,
          0.03,
        );
      } catch (err) {
        // Fall back to ffmpeg's default worker resolution.
        classWorkerURL = null;
      }

      reportStatus(STATUS.coreDownloading);
      const coreURL = await fetchAsBlobURL(
        `${CORE_BASE}/ffmpeg-core.js`,
        'text/javascript',
        0.03,
        0.08,
      );

      reportStatus(STATUS.wasmDownloading);
      const wasmURL = await fetchAsBlobURL(
        `${CORE_BASE}/ffmpeg-core.wasm`,
        'application/wasm',
        0.08,
        0.93,
      );

      reportStatus(STATUS.initializing);
      reportLoad(0.95);

      const config = classWorkerURL
        ? { classWorkerURL, coreURL, wasmURL }
        : { coreURL, wasmURL };

      await withTimeout(ffmpeg.load(config), LOAD_TIMEOUT_MS, MSG_LOAD_TIMEOUT);

      ffmpegInstance = ffmpeg;
      reportLoad(1);
      reportStatus(STATUS.ready);
      return ffmpeg;
    } catch (err) {
      loadPromise = null;
      try { ffmpeg.terminate?.(); } catch (_) { /* ignore */ }
      if (err && err.message && err.message === MSG_LOAD_TIMEOUT) {
        throw err;
      }
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

  const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const inputName = `input_${stamp}.webp`;
  const outputName = `output_${stamp}.mp4`;

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
    const blob = new Blob(
      [view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength)],
      { type: 'video/mp4' },
    );
    if (onProgress) onProgress(1);

    try { await ffmpeg.deleteFile(inputName); } catch (_) { /* ignore */ }
    try { await ffmpeg.deleteFile(outputName); } catch (_) { /* ignore */ }

    return blob;
  } catch (err) {
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
