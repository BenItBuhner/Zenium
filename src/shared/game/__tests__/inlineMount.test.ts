// eslint-disable-next-line no-restricted-imports
import { readFileSync } from 'node:fs'
// eslint-disable-next-line no-restricted-imports
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { INLINE_SCRIPTS, inlineScriptOf } from '../../../../scripts/inline-script'

/**
 * R1 of the desktop nod (§9.17 (m)): Roll's runtime rides inline with the two documents that mount
 * it and costs every other page nothing. The page scripts (the shared one every document runs,
 * the Android and desktop hosts of it) import the bridge alone – the few lines that relay the
 * best score – and none of the runtime, the rules or the markup; the runtime's own entry is the
 * inline bundle's, reached from `zenPages.ts` through `inlineRuntime.ts` and nowhere else.
 */
const ROOT = resolve(__dirname, '../../../..')
const read = (file: string): string => readFileSync(resolve(ROOT, file), 'utf8')

const RUNTIME_MODULES = [
  'game/runtime',
  'game/logic',
  'game/page',
  'game/runtimeEntry',
  'game/inlineRuntime'
]

describe("Roll's runtime is inline, not the page script's (R1)", () => {
  it('the page scripts import the bridge at most, never the runtime, the rules or the markup', () => {
    for (const file of [
      'src/shared/pageScript.ts',
      'src/android/pageScript.ts',
      'src/preload/page.ts'
    ]) {
      const source = read(file)
      for (const module of RUNTIME_MODULES) {
        expect(source, `${file} imports ${module}`).not.toMatch(
          new RegExp(`from ['"][^'"]*${module.replace('/', '\\/')}['"]`)
        )
      }
      expect(source).not.toContain('installOfflineGame')
      expect(source).not.toContain('mountGames')
    }
    expect(read('src/shared/pageScript.ts')).toMatch(/from '\.\/game\/bridge'/)
  })

  it("the inline bundle is the runtime's one entry, reached from the page builder alone", () => {
    const id = 'virtual:zenium-game-runtime'
    expect(inlineScriptOf(INLINE_SCRIPTS[id]!)).toMatchObject({
      entry: 'src/shared/game/runtimeEntry.ts',
      minify: true
    })
    expect(read('src/shared/game/inlineRuntime.ts')).toContain(`from '${id}'`)
    expect(read('src/shared/zenPages.ts')).toMatch(/from '\.\/game\/inlineRuntime'/)
    // Nothing else imports the entry or the runtime for a document: the preview host alone
    // swaps the inline tag for its posing stand-in (`previewGame.ts`), which is not shipped.
    expect(read('src/shared/game/runtimeEntry.ts')).toMatch(
      /^import \{ mountGames \} from '\.\/runtime'$/m
    )
    expect(read('src/shared/game/runtimeEntry.ts').match(/^import /gm)).toHaveLength(1)
  })
})
