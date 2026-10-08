import eslintPlugin from 'eslint-plugin-eslint-plugin';
import { defineConfig } from 'eslint/config';
import tseslint from 'typescript-eslint';

export default defineConfig(
  { ignores: ['dist', 'tests/fixture'] },
  tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
  },
  { files: ['src/**/*.ts'], extends: [eslintPlugin.configs.recommended] },
  { files: ['**/*.js'], extends: [tseslint.configs.disableTypeChecked] },
);
