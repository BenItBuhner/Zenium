// Lets Node run the core's TypeScript as it is written. `--experimental-strip-types` strips the
// types but resolves relative imports literally, and the core's modules import each other
// without extensions (`./sha256`, `../blocking/domain`), as the bundlers allow. Given to Node
// with `--import`, this registers the hook in ts-imports-hook.mjs, which tries `<specifier>.ts`
// (then `<specifier>/index.ts`) for such imports:
//
//   node --experimental-strip-types --import ./scripts/ts-imports.mjs script.mts
import { register } from 'node:module'

register('./ts-imports-hook.mjs', import.meta.url)
