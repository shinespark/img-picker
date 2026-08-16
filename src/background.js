// background.js — コンテキストメニュー、CORS回避のfetch、キャッシュ管理

const MENU_ID = 'copy-image-to-clipboard';
const CACHE_KEY = 'cache';
const DEFAULT_MAX = 15;          // 保持件数（10〜20の中央あたり）
const MAX_ENTRY_BYTES = 2_000_000; // 1件あたりこれを超えたらキャッシュしない（コピーはする）

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: MENU_ID,
    title: '画像をクリップボードにコピー',
    // "image" だと <img> にしか出ないので all にして、拾えるかは content 側で判定する
    contexts: ['all'],
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== MENU_ID || !tab?.id) return;
  chrome.tabs.sendMessage(
    tab.id,
    { type: 'COPY_CLICKED_ELEMENT', srcUrl: info.srcUrl },
    { frameId: info.frameId ?? 0 },
    () => void chrome.runtime.lastError, // 応答不要
  );
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === 'FETCH_IMAGE') {
    fetchImage(msg.url, sender.tab?.url).then(sendResponse, (err) =>
      sendResponse({ ok: false, error: String(err?.message || err) }),
    );
    return true; // 非同期応答
  }
  if (msg?.type === 'CACHE_PUT') {
    cachePut(msg.entry).then(() => sendResponse({ ok: true }), () => sendResponse({ ok: false }));
    return true;
  }
});

// content script から直接 fetch すると CORS で落ちるサイトが多い。
// host_permissions を持つ service worker から取れば素通しできる。
async function fetchImage(url, referrer) {
  if (url.startsWith('data:') || url.startsWith('blob:')) {
    return { ok: true, dataUrl: url, type: '' };
  }
  const res = await fetch(url, {
    credentials: 'include',
    referrer: referrer || undefined,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const blob = await res.blob();
  if (!blob.type.startsWith('image/') && !/\.(png|jpe?g|gif|webp|avif|svg)(\?|$)/i.test(url)) {
    throw new Error(`画像ではありません (${blob.type || 'unknown'})`);
  }
  return { ok: true, dataUrl: await blobToDataUrl(blob), type: blob.type };
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = () => reject(fr.error);
    fr.readAsDataURL(blob);
  });
}

async function cachePut(entry) {
  if (!entry?.dataUrl) return;
  if (entry.dataUrl.length > MAX_ENTRY_BYTES) return; // 大きすぎるものは残さない

  const { [CACHE_KEY]: cache = [], maxItems = DEFAULT_MAX } = await chrome.storage.local.get([
    CACHE_KEY,
    'maxItems',
  ]);

  // 同じ画像を再コピーしたら先頭に繰り上げる（LRU）
  const deduped = cache.filter((e) => e.dataUrl !== entry.dataUrl);
  deduped.unshift({ ...entry, id: crypto.randomUUID(), copiedAt: Date.now() });
  await chrome.storage.local.set({ [CACHE_KEY]: deduped.slice(0, maxItems) });
}
