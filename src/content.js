// content.js — 右クリックした要素から画像を特定し、PNGにしてクリップボードへ

let lastTarget = null;

// contextmenu は capture で拾う。ページ側が stopPropagation していても取れる。
document.addEventListener(
  'contextmenu',
  (e) => {
    lastTarget = e.composedPath?.()[0] || e.target;
  },
  true,
);

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type !== 'COPY_CLICKED_ELEMENT') return;
  run(msg.srcUrl).catch((err) => toast(`コピーできませんでした: ${err.message}`, true));
});

async function run(srcUrlFromMenu) {
  const found = resolveImage(lastTarget) || (srcUrlFromMenu ? { kind: 'url', url: srcUrlFromMenu } : null);
  if (!found) throw new Error('画像が見つかりません');

  toast('コピー中…');

  let sourceBlob;
  let originUrl = '';

  if (found.kind === 'url') {
    originUrl = found.url;
    const res = await chrome.runtime.sendMessage({ type: 'FETCH_IMAGE', url: found.url });
    if (!res?.ok) throw new Error(res?.error || '取得に失敗しました');
    sourceBlob = await (await fetch(res.dataUrl)).blob();
  } else {
    sourceBlob = found.blob; // canvas / inline svg
  }

  const png = await toPngBlob(sourceBlob);
  await writeToClipboard(png);

  toast('コピーしました');

  chrome.runtime.sendMessage({
    type: 'CACHE_PUT',
    entry: {
      dataUrl: await blobToDataUrl(png),
      sourceUrl: originUrl,
      pageUrl: location.href,
      pageTitle: document.title,
      width: found.width || 0,
      height: found.height || 0,
    },
  });
}

/* ---------- 画像の特定 ---------- */

function resolveImage(el) {
  if (!el) return null;

  if (el.tagName === 'IMG' && (el.currentSrc || el.src)) {
    return { kind: 'url', url: el.currentSrc || el.src, width: el.naturalWidth, height: el.naturalHeight };
  }

  if (el.tagName === 'CANVAS') {
    return { kind: 'blob', blob: dataUrlToBlobSync(el.toDataURL('image/png')), width: el.width, height: el.height };
  }

  if (el.tagName === 'VIDEO' && el.poster) {
    return { kind: 'url', url: el.poster };
  }

  // インラインSVG（クリックしたのが内部の path などでも <svg> まで遡る）
  const svg = el.closest?.('svg');
  if (svg) {
    const xml = new XMLSerializer().serializeToString(svg);
    const rect = svg.getBoundingClientRect();
    return {
      kind: 'blob',
      blob: new Blob([xml], { type: 'image/svg+xml' }),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    };
  }

  // CSS の background-image。クリックした要素から数階層だけ遡る。
  let node = el;
  for (let depth = 0; node && node.nodeType === 1 && depth < 5; depth++, node = node.parentElement) {
    for (const pseudo of [null, '::before', '::after']) {
      const bg = getComputedStyle(node, pseudo).backgroundImage;
      const url = firstUrl(bg);
      if (url) {
        const rect = node.getBoundingClientRect();
        return { kind: 'url', url, width: Math.round(rect.width), height: Math.round(rect.height) };
      }
    }
  }

  return null;
}

// background-image は複数レイヤーや gradient が混ざるので、最初の url() だけ取る
function firstUrl(backgroundImage) {
  if (!backgroundImage || backgroundImage === 'none') return null;
  const m = backgroundImage.match(/url\((['"]?)(.*?)\1\)/);
  if (!m) return null;
  try {
    return new URL(m[2], location.href).href;
  } catch {
    return null;
  }
}

/* ---------- PNG への変換 ---------- */

// クリップボードが確実に受け付けるのは image/png だけなので、それ以外は描き直す。
// （GIFはこの時点で1コマ目の静止画になります）
async function toPngBlob(blob) {
  if (blob.type === 'image/png') return blob;

  const bitmap =
    blob.type === 'image/svg+xml'
      ? await svgToBitmap(blob)
      : await createImageBitmap(blob);

  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  canvas.getContext('2d').drawImage(bitmap, 0, 0);
  bitmap.close?.();
  return canvas.convertToBlob({ type: 'image/png' });
}

// SVGは createImageBitmap が直接受けないブラウザがあるので <img> 経由
function svgToBitmap(blob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      createImageBitmap(img).then(resolve, reject);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('SVGを描画できません'));
    };
    img.src = url;
  });
}

/* ---------- クリップボード ---------- */

async function writeToClipboard(pngBlob) {
  try {
    if (!document.hasFocus()) window.focus();
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': pngBlob })]);
  } catch (err) {
    // Async Clipboard API はフォーカスやユーザー操作の条件で落ちることがある。
    // contenteditable に <img> を置いて execCommand する古典的な方法が代替になる。
    await legacyCopy(pngBlob);
  }
}

function legacyCopy(pngBlob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(pngBlob);
    const holder = document.createElement('div');
    holder.contentEditable = 'true';
    holder.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0;';
    const img = document.createElement('img');
    img.src = url;
    holder.appendChild(img);
    document.body.appendChild(holder);

    img.onload = () => {
      const range = document.createRange();
      range.selectNode(img);
      const sel = getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      const ok = document.execCommand('copy');
      sel.removeAllRanges();
      holder.remove();
      URL.revokeObjectURL(url);
      ok ? resolve() : reject(new Error('クリップボードへの書き込みが拒否されました'));
    };
    img.onerror = () => {
      holder.remove();
      URL.revokeObjectURL(url);
      reject(new Error('画像を読み込めません'));
    };
  });
}

function blobToDataUrl(blob) {
  return new Promise((resolve) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.readAsDataURL(blob);
  });
}

function dataUrlToBlobSync(dataUrl) {
  const [head, b64] = dataUrl.split(',');
  const type = head.match(/:(.*?);/)[1];
  const bin = atob(b64);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return new Blob([buf], { type });
}

/* ---------- 通知 ---------- */

let toastEl;
let toastTimer;

function toast(text, isError = false) {
  if (!toastEl) {
    toastEl = document.createElement('div');
    toastEl.style.cssText = [
      'position:fixed',
      'z-index:2147483647',
      'right:16px',
      'bottom:16px',
      'padding:8px 14px',
      'border-radius:6px',
      'font:500 13px/1.4 system-ui,sans-serif',
      'color:#fff',
      'pointer-events:none',
      'transition:opacity .15s',
    ].join(';');
  }
  toastEl.textContent = text;
  toastEl.style.background = isError ? '#b4322c' : '#1f2226';
  toastEl.style.opacity = '1';
  document.body.appendChild(toastEl);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toastEl.style.opacity = '0';
  }, 1600);
}
