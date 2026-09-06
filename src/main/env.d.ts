/** Vite's `?raw` imports (used to ship Readability's source into pages as a string). */
declare module '*?raw' {
  const source: string
  export default source
}
