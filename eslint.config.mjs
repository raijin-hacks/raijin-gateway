import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default [
  { ignores: ['**/node_modules/**', '**/dist/**', '.venv/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.test.ts'],
    // Mutation tests deliberately walk malformed JSON at runtime.
    rules: { '@typescript-eslint/no-explicit-any': 'off', '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }] },
  },
  {
    rules: {
      'no-restricted-syntax': ['error', {
        selector: 'CatchClause > BlockStatement[body.length=0]',
        message: 'Handle errors explicitly; never silently continue.',
      }],
    },
  },
];
