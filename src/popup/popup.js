// popup.js — キャッシュの一覧と再コピー

const CACHE_KEY = 'cache';
const DEFAULT_MAX = 20;
const grid = document.getElementById('grid');
const empty = document.getElementById('empty');
const status = document.getElementById('status');
const maxSelect = document.getElementById('max');

init();

async function init() {
  const { [CACHE_KEY]: cache = [], maxItems = DEFAULT_MAX } = await chrome.storage.local.get([CACHE_KEY, 'maxItems']);
  maxSelect.value = String(maxItems);
  render(cache);

  maxSelect.addEventListener('change', async () => {
    const maxItems = Number(maxSelect.value);
    const { [CACHE_KEY]: cache = [] } = await chrome.storage.local.get(CACHE_KEY);
    const trimmed = cache.slice(0, maxItems);
    await chrome.storage.local.set({ maxItems, [CACHE_KEY]: trimmed });
    render(trimmed);
  });

  document.getElementById('clear').addEventListener('click', async () => {
    await chrome.storage.local.set({ [CACHE_KEY]: [] });
    render([]);
    status.textContent = '削除しました';
  });
}

function render(cache) {
  grid.replaceChildren();
  empty.hidden = cache.length > 0;

  for (const entry of cache) {
    const tile = document.createElement('button');
    tile.type = 'button';
    tile.className = 'tile';
    tile.title = label(entry);

    const img = document.createElement('img');
    img.src = entry.dataUrl;
    img.alt = label(entry);
    tile.appendChild(img);

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'remove';
    remove.textContent = '×';
    remove.title = 'この画像を削除';
    tile.appendChild(remove);

    tile.addEventListener('click', (e) => {
      if (e.target === remove) return;
      copy(entry, tile);
    });
    remove.addEventListener('click', (e) => {
      e.stopPropagation();
      drop(entry.id);
    });

    grid.appendChild(tile);
  }
}

function label(entry) {
  const size = entry.width && entry.height ? `${entry.width}×${entry.height} · ` : '';
  return `${size}${entry.pageTitle || entry.pageUrl || ''}`;
}

// ポップアップはユーザー操作の直後かつフォーカスもあるので、素直に書き込める
async function copy(entry, tile) {
  try {
    const blob = await (await fetch(entry.dataUrl)).blob();
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
    tile.classList.add('copied');
    setTimeout(() => tile.classList.remove('copied'), 700);
    status.textContent = 'コピーしました';
    bumpToFront(entry.id);
  } catch (err) {
    status.textContent = `失敗: ${err.message}`;
  }
}

async function bumpToFront(id) {
  const { [CACHE_KEY]: cache = [] } = await chrome.storage.local.get(CACHE_KEY);
  const i = cache.findIndex((e) => e.id === id);
  if (i <= 0) return;
  const [entry] = cache.splice(i, 1);
  entry.copiedAt = Date.now();
  cache.unshift(entry);
  await chrome.storage.local.set({ [CACHE_KEY]: cache });
  render(cache);
}

async function drop(id) {
  const { [CACHE_KEY]: cache = [] } = await chrome.storage.local.get(CACHE_KEY);
  const next = cache.filter((e) => e.id !== id);
  await chrome.storage.local.set({ [CACHE_KEY]: next });
  render(next);
}
