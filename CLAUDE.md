# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 概要

Chrome 拡張（Manifest V3）。右クリックした画像を PNG に変換してクリップボードへコピーし、直近数件を `chrome.storage.local` にキャッシュしてポップアップから再コピーできるようにする。

## 構成

```
manifest.json        拡張ルートはリポジトリルート。パスはすべてここ起点
src/
  background.js      service worker
  content.js         全ページ・全フレームに注入
  popup/             popup.html / popup.js / popup.css
```

`manifest.json` をルートに置いているのは、`chrome://extensions` でリポジトリルートをそのまま読み込めるようにするため。`manifest.json` 内のパスは拡張ルート起点、`popup.html` から `popup.js` / `popup.css` への参照は同ディレクトリの相対パス。

## 開発フロー

ビルドツール・パッケージマネージャ・テストフレームワークは一切使っていない（`package.json` も無い）。素の JS/HTML/CSS をそのまま Chrome が読む。

- 動作確認: `chrome://extensions` →「パッケージ化されていない拡張機能を読み込む」でリポジトリルートを指定
- 変更の反映: `src/content.js` / `src/popup/*` はページ再読み込みで済むが、`src/background.js` と `manifest.json` を触ったら拡張の再読み込み（更新ボタン）が必要
- ログの場所が 3 つに分かれる: service worker（拡張詳細の「Service Worker」リンク）、content script（対象ページの DevTools）、popup（ポップアップを右クリック→検証）

## アーキテクチャ

3 コンテキストのメッセージパッシングで動く。役割分担には理由があるので崩さないこと。

- **src/background.js**（service worker）: コンテキストメニュー登録、画像の fetch、キャッシュ書き込み。
  - fetch を background で行うのは意図的。content script から直接 fetch すると CORS で落ちるサイトが多く、`host_permissions: <all_urls>` を持つ service worker からなら素通しできる。Blob は構造化クローンで送れないので data URL 文字列にして返す。
  - キャッシュは `chrome.storage.local` の `cache` キー（配列、先頭が最新）＋ `maxItems`。`dataUrl` 一致で重複排除して先頭に繰り上げる LRU。`MAX_ENTRY_BYTES` を超える 1 件は「コピーはするがキャッシュしない」。
- **src/content.js**: 右クリック対象の特定 → PNG 化 → クリップボード書き込み → トースト表示。
  - コンテキストメニューは `contexts: ['all']` で常に出し、実際に画像を拾えるかは content 側の `resolveImage()` が判定する（`'image'` だと `<img>` にしか出ないため）。
  - 対象要素は `contextmenu` を capture フェーズで拾って `lastTarget` に保持する。ページ側の `stopPropagation` を回避するため。`info.srcUrl` はフォールバック。
  - `resolveImage()` の判定順は img → canvas → video poster → 祖先の inline SVG → CSS `background-image`（`::before`/`::after` 含め 5 階層まで遡る）。
  - クリップボードが確実に受け付けるのは `image/png` のみなので、それ以外は OffscreenCanvas で描き直す（GIF は 1 コマ目の静止画になる）。SVG は `createImageBitmap` が直接受けない環境があるため `<img>` 経由。
  - `navigator.clipboard.write()` はフォーカス条件で失敗しうるので、contenteditable + `execCommand('copy')` のレガシー経路をフォールバックに持つ。
- **src/popup/**: キャッシュ一覧の表示、再コピー、削除、保持件数の変更。ポップアップはユーザー操作直後かつフォーカスがあるため、フォールバック無しで `navigator.clipboard.write()` してよい。

`content_scripts` は `all_frames: true` / `match_about_blank: true` / `run_at: document_start`。iframe 内の画像を拾うためで、background は `info.frameId` を指定して該当フレームにだけ送る。

## コメント方針

既存コードのコメントは「なぜそうしているか」だけを書いている（コードから自明な What は書かない）。この密度と方針に合わせる。

## UI 文言

ユーザー向け文字列はすべて日本語。
