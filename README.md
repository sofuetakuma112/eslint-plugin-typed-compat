# eslint-plugin-typed-compat

English | [日本語](https://github.com/sofuetakuma112/eslint-plugin-typed-compat/blob/main/README.ja.md)

A type-aware ESLint rule that reports Web and JavaScript APIs your browserslist targets do not support.

It resolves each property access, global, constructor and event listener through the TypeScript type checker, finds the matching entry in [@mdn/browser-compat-data](https://github.com/mdn/browser-compat-data), and compares it with the versions your browserslist query resolves to.

```ts
// .browserslistrc: chrome >= 109, ios_saf >= 15.6
export const signal = AbortSignal.timeout(5000);
// "api.AbortSignal.timeout_static" is not supported in Safari on iOS 15.6

export const guarded = 'timeout' in AbortSignal ? AbortSignal.timeout(5000) : undefined; // not reported
```

## Install

```sh
npm install --save-dev eslint-plugin-typed-compat typescript-eslint
```

It requires Node.js `^20.19.0 || ^22.13.0 || >=24`, ESLint 9 or 10, and TypeScript.

## Usage

The rule needs type information, so enable `projectService` (or `project`) in typescript-eslint.

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

## Options

```js
'typed-compat/compat': ['error', {
  browserslist: ['chrome >= 109', 'ios_saf >= 15.6'],
  ignore: ['javascript', 'api.HTMLMediaElement.volume'],
  partialImplementation: 'unsupported',
}]
```

- `browserslist`: A query or a list of queries. When omitted, the browserslist config that applies to the linted file is used.
- `ignore`: Keys of browser-compat-data to skip. An entry also skips every key under it, so `javascript` skips all JavaScript built-ins, which is useful when core-js polyfills them.
- `partialImplementation`: `supported` (default) treats versions that browser-compat-data marks as partial implementations as supported. `unsupported` reports them, which catches cases such as `MediaSource` on iPhone.

The message contains the browser-compat-data key, so it can be copied into `ignore` as is.

## What is checked

- Instance members, including members inherited from mixins and base interfaces (`video.requestPictureInPicture()`, `el.ariaLabel`)
- Static members (`URL.parse()`, `AbortSignal.timeout()`), also through aliases, destructuring and computed keys
- Globals and constructors, also through `window`, `globalThis` and `self` (`requestIdleCallback()`, `new CompressionStream()`)
- Events registered with `addEventListener` and `on*` handler properties (`scrollend`)
- APIs that the TypeScript DOM library does not declare yet (`new EyeDropper()`, `ReadableStream.from()`)
- JavaScript built-ins (`Array.prototype.at`, `Set.prototype.union`, `Iterator.prototype.map`), `Intl` and `WebAssembly`

## Feature detection

Uses inside these checks are not reported.

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

A truthiness or `null` check counts as feature detection only when the declared type of the API cannot be `null` or `undefined`. `document.fullscreenElement != null` compares a value and is still reported.

Checks hidden in helper functions such as `if (isFullscreenSupported())` are not recognized. Use `ignore` or a disable comment for them.

## Limitations

- Argument values and option dictionaries are not checked (`setActionHandler('enterpictureinpicture')`, `scrollIntoView({ behavior })`).
- JSX attributes and CSS are not checked.
- Values typed as `any` cannot be resolved.

## Compared with @koddsson/eslint-plugin-tscompat

This rule reports every place that [@koddsson/eslint-plugin-tscompat](https://github.com/koddsson/eslint-plugin-tscompat) reports, except in these cases, which tscompat reports by mistake:

- The use is guarded by feature detection.
- browser-compat-data marks only older versions as partial implementations. tscompat reads only the latest support statement, so it reports `ctx.font` on Safari 16.4. Set `partialImplementation: 'unsupported'` to report these.
- The identifier is imported from a package and only shares its name with a Web API, such as `Observable` from rxjs.
- The member is inherited from a supported interface, and only the type of the object is unsupported, such as `entry.startTime` on a `PerformanceEventTiming`.

The test suite runs both rules over tscompat's own test cases and checks this property.

## Acknowledgements

`tests/data/tscompat.json` is derived from the test cases of [@koddsson/eslint-plugin-tscompat](https://github.com/koddsson/eslint-plugin-tscompat), licensed under the MIT License. See `tests/data/LICENSE-tscompat`.
