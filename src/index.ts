import type { TSESLint } from '@typescript-eslint/utils';

import { compat } from './compat.js';

const plugin = {
  meta: { name: 'eslint-plugin-typed-compat' },
  rules: { compat },
} satisfies TSESLint.FlatConfig.Plugin;

export default plugin;
