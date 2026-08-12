import js from '@eslint/js'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  {
    ignores: ['out/', 'dist/', 'release/', 'node_modules/', 'playwright-report/', 'test-results/'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': 'error',
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'electron',
              message: 'Only main/preload may import electron. Renderer must use window.liseur.',
            },
          ],
        },
      ],
    },
  },
  {
    // A plain Node script, deliberately free of dependencies — which includes
    // not pulling in `globals` just to name three of them.
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      globals: {
        console: 'readonly',
        fetch: 'readonly',
        process: 'readonly',
      },
    },
  },
  {
    // Main, preload and worker are Node-side and may import electron/node.
    files: [
      'src/main/**',
      'src/preload/**',
      'src/worker/**',
      'tests/e2e/**',
      '*.config.ts',
      'electron.vite.config.ts',
    ],
    rules: {
      'no-restricted-imports': 'off',
    },
  },
)
