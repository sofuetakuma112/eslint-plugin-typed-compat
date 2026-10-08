import path from 'node:path';

import tscompat from '@koddsson/eslint-plugin-tscompat';
import { ESLint, type Linter } from 'eslint';
import tseslint from 'typescript-eslint';

import plugin from '../src/index.js';

const fixture = path.join(import.meta.dirname, 'fixture');

const eslint = new ESLint({
  cwd: fixture,
  overrideConfigFile: true,
  overrideConfig: [
    {
      files: ['**/*.ts'],
      languageOptions: {
        parser: tseslint.parser,
        parserOptions: { projectService: true, tsconfigRootDir: fixture },
      },
      plugins: { 'typed-compat': plugin as unknown as ESLint.Plugin, tscompat },
    },
  ],
});

type Report = {
  key: string;
  message: string;
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
};

export async function lint(
  code: string,
  options: Record<string, unknown>,
  { ruleId = 'typed-compat/compat', file = 'file.ts' } = {},
): Promise<Report[]> {
  const header = `/* eslint ${ruleId}: ["error", ${JSON.stringify(options)}] */\n`;
  const [result] = await eslint.lintText(header + code, { filePath: path.join(fixture, file) });
  return (result?.messages ?? []).map((message: Linter.LintMessage) => {
    if (message.fatal === true) {
      throw new Error(message.message);
    }
    return {
      key: /^"([^"]+)"/.exec(message.message)?.[1] ?? message.message,
      message: message.message,
      line: message.line - 1,
      column: message.column,
      endLine: (message.endLine ?? message.line) - 1,
      endColumn: message.endColumn ?? message.column,
    };
  });
}

export function overlaps(a: Report, b: Report): boolean {
  const startsBeforeEnd = a.line < b.endLine || (a.line === b.endLine && a.column <= b.endColumn);
  const endsAfterStart = a.endLine > b.line || (a.endLine === b.line && a.endColumn >= b.column);
  return startsBeforeEnd && endsAfterStart;
}
