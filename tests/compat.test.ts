import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { lint, overlaps } from './lint.js';

type TscompatCase = {
  id: string;
  kind: 'valid' | 'invalid';
  code: string;
  browserslist: string[];
  expected: string[];
  difference?: string;
};

type CorpusCase = {
  id: string;
  api: string;
  pattern: string;
  code: string;
  expectation: 'unsupported' | 'supported' | 'guarded' | 'partial' | 'untyped';
  note?: string;
};

const tscompatCases = JSON.parse(
  readFileSync(new URL('./data/tscompat.json', import.meta.url), 'utf8'),
) as TscompatCase[];
const corpusCases = JSON.parse(
  readFileSync(new URL('./data/corpus.json', import.meta.url), 'utf8'),
) as CorpusCase[];

const CORPUS_BROWSERSLIST = [
  'baseline widely available on 2026-03-01',
  'chrome >= 109',
  'ios >= 15.8',
];

const COVERAGE_EXCEPTIONS = new Map([
  ['I034', 'window?.fetch?.() skips the call where fetch is missing'],
  ['g04', 'navigator.wakeLock?.request() skips the call where wakeLock is missing'],
  ['g05', "'requestVideoFrameCallback' in v guards the call"],
  ['h29', 'Firefox 116 to 121 partially support disablePictureInPicture'],
]);

const keysOf = async (code: string, options: Record<string, unknown>) =>
  [...new Set((await lint(code, options)).map((report) => report.key))].sort();

describe('tscompat test cases', () => {
  it.each(tscompatCases.map((c) => [c.id, c] as const))('%s', async (_id, c) => {
    expect(await keysOf(c.code, { browserslist: c.browserslist })).toEqual(c.expected);
    expect(c.expected.length > 0).toBe(
      c.kind === 'invalid' ? c.difference === undefined : c.difference !== undefined,
    );
  });
});

describe('corpus', () => {
  it.each(corpusCases.map((c) => [`${c.id} ${c.api} (${c.pattern})`, c] as const))(
    '%s',
    async (_name, c) => {
      const keys = await keysOf(c.code, { browserslist: CORPUS_BROWSERSLIST });
      const strictKeys = await keysOf(c.code, {
        browserslist: CORPUS_BROWSERSLIST,
        partialImplementation: 'unsupported',
      });
      expect(keys.length > 0).toBe(c.expectation === 'unsupported');
      expect(strictKeys.length > 0).toBe(
        c.expectation === 'unsupported' || c.expectation === 'partial',
      );
    },
  );
});

describe('covers every report of tscompat', () => {
  const cases = [
    ...tscompatCases.map((c) => ({ id: c.id, code: c.code, browserslist: c.browserslist })),
    ...corpusCases.map((c) => ({ id: c.id, code: c.code, browserslist: CORPUS_BROWSERSLIST })),
  ];
  it.each(cases.map((c) => [c.id, c] as const))('%s', async (id, c) => {
    const ours = await lint(c.code, { browserslist: c.browserslist });
    const theirs = await lint(
      c.code,
      { browserslist: c.browserslist },
      { ruleId: 'tscompat/tscompat' },
    );
    const uncovered = theirs.filter((report) => !ours.some((our) => overlaps(our, report)));
    expect(uncovered.length > 0).toBe(COVERAGE_EXCEPTIONS.has(id));
  });
});

describe('options', () => {
  it('ignores a key and every key under it', async () => {
    const code =
      'export const s = new Set<number>().union(new Set());\nexport const p = URL.parse("a");';
    const browserslist = ['chrome 109'];
    expect(await keysOf(code, { browserslist })).toEqual([
      'api.URL.parse_static',
      'javascript.builtins.Set.union',
    ]);
    expect(await keysOf(code, { browserslist, ignore: ['javascript'] })).toEqual([
      'api.URL.parse_static',
    ]);
    expect(await keysOf(code, { browserslist, ignore: ['api.URL.parse_static'] })).toEqual([
      'javascript.builtins.Set.union',
    ]);
  });

  it('reads targets from the browserslist config of the linted file', async () => {
    const reports = await lint(
      'export const p = URL.parse("a");',
      {},
      { file: 'configured/file.ts' },
    );
    expect(reports.map((report) => report.message)).toEqual([
      '"api.URL.parse_static" is not supported in Safari 17.4',
    ]);
  });

  it('treats partial implementations as unsupported when configured', async () => {
    const code = 'export const m = new MediaSource();';
    const browserslist = ['ios_saf 15.6'];
    expect(await keysOf(code, { browserslist })).toEqual([]);
    expect(await keysOf(code, { browserslist, partialImplementation: 'unsupported' })).toEqual([
      'api.MediaSource.MediaSource',
    ]);
  });
});

