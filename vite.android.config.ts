import { resolve } from 'path'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

/** Where the preview host's `view.loadHtml` documents are kept and served (see `src/android/preview.ts`). */
const PREVIEW_PAGE_ROUTE = '/__zen/page/'
/** Documents kept; the oldest goes when a new one arrives. */
const PREVIEW_PAGE_LIMIT = 32

/**
 * `PUT /__zen/page/<id>` keeps a document the preview host was handed for a tab's frame and
 * `GET /__zen/page/<id>` serves it, so the frame shows it as a document of its own, the way the
 * WebView's `loadDataWithBaseURL` does. As `srcdoc` the document would inherit the chrome's
 * Content Security Policy (`script-src 'self'`), which blocks the inline script and handlers a
 * zen:// page runs; a document the dev server serves carries no policy, like the WebView's.
 */
function previewPages(): Plugin {
  const pages = new Map<string, string>()
  return {
    name: 'zen-preview-pages',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use(PREVIEW_PAGE_ROUTE, (req, res, next) => {
        // Mounted: `req.url` is what follows the route.
        const id = req.url?.slice(1) ?? ''
        if (!/^\d+$/.test(id)) return next()
        if (req.method === 'PUT') {
          const chunks: Buffer[] = []
          req.on('data', (chunk: Buffer) => chunks.push(chunk))
          req.on('end', () => {
            pages.set(id, Buffer.concat(chunks).toString('utf8'))
            for (const key of pages.keys()) {
              if (pages.size <= PREVIEW_PAGE_LIMIT) break
              pages.delete(key)
            }
            res.statusCode = 204
            res.end()
          })
          return
        }
        const html = req.method === 'GET' ? pages.get(id) : undefined
        if (html === undefined) return next()
        res.setHeader('content-type', 'text/html; charset=utf-8')
        res.setHeader('cache-control', 'no-store')
        res.end(html)
      })
    }
  }
}

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
    plugins: [react(), tailwindcss(), previewPages()],
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
