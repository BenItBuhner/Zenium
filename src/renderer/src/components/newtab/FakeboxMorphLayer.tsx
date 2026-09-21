import type { JSX } from 'react'
import { useLayoutEffect, useRef } from 'react'
import { Camera, Mic, Search } from 'lucide-react'
import { qrScanAvailable } from '@shared/qrScan'
import { voiceSearchAvailable } from '@shared/voice'
import { fakeboxMorphStore, setFakeboxPainter, tapFakebox } from '@renderer/lib/fakeboxMorph'
import {
  dockBelow,
  fakeboxContentWidth,
  omniboxContentWidth,
  widestPoseWidth
} from '@renderer/lib/motion/fakebox'
import { browserStore, uiStore } from '@renderer/lib/ui'

/**
 * The new tab page's field on its way (NTP-02 / MOT-08, v2 §11.8): a double of the field, laid
 * out per frame at the pose `lib/fakeboxMorph.ts` hands it – the field's rectangle carried by the
 * page's scroll toward the pill's slot, or flying to the omnibox's field on the spring and back.
 * It is the field while it draws: the page's own field, the pill's slot and the omnibox's field
 * all yield to it (the root's `data-fakebox`), and a tap on it is a tap on the field – from a
 * scrubbed position it completes the morph, mid-way back it turns the field round. Its look is
 * two layers handed over by the morph's value (main.css `.zen-fakebox-*`): the omnibox field's
 * raised panel arrives over the first half on top of the field's opaque surface and the field's
 * surface leaves under it over the second – never two half fades stacked. Its words ride the
 * whole way: the page field's content (the glyph, the words, the mic and the camera at its edge)
 * leaves over the first half and the omnibox field's content (the engine's chip, the words, the
 * mic and the camera flush with its end) arrives over the second in the omnibox's own layout, so
 * that at the landing the omnibox's field takes over pixel for pixel and no frame shows two
 * fields. The rectangle is the overview hero card's pattern (`lerpRect`, left / top / width /
 * height per frame) rather than a clip or a transform: the words inside must not scale. Nor
 * re-wrap: each content is laid out once, at the widest of the field's poses, and the moving box
 * clips it, so a long placeholder never re-truncates as the width passes through. The double
 * reads the value from its own pose (`--zen-ntp-morph` on the box), so that under reduced motion
 * it can hold a scrubbed field's look while it fades in place. At a bottom dock the layer is
 * clipped at the frame's top edge, since there the field is content and rides out of the frame.
 * `will-change` is on the box only while a write moves it (`data-moving`, v1 §7 rule 4), never at
 * rest on the page. Mounted above the shell; it draws nothing while the field is at rest or has
 * landed.
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

const PLACEHOLDER = 'Search or enter address'

function FakeboxDouble(): JSX.Element {
  const layerRef = useRef<HTMLDivElement>(null)
  const boxRef = useRef<HTMLButtonElement>(null)
  const fieldWordsRef = useRef<HTMLSpanElement>(null)
  const omniWordsRef = useRef<HTMLSpanElement>(null)
  const state = browserStore.use((s) => s.state)
  const capabilities = state?.capabilities ?? null
  const voice = capabilities ? voiceSearchAvailable(capabilities) : false
  const camera = capabilities ? qrScanAvailable(capabilities) : false
  const glyphs = (voice ? 1 : 0) + (camera ? 1 : 0)
  // The omnibox's engine chip, as its field shows it over an empty new-tab edit.
  const engine = state
    ? (state.searchEngines.find((e) => e.id === state.settings.searchEngineId) ??
      state.searchEngines[0] ??
      null)
    : null

  // Before the first paint, so the double is never seen anywhere but at its pose.
  useLayoutEffect(() => {
    setFakeboxPainter(({ pose, state, geometry, moving }) => {
      const box = boxRef.current
      if (!box) return
      const { rect, radius } = pose
      box.style.left = `${rect.x}px`
      box.style.top = `${rect.y}px`
      box.style.width = `${rect.width}px`
      box.style.height = `${rect.height}px`
      box.style.borderRadius = `${radius}px`
      box.style.setProperty('--zen-ntp-morph', pose.open.toFixed(4))
      box.style.setProperty('--zen-ntp-pill', pose.pill.toFixed(4))
      // The mic and the camera leave as soon as the field moves, whichever way it goes.
      box.style.setProperty('--zen-fakebox-away', Math.max(pose.open, state.scrub).toFixed(4))
      if (moving) box.dataset.moving = ''
      else delete box.dataset.moving
      const widest = widestPoseWidth(geometry)
      const fieldWords = fieldWordsRef.current
      if (fieldWords) fieldWords.style.width = `${fakeboxContentWidth(widest, glyphs)}px`
      const omniWords = omniWordsRef.current
      if (omniWords) omniWords.style.width = `${omniboxContentWidth(widest, glyphs)}px`
      const layer = layerRef.current
      if (layer) {
        layer.style.clipPath = dockBelow(geometry) ? `inset(${geometry.frameTop}px 0 0 0)` : ''
      }
    })
    return () => setFakeboxPainter(null)
  }, [glyphs])

  return (
    <div ref={layerRef} className="zen-fakebox-layer pointer-events-none fixed inset-0 z-[35]">
      <button
        ref={boxRef}
        type="button"
        className="zen-fakebox pointer-events-auto absolute text-left"
        aria-label={PLACEHOLDER}
        onClick={tapFakebox}
      >
        <span className="zen-fakebox-look zen-fakebox-look-field" aria-hidden />
        <span className="zen-fakebox-look zen-fakebox-look-omni" aria-hidden />
        {/* The page field's content in its own layout (pl-4, the glyph, gap-3; the controls at pr-1.5). */}
        <span className="zen-fakebox-field zen-fakebox-part" data-surface="page" aria-hidden>
          <span className="zen-fakebox-clip flex items-center pl-4">
            <span
              ref={fieldWordsRef}
              className="zen-fakebox-content flex shrink-0 items-center gap-3 whitespace-nowrap"
            >
              <Search className="h-5 w-5 shrink-0" strokeWidth={1.75} />
              <span className="min-w-0 flex-1 truncate">{PLACEHOLDER}</span>
            </span>
          </span>
          {glyphs > 0 && (
            <span className="zen-fakebox-trailing absolute inset-y-0 right-1.5 flex items-center gap-0.5">
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
        </span>
        {/* The omnibox field's content in the omnibox's layout (Urlbar.tsx: pl-2, the 28 px engine
            chip, gap-2.5, the 44 px controls flush with the end), so the real field's takes over
            pixel for pixel at the landing. */}
        <span className="zen-fakebox-omni zen-fakebox-part" aria-hidden>
          <span className="zen-fakebox-clip flex items-center pl-2">
            <span
              ref={omniWordsRef}
              className="zen-fakebox-content flex shrink-0 items-center gap-2.5 whitespace-nowrap"
            >
              <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[var(--zen-element-bg)] text-[11px] font-semibold">
                {engine?.glyph ?? ''}
              </span>
              <span className="min-w-0 flex-1 truncate text-[15px] text-[var(--zen-muted)]">
                {PLACEHOLDER}
              </span>
            </span>
          </span>
          {glyphs > 0 && (
            <span className="zen-fakebox-omni-trailing absolute inset-y-0 right-0 flex items-center gap-2.5">
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
        </span>
      </button>
    </div>
  )
}
