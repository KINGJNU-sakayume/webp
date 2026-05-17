// Orchestrates UI, detection, conversion, and downloads.

import { detectWebP } from './lib/detect.js';
import { convertStaticToJpeg } from './lib/convertStatic.js';
import {
  convertAnimatedToMp4,
  checkAnimatedSupport,
} from './lib/convertAnimated.js';
import { FileCard } from './lib/ui.js';
import { makeZip } from './lib/zip.js';

const LIMIT_STATIC = 50 * 1024 * 1024; // 50MB
const LIMIT_ANIMATED = 20 * 1024 * 1024; // 20MB
const SOFT_WARN_ANIMATED = 10 * 1024 * 1024; // 10MB

const MSG = {
  notWebP: 'WebP 파일이 아닙니다',
  corrupted: '파일이 손상되었습니다',
  tooLargeStatic: '용량이 너무 큽니다 (정지 이미지는 최대 50MB)',
  tooLargeAnimated: '용량이 너무 큽니다 (애니메이션은 최대 20MB)',
  warnLargeAnimated: '큰 애니메이션 파일은 변환에 시간이 걸릴 수 있습니다',
  conversionFail: '변환에 실패했습니다',
  unsupported: '이 브라우저는 지원하지 않습니다. 최신 Chrome, Safari 또는 Edge를 사용해주세요',
};

const els = {
  dropzone: document.getElementById('dropzone'),
  fileInput: document.getElementById('fileInput'),
  fileList: document.getElementById('fileList'),
  cardTpl: document.getElementById('cardTemplate'),
  batchActions: document.getElementById('batchActions'),
  downloadAllBtn: document.getElementById('downloadAllBtn'),
  clearAllBtn: document.getElementById('clearAllBtn'),
  iosHint: document.getElementById('iosHint'),
  unsupported: document.getElementById('unsupported'),
  unsupportedMsg: document.getElementById('unsupportedMsg'),
};

const state = {
  cards: [],
  animatedQueue: Promise.resolve(),
};

function checkBrowserSupport() {
  if (typeof FileReader !== 'function') return MSG.unsupported;
  if (!('createElement' in document)) return MSG.unsupported;
  const canvas = document.createElement('canvas');
  if (!canvas.getContext || !canvas.getContext('2d')) return MSG.unsupported;
  return null;
}

function showUnsupported(msg) {
  els.unsupportedMsg.textContent = msg;
  els.unsupported.hidden = false;
}

const fileShare = (() => {
  if (typeof navigator === 'undefined') return { canShareFile: () => false, share: null };
  const canShareFile = (file) => {
    try {
      return Boolean(navigator.canShare && navigator.canShare({ files: [file] }));
    } catch (_) {
      return false;
    }
  };
  return {
    canShareFile,
    share: typeof navigator.share === 'function' ? navigator.share.bind(navigator) : null,
  };
})();

