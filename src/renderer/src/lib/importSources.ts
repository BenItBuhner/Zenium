import { useEffect, useState } from 'react'
import type { ImportSource } from '@shared/types'
import { cmd } from '@renderer/lib/api'

/**
 * The sources the import engine finds (`import.sources`: the other browsers' profiles on this
 * computer, then the file sources), read for Settings › Import's desktop pane while the
 * category is shown – its first group names the browsers found – and handed to the builder
 * through its `SectionContext`, as the vault's lists and the custom dictionary are
 * (`useAutofillSettings`, `useDictionaryWords`). `null` until read and while the pane is not
 * shown; probed again each time the category comes up, since a browser may have been installed
 * or closed since. The dialog probes on its own (`useImportForm`): it is the surface that acts
 * on the answer.
 */
export function useImportSources(live: boolean): ImportSource[] | null {
  const [sources, setSources] = useState<ImportSource[] | null>(null)
  useEffect(() => {
    if (!live) return
    let alive = true
    void cmd('import.sources', undefined)
      .then((found) => {
        if (alive) setSources(found ?? [])
      })
      .catch(() => {
        if (alive) setSources([])
      })
    return () => {
      alive = false
    }
  }, [live])
  return live ? sources : null
}
