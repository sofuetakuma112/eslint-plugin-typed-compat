# eslint-plugin-typed-compat

[English](README.md) | 日本語

browserslist の対象ブラウザが対応していない Web API と JavaScript API を報告する、型情報を使う ESLint ルールです。

プロパティアクセス、グローバル変数、コンストラクタ、イベントリスナーを TypeScript の型チェッカーで解決し、[@mdn/browser-compat-data](https://github.com/mdn/browser-compat-data) の対応するエントリを探して、browserslist のクエリが指すバージョンと照らし合わせます。

```ts
// .browserslistrc: chrome >= 109, ios_saf >= 15.6
export const signal = AbortSignal.timeout(5000);
// "api.AbortSignal.timeout_static" is not supported in Safari on iOS 15.6

export const guarded = 'timeout' in AbortSignal ? AbortSignal.timeout(5000) : undefined; // 報告されない
```

## インストール

```sh
npm install --save-dev eslint-plugin-typed-compat typescript-eslint
```

Node.js `^20.19.0 || ^22.13.0 || >=24`、ESLint 9 または 10、TypeScript が必要です。

## 使い方

このルールは型情報を使うので、typescript-eslint の `projectService`（または `project`）を有効にしてください。

```js
// eslint.config.js
import tseslint from 'typescript-eslint';
import typedCompat from 'eslint-plugin-typed-compat';

export default [
  {
    files: ['src/**/*.{ts,tsx}'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    plugins: { 'typed-compat': typedCompat },
    rules: { 'typed-compat/compat': 'error' },
  },
];
```

## オプション

```js
'typed-compat/compat': ['error', {
  browserslist: ['chrome >= 109', 'ios_saf >= 15.6'],
  ignore: ['javascript', 'api.HTMLMediaElement.volume'],
  partialImplementation: 'unsupported',
}]
```

- `browserslist`: クエリ 1 つ、またはクエリの配列です。省略すると、lint 対象のファイルに適用される browserslist の設定を使います。
- `ignore`: 検査しない browser-compat-data のキーです。指定したキーの配下にあるキーもすべて検査しないので、`javascript` を指定すると JavaScript の組み込みオブジェクトをすべて除外できます。core-js で polyfill している場合に便利です。
- `partialImplementation`: `supported`（既定値）では、browser-compat-data が部分実装としているバージョンを対応済みとみなします。`unsupported` ではそれらも報告するので、iPhone の `MediaSource` のようなケースも検出できます。

報告メッセージには browser-compat-data のキーが含まれているので、そのまま `ignore` にコピーできます。

## 検査対象

- インスタンスメンバー。mixin や基底インターフェースから継承したメンバーも含みます（`video.requestPictureInPicture()`、`el.ariaLabel`）
- 静的メンバー（`URL.parse()`、`AbortSignal.timeout()`）。別名、分割代入、計算プロパティ名を経由した参照も含みます
- グローバル変数とコンストラクタ（`requestIdleCallback()`、`new CompressionStream()`）。`window`、`globalThis`、`self` を経由した参照も含みます
- `addEventListener` と `on*` ハンドラプロパティで登録するイベント（`scrollend`）
- TypeScript の DOM ライブラリにまだ宣言されていない API（`new EyeDropper()`、`ReadableStream.from()`）
- JavaScript の組み込みオブジェクト（`Array.prototype.at`、`Set.prototype.union`、`Iterator.prototype.map`）、`Intl`、`WebAssembly`

## 機能検出

次のような機能検出の内側での使用は報告しません。

```ts
if ('parse' in URL) URL.parse(input);
if (typeof URL.parse === 'function') URL.parse(input);
const canParse = 'parse' in URL;
if (canParse) URL.parse(input);
if (!('parse' in URL)) return;
URL.parse(input);
URL.parse?.(input);
'parse' in URL ? URL.parse(input) : fallback(input);
```

真偽値のチェックや `null` のチェックを機能検出とみなすのは、その API の宣言上の型が `null` にも `undefined` にもならない場合だけです。`document.fullscreenElement != null` は値を比べているだけなので、報告の対象のままです。

`if (isFullscreenSupported())` のように、ヘルパー関数の中に隠れたチェックは認識できません。その場合は `ignore` か disable コメントを使ってください。

## 制限

- 引数の値やオプションのオブジェクトは検査しません（`setActionHandler('enterpictureinpicture')`、`scrollIntoView({ behavior })`）。
- JSX の属性と CSS は検査しません。
- `any` 型の値は解決できません。

## @koddsson/eslint-plugin-tscompat との比較

このルールは、[@koddsson/eslint-plugin-tscompat](https://github.com/koddsson/eslint-plugin-tscompat) が報告する箇所をすべて報告します。ただし、次の場合は報告しません。いずれも tscompat の誤検出です。

- 使用が機能検出で守られている場合。
- browser-compat-data が古いバージョンだけを部分実装としている場合。tscompat は最新の対応情報しか読まないため、Safari 16.4 の `ctx.font` を報告します。これらを報告したいときは `partialImplementation: 'unsupported'` を設定してください。
- パッケージから import した識別子が、Web API と名前が同じなだけの場合。rxjs の `Observable` などです。
- 対応済みのインターフェースから継承したメンバーで、未対応なのはオブジェクトの型だけの場合。`PerformanceEventTiming` の `entry.startTime` などです。

テストスイートでは、tscompat 自身のテストケースに両方のルールを実行して、この性質を確かめています。

## 謝辞

`tests/data/tscompat.json` は、MIT License で公開されている [@koddsson/eslint-plugin-tscompat](https://github.com/koddsson/eslint-plugin-tscompat) のテストケースをもとにしています。`tests/data/LICENSE-tscompat` を参照してください。
