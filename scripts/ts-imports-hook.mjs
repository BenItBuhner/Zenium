// The module-resolution hook ts-imports.mjs registers (runs on Node's loader thread): a relative
// import without an extension resolves to the `.ts` file (or the directory's `index.ts`) when
// there is one, and to whatever Node would have found otherwise.
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export async function resolve(specifier, context, nextResolve) {
  const relative = specifier.startsWith('./') || specifier.startsWith('../')
  if (relative && context.parentURL && !/\.[a-z]+$/i.test(specifier)) {
    const base = new URL(specifier, context.parentURL).href
    for (const candidate of [`${base}.ts`, `${base}/index.ts`]) {
      if (existsSync(fileURLToPath(candidate))) return nextResolve(candidate, context)
    }
  }
  return nextResolve(specifier, context)
}
