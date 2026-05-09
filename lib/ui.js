// File card rendering & per-card state management.

const T = {
  analyzing: '분석 중...',
  converting: (pct) => `변환 중... ${pct}%`,
  preparing: '준비 중...',
  done: '완료',
  error: '오류',
  animated: '애니메이션',
  static: '정지 이미지',
};

const STATES = ['pending', 'analyzing', 'converting', 'done', 'error'];

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export class FileCard {
  constructor(template, file, callbacks) {
    const node = template.content.firstElementChild.cloneNode(true);
    this.el = node;
    this.file = file;
    this.callbacks = callbacks;

    this.elName = node.querySelector('.card-name');
    this.elSize = node.querySelector('.card-size');
    this.elBadge = node.querySelector('.badge-type');
    this.elStatus = node.querySelector('.card-status');
    this.elBar = node.querySelector('.progress-bar');
    this.elError = node.querySelector('.card-error');
    this.elActions = node.querySelector('.card-actions');
    this.btnDownload = node.querySelector('.card-download');
    this.btnShare = node.querySelector('.card-share');
    this.btnRetry = node.querySelector('.card-retry');
    this.btnDelete = node.querySelector('.card-delete');

    this.elName.textContent = file.name;
    this.elSize.textContent = formatSize(file.size);
    this.elBadge.textContent = '';
    this.elBadge.hidden = true;

    this.btnDelete.addEventListener('click', () => callbacks.onDelete?.(this));
    this.btnDownload.addEventListener('click', () => callbacks.onDownload?.(this));
    this.btnShare.addEventListener('click', () => callbacks.onShare?.(this));
    this.btnRetry.addEventListener('click', () => callbacks.onRetry?.(this));

    this.setState('analyzing');
  }

  setType(type) {
    this.type = type;
    this.elBadge.hidden = false;
    if (type === 'animated') {
      this.elBadge.textContent = T.animated;
      this.elBadge.className = 'badge badge-type badge-animated';
    } else {
      this.elBadge.textContent = T.static;
      this.elBadge.className = 'badge badge-type badge-static';
    }
  }

  setState(state) {
    if (!STATES.includes(state)) return;
    this.state = state;
    this.el.dataset.state = state;
    if (state === 'analyzing') {
      this.elStatus.textContent = T.analyzing;
      this.elError.hidden = true;
      this.elActions.hidden = true;
      this.elBar.style.width = '';
    } else if (state === 'converting') {
      this.elStatus.textContent = T.converting(0);
      this.elError.hidden = true;
      this.elActions.hidden = true;
      this.elBar.style.width = '0%';
    } else if (state === 'done') {
      this.elStatus.textContent = T.done;
      this.elError.hidden = true;
      this.elActions.hidden = false;
      this.btnRetry.hidden = true;
      this.elBar.style.width = '100%';
    } else if (state === 'error') {
      this.elStatus.textContent = T.error;
      this.elActions.hidden = false;
      this.btnRetry.hidden = false;
      this.btnDownload.hidden = true;
      this.btnShare.hidden = true;
      this.elBar.style.width = '100%';
    }
  }

  setProgress(value) {
    if (this.state !== 'converting') this.setState('converting');
    const pct = Math.max(0, Math.min(100, Math.round(value * 100)));
    this.elStatus.textContent = T.converting(pct);
    this.elBar.style.width = `${pct}%`;
  }

  setStatusText(text) {
    this.elStatus.textContent = text;
  }

  setError(message) {
    this.setState('error');
    this.elError.textContent = message;
    this.elError.hidden = false;
  }

  setResult({ blob, filename, canShare }) {
    this.result = { blob, filename };
    this.btnDownload.hidden = false;
    this.btnShare.hidden = !canShare;
    this.setState('done');
  }

  remove() {
    this.el.remove();
  }
}
