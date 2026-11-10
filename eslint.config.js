import { builtinModules } from 'node:module'
import js from '@eslint/js'
import reactHooks from 'eslint-plugin-react-hooks'
import globals from 'globals'
import tseslint from 'typescript-eslint'

// Every Node built-in, with and without the node: prefix.
const NODE_BUILTINS_PATTERN = ['node:*', ...builtinModules.filter((m) => !m.startsWith('_'))]

export default tseslint.config(
  {
    ignores: ['out/**', 'dist/**', 'release/**', 'coverage/**', 'test-results/**', 'playwright-report/**', '.agents/**', '.claude/**']
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }]
    }
  },
  {
    files: ['src/main/**', 'src/preload/**', 'src/core/**', 'tests/**', 'scripts/**', '*.config.{ts,js}'],
    languageOptions: { globals: globals.node }
  },
  {
    // The renderer is untrusted UI code: no Electron, no Node, no AWS.
    // All of that lives behind the preload bridge in the main process.
    files: ['src/renderer/**'],
    languageOptions: { globals: globals.browser },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'no-restricted-imports': [
        'error',
        {
          paths: [{ name: 'electron', message: 'The renderer must go through window.watchdog (preload).' }],
          patterns: [
            { group: NODE_BUILTINS_PATTERN, message: 'The renderer has no Node access.' },
            { group: ['@aws-sdk/*', '@smithy/*'], message: 'AWS calls happen only in the main process.' },
            { group: ['**/main/**', '**/core/**', '**/preload/**'], message: 'The renderer may import only src/shared.' }
          ]
        }
      ]
    }
  },
  {
    // Core logic stays plain TypeScript so it can be unit-tested without Electron.
    files: ['src/core/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        { paths: [{ name: 'electron', message: 'src/core must not depend on Electron. Put wiring in src/main.' }] }
      ]
    }
  }
)
