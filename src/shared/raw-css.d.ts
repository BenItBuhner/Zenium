/**
 * Vite's `?raw` import of a stylesheet resolves to the file's text. The renderer gets this from
 * `vite/client`; the main-process and Android bundles that share `zenPages.ts` (which reads the
 * chrome's stylesheet this way) need it declared here.
 */
declare module '*.css?raw' {
  const text: string
  export default text
}
