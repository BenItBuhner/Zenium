import { cpSync, mkdirSync } from 'fs'
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

/** Where the PDF viewer's files go (`shared/pdfPage.ts` names them; `PdfViewer.kt` serves them). */
const PDF_ASSETS_DIR = resolve('android/app/src/main/assets/pdf')

/**
 * The parts of pdf.js the viewer needs beside its own script: the worker, and the data the
 * worker asks for as documents need it (CJK character maps, the fourteen standard fonts,
 * the JPEG 2000 / JBIG2 / colour-management decoders as WebAssembly, the default ICC profile).
 * Copied from the package once the viewer bundle is written.
 */
function pdfViewerFiles(): Plugin {
  const dist = resolve('node_modules/pdfjs-dist')
  return {
    name: 'zen-pdf-viewer-files',
    apply: 'build',
    closeBundle() {
      mkdirSync(PDF_ASSETS_DIR, { recursive: true })
      cpSync(resolve(dist, 'legacy/build/pdf.worker.min.mjs'), resolve(PDF_ASSETS_DIR, 'pdf.worker.mjs'))
      for (const dir of ['cmaps', 'standard_fonts', 'wasm', 'iccs'])
        cpSync(resolve(dist, dir), resolve(PDF_ASSETS_DIR, dir), { recursive: true })
    }
  }
}

/**
 * Builds the Android chrome: the React renderer plus the browser core, bundled for the chrome
 * WebView. Output lands in the Android app's assets so Gradle can package it.
 *
 *   vite build  -c vite.android.config.ts                 → android/app/src/main/assets/www
 *   vite build  -c vite.android.config.ts --mode page     → android/app/src/main/assets/page.js
 *   vite build  -c vite.android.config.ts --mode ext      → android/app/src/main/assets/ext.js
 *   vite build  -c vite.android.config.ts --mode pdf      → android/app/src/main/assets/pdf/
 *   vite        -c vite.android.config.ts                 → dev server with the iframe preview host
 */
const aliases = {
  '@renderer': resolve('src/renderer/src'),
  '@shared': resolve('src/shared'),
  '@core': resolve('src/core'),
  '@android': resolve('src/android')
}

export default defineConfig(({ mode }) => {
  if (mode === 'ext' || mode === 'ext-janitor') {
    // The extension bootstrap (content scripts and extension pages) and the main-world transport
    // janitor; Kotlin wraps each with its per-install config (and, for the bootstrap, the
    // sources), so they must stay plain IIFEs over the `__zenExtBoot` global.
    const janitor = mode === 'ext-janitor'
    return {
      resolve: { alias: aliases },
      define: { 'process.env.NODE_ENV': JSON.stringify('production') },
      build: {
        outDir: resolve('android/app/src/main/assets'),
        emptyOutDir: false,
        minify: true,
        lib: {
          entry: resolve(
            janitor ? 'src/android/extensionTransport.ts' : 'src/android/extensionBootstrap.ts'
          ),
          name: janitor ? 'zenExtJanitor' : 'zenExt',
          formats: ['iife'],
          fileName: () => (janitor ? 'ext-janitor.js' : 'ext.js')
        }
      }
    }
  }
  if (mode === 'pdf') {
    // The PDF viewer document's script (`src/android/pdfViewer.ts`), an ES module the shell
    // loads from the viewer's origin, with pdf.js bundled in; the worker and data ride along.
    return {
      resolve: { alias: aliases },
      define: { 'process.env.NODE_ENV': JSON.stringify('production') },
      plugins: [pdfViewerFiles()],
      build: {
        outDir: PDF_ASSETS_DIR,
        emptyOutDir: true,
        minify: true,
        target: 'es2020',
        lib: {
          entry: resolve('src/android/pdfViewer.ts'),
          formats: ['es'],
          fileName: () => 'viewer.mjs'
        },
        rollupOptions: { output: { inlineDynamicImports: true } }
      }
    }
  }
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
