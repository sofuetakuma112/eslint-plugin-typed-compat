import path from 'node:path';

import tscompat from '@koddsson/eslint-plugin-tscompat';
import { ESLint } from 'eslint';
import tseslint from 'typescript-eslint';
import { describe, expect, it } from 'vitest';

import plugin from '../src/index.js';
import { overlaps, toReport } from './lint.js';

const root = process.env['TYPED_COMPAT_PROJECT'] ?? '';
const queries = (process.env['TYPED_COMPAT_BROWSERSLIST'] ?? '')
  .split(',')
  .map((query) => query.trim())
  .filter((query) => query !== '');
const files = process.env['TYPED_COMPAT_FILES'] ?? 'src/**/*.{ts,tsx}';

describe.runIf(root !== '' && queries.length > 0)('a project linted with both rules', () => {
  it(
    'lints every file and prints the places only one rule reports',
    { timeout: 600_000 },
    async () => {
      const eslint = new ESLint({
        cwd: root,
        overrideConfigFile: true,
        overrideConfig: [
          {
            files: ['**/*.ts', '**/*.tsx'],
            languageOptions: {
              parser: tseslint.parser,
              parserOptions: { projectService: true, tsconfigRootDir: root },
            },
            plugins: { 'typed-compat': plugin as unknown as ESLint.Plugin, tscompat },
            rules: {
              'typed-compat/compat': ['error', { browserslist: queries }],
              'tscompat/tscompat': ['error', { browserslist: queries }],
            },
            linterOptions: { reportUnusedDisableDirectives: 'off' },
          },
        ],
        ignorePatterns: ['**/*.d.ts'],
      });
      const results = await eslint.lintFiles([files]);
      const fatalMessages: string[] = [];
      const tscompatOnly: string[] = [];
      const typedCompatOnly: string[] = [];
      for (const result of results) {
        const file = path.relative(root, result.filePath);
        for (const message of result.messages) {
          if (message.fatal === true || message.ruleId === null) {
            fatalMessages.push(`${file}:${String(message.line)} ${message.message}`);
          }
        }
        const ours = result.messages
          .filter((message) => message.ruleId === 'typed-compat/compat')
          .map((message) => toReport(message));
        const theirs = result.messages
          .filter((message) => message.ruleId === 'tscompat/tscompat')
          .map((message) => toReport(message));
        for (const report of theirs.filter((their) => !ours.some((our) => overlaps(our, their)))) {
          tscompatOnly.push(
            `${file}:${String(report.line)}:${String(report.column)} ${report.message}`,
          );
        }
        for (const report of ours.filter((our) => !theirs.some((their) => overlaps(our, their)))) {
          typedCompatOnly.push(
            `${file}:${String(report.line)}:${String(report.column)} ${report.message}`,
          );
        }
      }
      console.log(
        JSON.stringify({ files: results.length, tscompatOnly, typedCompatOnly }, null, 1),
      );
      expect(fatalMessages).toEqual([]);
    },
  );
});
