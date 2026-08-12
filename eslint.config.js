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
    // The renderer runs in a browser with no Node and no electron: it reaches
    // the outside world only through the preload API. Shared code is held to
    // the same rule, because the renderer imports it. Everything else here —
    // main, preload, worker, tests, scripts — is Node-side and unrestricted.
    files: ['src/renderer/**', 'src/shared/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'electron',
              message: 'Only main/preload may import electron. Renderer must use window.liseur.',
            },
          ],
          patterns: [
            {
              group: [
                'node:*',
                'fs',
                'fs/*',
                'path',
                'os',
                'crypto',
                'child_process',
                'worker_threads',
              ],
              message:
                'Only main/preload/worker may use Node builtins. Renderer must use window.liseur.',
            },
          ],
        },
      ],
    },
  },
)
