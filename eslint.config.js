import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    ignores: ['dist/**', 'node_modules/**', 'coverage/**'],
  },
  // Plain JavaScript plugin scripts need Node.js globals
  {
    files: ['plugin/**/*.mjs'],
    languageOptions: {
      globals: globals.node,
    },
  },
  {
    files: ['scripts/**/*.mjs', '.github/skills/**/*.mjs', 'docs/manual-tests/**/*.mjs'],
    languageOptions: {
      globals: globals.node,
    },
  },
  // Integration harness: plain Node.js ESM (.mjs) and CJS (.cjs) files
  {
    files: ['tests/integration/**/*.mjs'],
    languageOptions: {
      globals: globals.node,
      sourceType: 'module',
    },
    rules: {
      'no-console': 'off',
    },
  },
  {
    files: ['tests/integration/**/*.cjs'],
    languageOptions: {
      globals: globals.node,
      sourceType: 'commonjs',
    },
    rules: {
      'no-console': 'off',
    },
  },
  {
    files: ['src/dashboard/**/*.js'],
    languageOptions: {
      globals: globals.browser,
    },
  },
);