describe('feature detection', () => {
  const browserslist = ['chrome 109'];
  it.each([
    ['in operator', "if ('parse' in URL) { URL.parse('a'); }"],
    ['typeof', "if (typeof URL.parse === 'function') { URL.parse('a'); }"],
    [
      'negated typeof with early return',
      "function f() { if (typeof URL.parse !== 'function') { return; } URL.parse('a'); }",
    ],
    ['ternary', "export const u = 'parse' in URL ? URL.parse('a') : null;"],
    ['logical and', "export const u = 'parse' in URL && URL.parse('a');"],
    ['logical or', "export const u = !('parse' in URL) || URL.parse('a');"],
    ['else branch', "if (!('parse' in URL)) { void 0; } else { URL.parse('a'); }"],
    ['constant', "const canParse = 'parse' in URL;\nif (canParse) { URL.parse('a'); }"],
    ['optional call', "export const u = URL.parse?.('a');"],
    ['truthiness of the API itself', 'if (URL.parse) { URL.parse("a"); }'],
  ])('%s', async (_name, code) => {
    expect(await keysOf(code, { browserslist })).toEqual([]);
  });

  it.each([
    ['call inside the condition', "if (URL.parse('a') !== null) { void 0; }"],
    ['guard for another API', "if ('canParse' in URL) { URL.parse('a'); }"],
    [
      'comparison that is not a feature test',
      'declare const m: Map<string, string>;\nif (m.size > 0) { new URLSearchParams().size; }',
    ],
    ['local variable with the same name', "const parse = true;\nif (parse) { URL.parse('a'); }"],
  ])('%s', async (_name, code) => {
    expect(await keysOf(code, { browserslist })).not.toEqual([]);
  });
});

describe('value checks are not feature detection', () => {
  it('reports a nullable API compared with null', async () => {
    expect(
      await keysOf('export const f = document.fullscreenElement != null;', {
        browserslist: ['ios_saf 15.6'],
      }),
    ).toEqual(['api.Document.fullscreenElement']);
  });

  it('reports a nullable API used as a fallback operand', async () => {
    expect(
      await keysOf('export const e = document.fullscreenElement ?? document.body;', {
        browserslist: ['ios_saf 15.6'],
      }),
    ).toEqual(['api.Document.fullscreenElement']);
  });
});

describe('feature detection through an optional receiver', () => {
  it('does not report an API whose receiver is optional', async () => {
    const code =
      'declare const win: Window | null;\nexport const ric = win?.requestIdleCallback || ((cb: () => void) => setTimeout(cb));';
    expect(await keysOf(code, { browserslist: ['safari 16.4'] })).toEqual([]);
  });
});

describe('globals through self', () => {
  it('reports a global accessed through self', async () => {
    expect(
      await keysOf('self.requestIdleCallback(() => undefined);', { browserslist: ['safari 16.4'] }),
    ).toEqual(['api.Window.requestIdleCallback']);
  });
});

describe('differences from tscompat', () => {
  const both = async (
    code: string,
    browserslist: string[],
    options: Record<string, unknown> = {},
  ) => ({
    ours: await keysOf(code, { browserslist, ...options }),
    theirs: (await lint(code, { browserslist }, { ruleId: 'tscompat/tscompat' })).length,
  });

  it('does not report APIs whose older versions are partial implementations', async () => {
    const code = "declare const ctx: CanvasRenderingContext2D;\nctx.font = '10px serif';";
    expect(await both(code, ['safari 16.4'])).toEqual({ ours: [], theirs: 1 });
    expect(
      (await both(code, ['safari 16.4'], { partialImplementation: 'unsupported' })).ours,
    ).toEqual(['api.CanvasRenderingContext2D.font']);
  });

  it('does not report an imported identifier that shares its name with a Web API', async () => {
    const code = "import { Observable } from 'rxjs';\nexport const o = new Observable();";
    expect(await both(code, ['chrome 109'])).toEqual({ ours: [], theirs: 1 });
  });

  it('does not report a supported inherited member of an unsupported interface', async () => {
    const code = 'declare const entry: PerformanceEventTiming;\nexport const t = entry.startTime;';
    expect(await both(code, ['safari 16.4'])).toEqual({ ours: [], theirs: 1 });
  });

  it('does not report a guarded use', async () => {
    const code =
      "if (typeof window.requestIdleCallback === 'function') { window.requestIdleCallback(() => undefined); }";
    expect(await both(code, ['safari 16.4'])).toEqual({ ours: [], theirs: 2 });
  });
});
