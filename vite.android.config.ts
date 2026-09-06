import { resolve } from 'path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

/**
 * Builds the Android chrome: the React renderer plus the browser core, bundled for the chrome
 * WebView. Output lands in the Android app's assets so Gradle can package it.
 *
 *   vite build  -c vite.android.config.ts                 → android/app/src/main/assets/www
 *   vite build  -c vite.android.config.ts --mode page     → android/app/src/main/assets/page.js
 *   vite        -c vite.android.config.ts                 → dev server with the iframe preview host
 */
const aliases = {
  '@renderer': resolve('src/renderer/src'),
  '@shared': resolve('src/shared'),
  '@core': resolve('src/core'),
  '@android': resolve('src/android')
}

export default defineConfig(({ mode }) => {
  if (mode === 'page') {
    return {
      resolve: { alias: aliases },
      define: { 'process.env.NODE_ENV': JSON.stringify('production') },
      build: {
        outDir: resolve('android/app/src/main/assets'),
        emptyOutDir: false,
        minify: true,
        lib: {
          entry: resolve('src/android/pageScript.ts'),
          name: 'zenPage',
          formats: ['iife'],
          fileName: () => 'page.js'
        }
      }
    }
  }
  return {
    root: resolve('src/android'),
    base: './',
    resolve: { alias: aliases },
    plugins: [react(), tailwindcss()],
    build: {
      outDir: resolve('android/app/src/main/assets/www'),
      emptyOutDir: true,
      // The chrome runs on the local WebView; one bundle keeps startup simple.
      modulePreload: false,
      target: 'es2020'
    },
    server: {
      port: 41734,
      strictPort: true
    }
  }
})
