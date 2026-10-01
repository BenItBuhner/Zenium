import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  root: import.meta.dirname,
  /** Not `VITE_`: this PC's global environment carries another project's `VITE_*` keys. */
  envPrefix: 'ZENIUM_',
  plugins: [react()],
  build: { outDir: 'dist', emptyOutDir: true, sourcemap: true }
})