function basenameWithoutExt(name) {
  const slash = Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\'));
  const tail = slash >= 0 ? name.slice(slash + 1) : name;
  const dot = tail.lastIndexOf('.');
  return dot > 0 ? tail.slice(0, dot) : tail;
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

function ensureFile(blob, filename) {
  try {
    return new File([blob], filename, { type: blob.type, lastModified: Date.now() });
  } catch (_) {
    return null;
  }
}

function refreshBatchActions() {
  const completed = state.cards.filter((c) => c.state === 'done');
  if (state.cards.length >= 2 && completed.length >= 1) {
    els.batchActions.hidden = false;
    els.downloadAllBtn.disabled = completed.length < 2;
  } else {
    els.batchActions.hidden = true;
  }
  els.iosHint.hidden = completed.length === 0;
}

function removeCard(card) {
  const idx = state.cards.indexOf(card);
  if (idx >= 0) state.cards.splice(idx, 1);
  card.remove();
  refreshBatchActions();
}

async function handleDownload(card) {
  if (!card.result) return;
  downloadBlob(card.result.blob, card.result.filename);
}

async function handleShare(card) {
  if (!card.result || !fileShare.share) return;
  const file = ensureFile(card.result.blob, card.result.filename);
  if (!file || !fileShare.canShareFile(file)) {
    handleDownload(card);
    return;
  }
  try {
    await fileShare.share({ files: [file], title: card.result.filename });
  } catch (err) {
    if (err && err.name === 'AbortError') return;
    handleDownload(card);
  }
}

async function handleRetry(card) {
  await processFile(card.file, card);
}

async function handleDownloadAll() {
  const items = state.cards
    .filter((c) => c.state === 'done' && c.result)
    .map((c) => ({ filename: c.result.filename, blob: c.result.blob }));
  if (items.length === 0) return;
  els.downloadAllBtn.disabled = true;
  const originalLabel = els.downloadAllBtn.textContent;
  els.downloadAllBtn.textContent = 'ZIP 생성 중...';
  try {
    const zip = await makeZip(items);
    downloadBlob(zip, `webp-converted-${Date.now()}.zip`);
  } catch (_) {
    alert(MSG.conversionFail);
  } finally {
    els.downloadAllBtn.disabled = false;
    els.downloadAllBtn.textContent = originalLabel;
  }
}

function handleClearAll() {
  for (const card of [...state.cards]) removeCard(card);
}

function makeOutputName(input, ext) {
  return `${basenameWithoutExt(input.name)}.${ext}`;
}

async function processFile(file, existingCard) {
  let card = existingCard;
  if (!card) {
    card = new FileCard(els.cardTpl, file, {
      onDelete: removeCard,
      onDownload: handleDownload,
      onShare: handleShare,
      onRetry: handleRetry,
    });
    state.cards.push(card);
    els.fileList.appendChild(card.el);
  } else {
    card.setState('analyzing');
  }
  refreshBatchActions();

  let buffer;
  try {
    buffer = await file.arrayBuffer();
  } catch (_) {
    card.setError(MSG.corrupted);
    refreshBatchActions();
    return;
  }

  let kind;
  try {
    kind = detectWebP(buffer);
  } catch (err) {
    card.setError(err.message || MSG.notWebP);
    refreshBatchActions();
    return;
  }
  card.setType(kind);

  if (kind === 'static' && file.size > LIMIT_STATIC) {
    card.setError(MSG.tooLargeStatic);
    refreshBatchActions();
    return;
  }
  if (kind === 'animated' && file.size > LIMIT_ANIMATED) {
    card.setError(MSG.tooLargeAnimated);
    refreshBatchActions();
    return;
  }

  if (kind === 'static') {
    runStatic(card, file);
  } else {
    enqueueAnimated(card, file);
  }
}

async function runStatic(card, file) {
  card.setState('converting');
  card.setProgress(0.1);
  try {
    const blob = await convertStaticToJpeg(file);
    card.setProgress(1);
    completeCard(card, blob, makeOutputName(file, 'jpg'));
  } catch (err) {
    card.setError(
      err && err.message ? err.message : MSG.conversionFail,
      err && err.detail ? err.detail : '',
    );
    refreshBatchActions();
  }
}

function enqueueAnimated(card, file) {
  const showWarn = file.size > SOFT_WARN_ANIMATED;
  state.animatedQueue = state.animatedQueue.then(() => runAnimated(card, file, showWarn));
  return state.animatedQueue;
}

async function runAnimated(card, file, showWarn) {
  if (showWarn) card.setStatusText(MSG.warnLargeAnimated);

  card.setState('converting');
  card.setProgress(0);
  try {
    const blob = await convertAnimatedToMp4(file, {
      onProgress: (p) => card.setProgress(p),
    });
    completeCard(card, blob, makeOutputName(file, 'mp4'));
  } catch (err) {
    card.setError(
      err && err.message ? err.message : MSG.conversionFail,
      err && err.detail ? err.detail : '',
    );
    refreshBatchActions();
  }
}

function completeCard(card, blob, filename) {
  const file = ensureFile(blob, filename);
  const canShare = Boolean(file && fileShare.share && fileShare.canShareFile(file));
  card.setResult({ blob, filename, canShare });
  refreshBatchActions();
}

function isLikelyWebPName(name) {
  return /\.webp$/i.test(name);
}

function acceptFiles(fileList) {
  const files = Array.from(fileList || []);
  for (const file of files) {
    if (!file) continue;
    if (file.type && file.type !== 'image/webp' && !isLikelyWebPName(file.name)) {
      const card = new FileCard(els.cardTpl, file, {
        onDelete: removeCard,
        onDownload: handleDownload,
        onShare: handleShare,
        onRetry: handleRetry,
      });
      state.cards.push(card);
      els.fileList.appendChild(card.el);
      card.setError(MSG.notWebP);
      refreshBatchActions();
      continue;
    }
    processFile(file);
  }
}

function wireDropzone() {
  const dz = els.dropzone;
  const open = () => els.fileInput.click();

  dz.addEventListener('click', open);
  dz.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      open();
    }
  });

  els.fileInput.addEventListener('change', () => {
    acceptFiles(els.fileInput.files);
    els.fileInput.value = '';
  });

  const setDragover = (on) => dz.classList.toggle('is-dragover', on);

  ['dragenter', 'dragover'].forEach((ev) => {
    dz.addEventListener(ev, (e) => {
      e.preventDefault();
      e.stopPropagation();
      setDragover(true);
    });
  });
  ['dragleave', 'dragend'].forEach((ev) => {
    dz.addEventListener(ev, (e) => {
      e.preventDefault();
      e.stopPropagation();
      setDragover(false);
    });
  });
  dz.addEventListener('drop', (e) => {
    e.preventDefault();
    e.stopPropagation();
    setDragover(false);
    if (e.dataTransfer && e.dataTransfer.files) {
      acceptFiles(e.dataTransfer.files);
    }
  });

  // Prevent the browser from opening dropped files outside the dropzone.
  ['dragover', 'drop'].forEach((ev) => {
    window.addEventListener(ev, (e) => {
      if (!dz.contains(e.target)) e.preventDefault();
    });
  });
}

function wireBatchActions() {
  els.downloadAllBtn.addEventListener('click', handleDownloadAll);
  els.clearAllBtn.addEventListener('click', handleClearAll);
}

function init() {
  const issue = checkBrowserSupport();
  if (issue) {
    showUnsupported(issue);
    return;
  }
  wireDropzone();
  wireBatchActions();
  // Note: animated WebP support is checked at conversion time inside
  // convertAnimatedToMp4 (it needs ImageDecoder + VideoEncoder + Mp4Muxer).
  // Static WebP works in all browsers that pass the basic check above.
  // We surface a clear per-file Korean error if WebCodecs is missing rather
  // than blocking the whole app, so static still works on Firefox etc.
  if (checkAnimatedSupport() !== null) {
    // eslint-disable-next-line no-console
    console.warn('[webp converter] animated WebP support requires WebCodecs:', checkAnimatedSupport());
  }
}

init();
