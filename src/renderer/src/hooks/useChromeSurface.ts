import { useEffect } from 'react'
import type { ChromeSurface } from '@shared/types'
import { run } from '@renderer/lib/api'

/**
 * This component is one of the chrome's surfaces that answer a page (`ChromeSurface`: the
 * install prompt, the screen picker, the share sheet): it tells the core it is up while mounted
 * (`ui.surface`) and takes that back as it unmounts. The core holds a page's request open only
 * for a window with the surface up; elsewhere it answers the page at once as a cancel would, so
 * a `getDisplayMedia`, a `navigator.share` or a deferred install `prompt()` never hangs on a
 * chrome that is not there. `mounted` lets a component that stands in for the surface on some
 * hosts only – the phone's install sheet on a one-window host – register on those alone.
 */
export function useChromeSurface(surface: ChromeSurface, mounted = true): void {
  useEffect(() => {
    if (!mounted) return
    run('ui.surface', { surface, mounted: true })
    return () => run('ui.surface', { surface, mounted: false })
  }, [surface, mounted])
}
