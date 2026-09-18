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
      'android/app/src/main/assets',
      // Extension fixtures the instrumentation sideloads: they run inside the emulated
      // chrome.* runtime, not in this codebase's toolchain.
      'android/app/src/androidTest/assets'
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
    // Modal dialogs render in the content frame through FrameDialogHost (scrim dims the frame
    // only); popovers, menus, toasts and anything anchored to chrome outside the frame render
    // through ChromePortal (src/renderer/src/lib/portals.tsx). Never position a dialog with
    // `fixed` inside the frame: the frame is a containing block for `fixed` descendants whenever
    // it carries a transform, so the panel lands offset inside it. These modules render their
    // panels in flow through the host; a popover belongs in a module of its own, on ChromePortal
    // (StarDialog.tsx keeps its desktop bubble there and so stays off this list).
    files: [
      'src/renderer/src/components/TabDialogs.tsx',
      'src/renderer/src/components/security/SecurityPromptDialog.tsx',
      'src/renderer/src/components/bookmarks/EditBookmarkDialog.tsx',
      'src/renderer/src/components/bookmarks/BookmarkAllTabsDialog.tsx',
      'src/renderer/src/components/extensions/ExtensionPromptDialog.tsx'
    ],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: 'JSXAttribute[name.name="className"] Literal[value=/(^|[\\s:])fixed(\\s|$)/]',
          message:
            'Frame dialogs position in flow inside FrameDialogHost, never `fixed`; a popover renders through ChromePortal (lib/portals.tsx).'
        },
        {
          selector:
            'JSXAttribute[name.name="className"] TemplateElement[value.raw=/(^|[\\s:])fixed(\\s|$)/]',
          message:
            'Frame dialogs position in flow inside FrameDialogHost, never `fixed`; a popover renders through ChromePortal (lib/portals.tsx).'
        },
        {
          selector: 'Property[key.name="position"] > Literal[value="fixed"]',
          message:
            'Frame dialogs position in flow inside FrameDialogHost, never `fixed`; a popover renders through ChromePortal (lib/portals.tsx).'
        }
      ]
    }
  },
  {
    // Plain Node scripts run by the GitHub Actions workflows, the desktop smoke harness,
    // electron-builder hooks and maintenance tasks; no TypeScript annotations available.
    files: [
      '.github/scripts/**/*.mjs',
      '.github/smoke/**/*.mjs',
      'build/**/*.mjs',
      'scripts/**/*.mjs'
    ],
    rules: {
      '@typescript-eslint/explicit-function-return-type': 'off'
    }
  },
  eslintConfigPrettier
)
