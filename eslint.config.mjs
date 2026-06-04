// @ts-check
import eslint from '@eslint/js';
import eslintPluginPrettierRecommended from 'eslint-plugin-prettier/recommended';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import jestPlugin from 'eslint-plugin-jest';

export default tseslint.config(
  {
    ignores: ['eslint.config.mjs'],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  eslintPluginPrettierRecommended,
  {
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.jest,
      },
      sourceType: 'commonjs',
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-floating-promises': 'warn',
      '@typescript-eslint/no-unsafe-argument': 'warn',
    },
  },
  // ─── Test-file overrides ────────────────────────────────────────────────────
  // Jest mock methods look like "unbound methods" to TypeScript-ESLint because
  // jest.fn() returns `any`. The jest plugin understands this and replaces the
  // false-positive with the correct jest/unbound-method rule.
  {
    files: ['**/*.spec.ts', '**/*.e2e-spec.ts'],
    plugins: { jest: jestPlugin },
    rules: {
      // Disable the TS rule that false-positives on jest mock calls
      '@typescript-eslint/unbound-method': 'off',
      // Enable the jest-aware replacement
      'jest/unbound-method': 'error',

      // Test files frequently need `any` in mock factories — allow it selectively
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
    },
  },
);