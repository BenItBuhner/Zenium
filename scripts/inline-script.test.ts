import { describe, expect, it } from 'vitest'
import {
  INLINE_SCRIPTS,
  inlineScriptModuleSource,
  inlineScriptPlugin,
  inlineScriptSource
} from './inline-script'

/*
 * The scripts the main process runs in documents it does not own, bundled at build time into
 * strings: one IIFE per entry with its imports followed, served as a virtual module whose
 * default export is the source (`electron.vite.config.ts`, `vitest.config.ts`).
 */
const PANEL_ID = 'virtual:zenium-devtools-quit-hold-panel'

describe('inlineScriptSource', () => {
  it('bundles the toolbox panel entry and what it imports from src/shared into one self-contained script', async () => {
    const { code, inputs } = await inlineScriptSource(INLINE_SCRIPTS[PANEL_ID]!)
    expect(code).toContain('zenium-quit-hold')
    expect(code).toContain('__zeniumQuitHoldPanel')
    // No module system left for the frontend to resolve: the shared source is inlined.
    expect(code).not.toMatch(/\bimport\s*[({'"]/)
    expect(code).not.toMatch(/\brequire\(/)
    expect(code).not.toMatch(/\bexport\s/)
    const names = inputs.map((file) => file.replace(/\\/g, '/'))
    expect(names.some((f) => f.endsWith('src/main/platform/devtoolsQuitHoldPanel.ts'))).toBe(true)
    expect(names.some((f) => f.endsWith('src/shared/quitHoldPanel.ts'))).toBe(true)
    expect(names.some((f) => f.endsWith('src/shared/fullscreenHint.ts'))).toBe(true)
  })
})

describe('inlineScriptPlugin', () => {
  it('resolves each listed id to a virtual module whose default export is the script, and nothing else', async () => {
    const plugin = inlineScriptPlugin({ [PANEL_ID]: INLINE_SCRIPTS[PANEL_ID]! })
    const resolveId = plugin.resolveId as (id: string) => string | null
    const load = plugin.load as (
      this: { addWatchFile(f: string): void },
      id: string
    ) => Promise<string | null>
    expect(resolveId(PANEL_ID)).toBe(`\0${PANEL_ID}`)
    expect(resolveId('virtual:zenium-licences')).toBeNull()
    expect(resolveId('src/main/platform/devtoolsQuitHoldPanel.ts')).toBeNull()
    const watched: string[] = []
    const context = { addWatchFile: (file: string) => void watched.push(file) }
    expect(await load.call(context, '\0virtual:zenium-licences')).toBeNull()
    const source = await load.call(context, `\0${PANEL_ID}`)
    expect(source).not.toBeNull()
    expect(source!.startsWith('export default ')).toBe(true)
    const script = JSON.parse(source!.slice('export default '.length)) as string
    expect(script).toContain('zenium-quit-hold')
    // The files the bundle was made from are watched, so the dev server rebuilds it on a change.
    expect(watched.some((f) => f.endsWith('quitHoldPanel.ts'))).toBe(true)
    // Built once per id: the second load is the same string, no second bundle.
    expect(await load.call(context, `\0${PANEL_ID}`)).toBe(source)
  })

  it('wraps a script as a module of one string literal', () => {
    expect(inlineScriptModuleSource('(() => { "use strict"; })();')).toBe(
      'export default "(() => { \\"use strict\\"; })();"\n'
    )
  })
})
