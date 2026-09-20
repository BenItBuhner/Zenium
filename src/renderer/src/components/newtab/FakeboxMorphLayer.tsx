import type { JSX } from 'react'
import { useLayoutEffect, useRef } from 'react'
import { Camera, Mic, Search } from 'lucide-react'
import { qrScanAvailable } from '@shared/qrScan'
import { voiceSearchAvailable } from '@shared/voice'
import { fakeboxMorphStore, setFakeboxPainter, tapFakebox } from '@renderer/lib/fakeboxMorph'
import { browserStore, uiStore } from '@renderer/lib/ui'

/**
 * The new tab page's field on its way (NTP-02 / MOT-08): a double of the field, laid out per
 * frame at the pose `lib/fakeboxMorph.ts` hands it – the field's rectangle carried by the page's
 * scroll toward the pill's slot, or flying to the omnibox's field on the spring and back. It is
 * the field while it draws: the page's own field, the pill's slot and the omnibox's field all
 * yield to it (the root's `data-fakebox`), and a tap on it is a tap on the field – from a scrubbed
 * position it completes the morph, mid-way back it turns the field round. Its look is two layers
 * crossfaded by the morph's value (main.css `.zen-fakebox-*`): the field's opaque surface and the
 * omnibox field's raised panel, the words leaving over the first half as the omnibox's arrive
 * over the second. The rectangle is the overview hero card's pattern (`lerpRect`, left / top /
 * width / height per frame) rather than a clip or a transform: the words inside must not scale.
 * Mounted above the shell; it draws nothing while the field is at rest or has landed.
 */
export function FakeboxMorphLayer(): JSX.Element | null {
  const surface = fakeboxMorphStore.use((s) => s.surface)
  const phase = fakeboxMorphStore.use((s) => s.phase)
  const urlbarOpen = uiStore.use((s) => s.urlbar.open)
  // The omnibox up by another hand over a scrubbed page: it covers the page, and the double
  // would only draw over its sheet.
  if (!surface || (phase === 'rest' && urlbarOpen)) return null
  return <FakeboxDouble />
}

function FakeboxDouble(): JSX.Element {
  const boxRef = useRef<HTMLButtonElement>(null)
  const capabilities = browserStore.use((s) => s.state?.capabilities ?? null)
  const voice = capabilities ? voiceSearchAvailable(capabilities) : false
  const camera = capabilities ? qrScanAvailable(capabilities) : false

  // Before the first paint, so the double is never seen anywhere but at its pose.
  useLayoutEffect(() => {
    setFakeboxPainter((pose, state) => {
      const box = boxRef.current
      if (!box) return
      const { rect, radius } = pose
      box.style.left = `${rect.x}px`
      box.style.top = `${rect.y}px`
      box.style.width = `${rect.width}px`
      box.style.height = `${rect.height}px`
      box.style.borderRadius = `${radius}px`
      // The mic and the camera leave as soon as the field moves, whichever way it goes.
      box.style.setProperty('--zen-fakebox-away', Math.max(pose.open, state.scrub).toFixed(4))
    })
    return () => setFakeboxPainter(null)
  }, [])

  return (
    <div className="zen-fakebox-layer pointer-events-none fixed inset-0 z-[35]">
      <button
        ref={boxRef}
        type="button"
        className="zen-fakebox pointer-events-auto absolute flex items-center gap-3 pl-4 text-left"
        data-surface="page"
        aria-label="Search or enter address"
        onClick={tapFakebox}
      >
        <span className="zen-fakebox-look zen-fakebox-look-field" aria-hidden />
        <span className="zen-fakebox-look zen-fakebox-look-omni" aria-hidden />
        <span className="zen-fakebox-content relative flex min-w-0 flex-1 items-center gap-3">
          <Search className="h-5 w-5 shrink-0" strokeWidth={1.75} />
          <span className="min-w-0 flex-1 truncate">Search or enter address</span>
        </span>
        {(voice || camera) && (
          <span
            className="zen-fakebox-trailing relative flex shrink-0 items-center gap-0.5 pr-1.5"
            aria-hidden
          >
            {voice && (
              <span className="flex h-11 w-11 items-center justify-center">
                <Mic className="h-5 w-5" strokeWidth={1.75} />
              </span>
            )}
            {camera && (
              <span className="flex h-11 w-11 items-center justify-center">
                <Camera className="h-5 w-5" strokeWidth={1.75} />
              </span>
            )}
          </span>
        )}
      </button>
    </div>
  )
}
