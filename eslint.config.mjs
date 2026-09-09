import { defineConfig } from 'eslint/config'
import tseslint from '@electron-toolkit/eslint-config-ts'
import eslintConfigPrettier from '@electron-toolkit/eslint-config-prettier'
import eslintPluginReact from 'eslint-plugin-react'
import eslintPluginReactHooks from 'eslint-plugin-react-hooks'
import eslintPluginReactRefresh from 'eslint-plugin-react-refresh'

export default defineConfig(
  {
    ignores: [
      '**/node_modules',
      '**/dist',
      '**/out',
      'android/**/build',
      'android/.gradle',
      'android/app/src/main/assets'
    ]
  },
  tseslint.configs.recommended,
  eslintPluginReact.configs.flat.recommended,
  eslintPluginReact.configs.flat['jsx-runtime'],
  {
    settings: {
      react: {
        version: 'detect'
      }
    }
  },
  {
    files: ['**/*.{ts,tsx}'],
    plugins: {
      'react-hooks': eslintPluginReactHooks,
      'react-refresh': eslintPluginReactRefresh
    },
    rules: {
      ...eslintPluginReactHooks.configs.recommended.rules,
      ...eslintPluginReactRefresh.configs.vite.rules
    }
  },
  {
    // The browser core and shared helpers run in Electron's main process *and* inside the
    // Android chrome WebView: they must stay free of host-specific modules.
    files: ['src/core/**/*.ts', 'src/shared/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: ['electron', 'electron/*'], message: 'Core code must not import Electron.' },
            {
              group: ['node:*', 'fs', 'path', 'os', 'child_process'],
              message: 'Core code must not use Node APIs.'
            },
            {
              group: ['react', 'react-dom', '@renderer/*'],
              message: 'Core code must not depend on the renderer.'
            }
          ]
        }
      ]
    }
  },
  {
    // Plain Node scripts run by the GitHub Actions workflows; no TypeScript annotations available.
    files: ['.github/scripts/**/*.mjs'],
    rules: {
      '@typescript-eslint/explicit-function-return-type': 'off'
    }
  },
  eslintConfigPrettier
)
