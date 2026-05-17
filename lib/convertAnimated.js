// Animated WebP → MP4 (H.264) via ffmpeg.wasm single-thread.
// Uses CDN-loaded UMD globals: window.FFmpegWASM, window.FFmpegUtil.
//
// iOS Safari constraint: the @ffmpeg/ffmpeg UMD bundle's default worker
// resolution constructs `new Worker("<base>/814.ffmpeg.js", { type: void 0 })`
// — a CLASSIC worker. iOS Safari silently blocks cross-origin classic
// workers, and 814.ffmpeg.js is bundled as classic (no import/export, uses
// importScripts), so passing it as classWorkerURL would force `type: "module"`
// which fails to parse as a module → silent worker death.
//
// The only working pattern: serve both ffmpeg.js AND 814.ffmpeg.js
// SAME-ORIGIN. We rely on `<script src="./vendor/ffmpeg.js">` in index.html
// being served from the same GitHub Pages origin, which makes
// `document.currentScript.src` (= webpack runtime's publicPath) same-origin,
// and the default worker URL resolves to `./vendor/814.ffmpeg.js`.
//
// The vendor/ directory is populated at deploy time by .github/workflows/deploy.yml
// downloading from unpkg, so the repo stays small.

const CDN_BASES = {
  core: [
    'https://unpkg.com/@ffmpeg/core@0.12.6/dist/umd',
    'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.6/dist/umd',
  ],
};
const LOAD_TIMEOUT_MS = 120_000;
const XHR_TIMEOUT_MS = 60_000;
const FETCH_ATTEMPTS = 3;
const FETCH_RETRY_DELAY_MS = 1500;

const MSG_NO_FFMPEG = '변환 엔진을 사용할 수 없습니다 (vendor/ffmpeg.js 파일이 누락된 것 같습니다)';
const MSG_LOAD_FAIL = '변환 엔진을 불러오지 못했습니다. 인터넷 연결을 확인하고 다시 시도해주세요';
const MSG_LOAD_TIMEOUT = '변환 엔진 초기화 시간이 너무 오래 걸립니다. 페이지를 새로고침한 뒤 다시 시도해주세요';
const MSG_CONVERT_FAIL = '변환에 실패했습니다';

const STATUS = {
  coreDownloading: '코어 다운로드 중',
  wasmDownloading: '엔진 다운로드 중',
  initializing: '초기화 중 (최대 1~2분 소요)',
  ready: '준비 완료',
};

let ffmpegInstance = null;
let loadPromise = null;
let loadProgressCb = null;
let loadStatusCb = null;
let loadDetailCb = null;
let createdBlobURLs = [];

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

export function onLoadProgress(cb) { loadProgressCb = cb; }
export function onLoadStatus(cb) { loadStatusCb = cb; }
export function onLoadDetail(cb) { loadDetailCb = cb; }

function reportLoad(value) {
  if (loadProgressCb) loadProgressCb(Math.max(0, Math.min(1, value)));
}

function reportStatus(text) {
  if (loadStatusCb) loadStatusCb(text);
}

function reportDetail(text) {
  if (loadDetailCb) loadDetailCb(text || '');
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function xhrFetchBlobURL(url, mime, fromPct, toPct) {
  return new Promise((resolve, reject) => {
    let xhr;
    try {
      xhr = new XMLHttpRequest();
    } catch (err) {
      reject(new Error('XMLHttpRequest 생성 실패'));
      return;
    }
    xhr.open('GET', url, true);
    xhr.responseType = 'arraybuffer';
    xhr.timeout = XHR_TIMEOUT_MS;

    xhr.onprogress = (event) => {
      if (event.lengthComputable && loadProgressCb && toPct > fromPct) {
        const slice = fromPct + (event.loaded / event.total) * (toPct - fromPct);
        reportLoad(slice);
      }
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300 && xhr.response) {
        const blob = new Blob([xhr.response], { type: mime });
        const blobURL = URL.createObjectURL(blob);
        createdBlobURLs.push(blobURL);
        reportLoad(toPct);
        resolve(blobURL);
      } else {
        reject(new Error(`HTTP ${xhr.status || 'error'}`));
      }
    };
    xhr.onerror = () => reject(new Error('네트워크 오류'));
    xhr.ontimeout = () => reject(new Error('다운로드 타임아웃'));
    xhr.onabort = () => reject(new Error('중단됨'));

    try {
      xhr.send();
    } catch (err) {
      reject(new Error(`전송 실패: ${err && err.message ? err.message : err}`));
    }
  });
}

async function fetchWithFallback(urls, mime, fromPct, toPct) {
  let lastErr = null;
  for (let attempt = 0; attempt < FETCH_ATTEMPTS; attempt++) {
    for (const url of urls) {
      try {
        return await xhrFetchBlobURL(url, mime, fromPct, toPct);
      } catch (err) {
        lastErr = err;
        // eslint-disable-next-line no-console
        console.warn(`[ffmpeg load] fetch failed (attempt ${attempt + 1}): ${url}`, err && err.message);
      }
    }
    if (attempt < FETCH_ATTEMPTS - 1) {
      reportDetail(`재시도 중 (${attempt + 2}/${FETCH_ATTEMPTS})`);
      await delay(FETCH_RETRY_DELAY_MS * (attempt + 1));
    }
  }
  reportDetail('');
  throw lastErr || new Error('fetch failed');
}

function revokeBlobURLs() {
  for (const url of createdBlobURLs) {
    try { URL.revokeObjectURL(url); } catch (_) { /* ignore */ }
  }
  createdBlobURLs = [];
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
      reportDetail('');

      reportStatus(STATUS.coreDownloading);
      const corePaths = CDN_BASES.core.map((b) => `${b}/ffmpeg-core.js`);
      const coreURL = await fetchWithFallback(corePaths, 'text/javascript', 0, 0.06);

      reportStatus(STATUS.wasmDownloading);
      const wasmPaths = CDN_BASES.core.map((b) => `${b}/ffmpeg-core.wasm`);
      const wasmURL = await fetchWithFallback(wasmPaths, 'application/wasm', 0.06, 0.93);

      reportStatus(STATUS.initializing);
      reportLoad(0.95);

      // No classWorkerURL — ffmpeg.wasm's default worker resolution
      // resolves `./814.ffmpeg.js` relative to the same-origin ffmpeg.js
      // script (loaded from ./vendor/ffmpeg.js in index.html).
      await withTimeout(
        ffmpeg.load({ coreURL, wasmURL }),
        LOAD_TIMEOUT_MS,
        MSG_LOAD_TIMEOUT,
      );

      ffmpegInstance = ffmpeg;
      reportLoad(1);
      reportStatus(STATUS.ready);
      reportDetail('');
      return ffmpeg;
    } catch (err) {
      loadPromise = null;
      revokeBlobURLs();
      try { ffmpeg.terminate?.(); } catch (_) { /* ignore */ }
      // eslint-disable-next-line no-console
      console.error('[ffmpeg load] failed', err);
      const detail = err && err.message ? err.message : '';
      reportDetail(detail);
      if (err && err.message === MSG_LOAD_TIMEOUT) {
        throw err;
      }
      const wrapped = new Error(MSG_LOAD_FAIL);
      wrapped.detail = detail;
      throw wrapped;
    }
  })();

  return loadPromise;
}

export async function resetFFmpeg() {
  if (ffmpegInstance) {
    try { ffmpegInstance.terminate(); } catch (_) { /* ignore */ }
    ffmpegInstance = null;
  }
  revokeBlobURLs();
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
