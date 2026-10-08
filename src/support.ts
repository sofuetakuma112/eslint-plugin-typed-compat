import { createRequire } from 'node:module';
import path from 'node:path';

import type {
  BrowserName,
  CompatData,
  Identifier,
  SimpleSupportStatement,
  SupportBlock,
} from '@mdn/browser-compat-data';
import browserslist from 'browserslist';

const bcd = createRequire(import.meta.url)('@mdn/browser-compat-data') as CompatData;

const BROWSERSLIST_TO_BCD = new Map<string, BrowserName>([
  ['chrome', 'chrome'],
  ['and_chr', 'chrome_android'],
  ['edge', 'edge'],
  ['firefox', 'firefox'],
  ['and_ff', 'firefox_android'],
  ['ie', 'ie'],
  ['opera', 'opera'],
  ['op_mob', 'opera_android'],
  ['safari', 'safari'],
  ['ios_saf', 'safari_ios'],
  ['samsung', 'samsunginternet_android'],
  ['android', 'webview_android'],
]);

type Targets = ReadonlyMap<BrowserName, readonly string[]>;

type Browserslist = string | readonly string[] | undefined;

const targetsCache = new Map<string, Targets>();

export function resolveTargets(queries: Browserslist, filename: string): Targets {
  const cacheKey =
    queries === undefined ? `path:${path.dirname(filename)}` : `queries:${JSON.stringify(queries)}`;
  const cached = targetsCache.get(cacheKey);
  if (cached !== undefined) {
    return cached;
  }
  const targets = new Map<BrowserName, string[]>();
  for (const entry of browserslist(queries, { path: filename })) {
    const [name = '', range = ''] = entry.split(' ');
    const browser = BROWSERSLIST_TO_BCD.get(name);
    const version = range.split('-')[0] ?? '';
    if (browser !== undefined && /^\d/.test(version)) {
      targets.set(browser, [...(targets.get(browser) ?? []), version]);
    }
  }
  targetsCache.set(cacheKey, targets);
  return targets;
}

function compareVersions(a: string, b: string): number {
  const left = a.split('.').map(Number);
  const right = b.split('.').map(Number);
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) {
      return difference;
    }
  }
  return 0;
}

function isSupportedBy(
  statement: SimpleSupportStatement,
  version: string,
  allowPartialImplementation: boolean,
): boolean {
  if (
    statement.flags !== undefined ||
    statement.prefix !== undefined ||
    statement.alternative_name !== undefined
  ) {
    return false;
  }
  if (statement.partial_implementation === true && !allowPartialImplementation) {
    return false;
  }
  if (statement.version_added === false || !/^≤?\d/.test(statement.version_added)) {
    return false;
  }
  if (compareVersions(version, statement.version_added.replace('≤', '')) < 0) {
    return false;
  }
  return (
    statement.version_removed === undefined ||
    compareVersions(version, statement.version_removed.replace('≤', '')) < 0
  );
}

function findSupport(key: string): SupportBlock | undefined {
  let node: Identifier | undefined = bcd as unknown as Identifier;
  for (const part of key.split('.')) {
    node = node?.[part];
  }
  return node?.__compat?.support;
}

export function existsInCompatData(key: string): boolean {
  return findSupport(key) !== undefined;
}

export type UnsupportedTarget = { browser: BrowserName; version: string };

export function findUnsupportedTargets(
  key: string,
  targets: Targets,
  allowPartialImplementation: boolean,
): UnsupportedTarget[] {
  const support = findSupport(key);
  if (support === undefined) {
    return [];
  }
  return [...targets].flatMap(([browser, versions]) => {
    const statements = support[browser];
    if (statements === undefined) {
      return [];
    }
    const statementList = [statements].flat();
    const unsupportedVersions = versions
      .filter((version) => {
        const isSupported = statementList.some((statement) =>
          isSupportedBy(statement, version, allowPartialImplementation),
        );
        return !isSupported;
      })
      .sort(compareVersions);
    const [lowest] = unsupportedVersions;
    return lowest === undefined ? [] : [{ browser, version: lowest }];
  });
}

export function describeTargets(unsupportedTargets: readonly UnsupportedTarget[]): string {
  return unsupportedTargets
    .map(({ browser, version }) => `${bcd.browsers[browser].name} ${version}`)
    .join(', ');
}
