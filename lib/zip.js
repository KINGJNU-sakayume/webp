// JSZip wrapper for "Download all" feature.
// Relies on the global JSZip from the UMD CDN script in index.html.

const MSG_NO_ZIP = 'ZIP 라이브러리를 불러오지 못했습니다';

export async function makeZip(items) {
  if (typeof window.JSZip !== 'function') {
    throw new Error(MSG_NO_ZIP);
  }
  const zip = new window.JSZip();
  const usedNames = new Set();
  for (const { filename, blob } of items) {
    if (!blob) continue;
    const safe = uniqueName(filename, usedNames);
    zip.file(safe, blob);
  }
  return zip.generateAsync({ type: 'blob', compression: 'STORE' });
}

function uniqueName(name, used) {
  if (!used.has(name)) {
    used.add(name);
    return name;
  }
  const dot = name.lastIndexOf('.');
  const base = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  let i = 2;
  while (used.has(`${base}_${i}${ext}`)) i += 1;
  const next = `${base}_${i}${ext}`;
  used.add(next);
  return next;
}
