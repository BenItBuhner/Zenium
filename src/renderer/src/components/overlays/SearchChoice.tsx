import type { JSX, KeyboardEvent } from 'react'
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import type { SearchEngine, UIState } from '@shared/types'
import { resolveTheme } from '@shared/theme'
import { shuffledSearchChoiceTiles, type SearchChoiceTile } from '@core/searchChoice'
import { run } from '@renderer/lib/api'
import { useFaviconSrc } from '@renderer/lib/favicons'
import { KEEPS_KEYBOARD_ATTR } from '@renderer/lib/panes'
import { Button } from '../ui/button'

/*
 * The EEA's search-engine choice screen (W6-2; DMA Art. 6(3) – Chrome's
 * `chrome://search-engine-choice` is the reference): the eligible engines in the session's
 * random order, nothing picked in advance, "Set as default" live once a tile is picked, "Skip
 * for now" small and plain (Escape skips too). Drawn in the first-run tour's chassis: as the
 * tour's search step at the first run, and on its own – the same chassis with this one step –
 * over the profile window when a run finds the screen still owed (the tour skipped past it, an
 * existing profile in the EEA) or Settings › Search asks for it again.
 */

export const SEARCH_CHOICE_TITLE = 'Choose your search engine'
export const SEARCH_CHOICE_DESCRIPTION =
  'Searches from the address bar go to the engine you pick. The list is in a random order and nothing is chosen for you. You can change this any time in Settings › Search.'

/** The engine's icon at 24 in its 32 box: the favicon, or the letter the address bar shows for it. */
function EngineIcon({ engine }: { engine: SearchEngine }): JSX.Element {
  const [broken, setBroken] = useState(false)
  const favicon = useFaviconSrc(engine.favicon)
  return (
    <span className="zen-search-choice-icon" aria-hidden="true">
      {favicon && !broken ? (
        <img
          src={favicon}
          alt=""
          referrerPolicy="no-referrer"
          draggable={false}
          onError={() => setBroken(true)}
        />
      ) : (
        <span className="zen-search-choice-letter">{engine.glyph}</span>
      )}
    </span>
  )
}

/**
 * The list: a radio group of two-line rows (§9.2, §9.14) – the whole row the target, the mark
 * at the trailing edge, the picked row in `--v2-selected`. Arrow keys move the pick as a radio
 * group's do; Space picks the focused row; Tab leaves the group (one stop: the picked row, or
 * the first while nothing is picked).
 */
export function SearchChoiceList({
  tiles,
  picked,
  onPick,
  labelledBy
}: {
  tiles: readonly SearchChoiceTile[]
  picked: string | null
  onPick(engineId: string): void
  labelledBy: string
}): JSX.Element {
  const rows = useRef<Map<string, HTMLButtonElement>>(new Map())
  const move = (from: number, by: number): void => {
    if (tiles.length === 0) return
    const next = tiles[(from + by + tiles.length) % tiles.length]!
    onPick(next.engine.id)
    rows.current.get(next.engine.id)?.focus()
  }
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number): void => {
    switch (event.key) {
      case 'ArrowDown':
      case 'ArrowRight':
        event.preventDefault()
        move(index, 1)
        break
      case 'ArrowUp':
      case 'ArrowLeft':
        event.preventDefault()
        move(index, -1)
        break
      case 'Home':
        event.preventDefault()
        move(-1, 1)
        break
      case 'End':
        event.preventDefault()
        move(0, -1)
        break
      case ' ':
        event.preventDefault()
        onPick(tiles[index]!.engine.id)
        break
    }
  }
  const stop = picked ?? tiles[0]?.engine.id ?? null
  return (
    <div
      className="zen-search-choice-list"
      role="radiogroup"
      aria-labelledby={labelledBy}
      aria-required="true"
      data-testid="search-choice-list"
    >
      {tiles.map(({ engine, tagline }, index) => {
        const on = picked === engine.id
        return (
          <button
            key={engine.id}
            ref={(el) => {
              if (el) rows.current.set(engine.id, el)
              else rows.current.delete(engine.id)
            }}
            type="button"
            role="radio"
            aria-checked={on}
            tabIndex={engine.id === stop ? 0 : -1}
            className="zen-search-choice-row"
            data-engine={engine.id}
            onClick={() => onPick(engine.id)}
            onKeyDown={(event) => onKeyDown(event, index)}
          >
            <EngineIcon engine={engine} />
            <span className="zen-search-choice-text">
              <span className="zen-search-choice-name">{engine.name}</span>
              <span className="zen-search-choice-tagline">{tagline}</span>
            </span>
            <span className="zen-search-choice-mark" />
          </button>
        )
      })}
    </div>
  )
}

/**
 * The step's content: the title block and the list, for the tour's search step and the
 * standalone screen alike. `seed` is the run's (`UIState.searchChoice.seed`): the order holds
 * while the app is open, and holds between the tour's step and the screen after it.
 */
export function SearchChoiceStep({
  seed,
  picked,
  onPick
}: {
  seed: number
  picked: string | null
  onPick(engineId: string): void
}): JSX.Element {
  const titleId = useId()
  const tiles = useMemo(() => shuffledSearchChoiceTiles(seed), [seed])
  return (
    <div className="flex flex-col gap-4" data-testid="search-choice">
      <div className="flex flex-col gap-2">
        <h2 id={titleId} className="text-xl font-semibold">
          {SEARCH_CHOICE_TITLE}
        </h2>
        <p className="text-[13px] leading-relaxed text-[var(--zen-muted)]">
          {SEARCH_CHOICE_DESCRIPTION}
        </p>
      </div>
      <SearchChoiceList tiles={tiles} picked={picked} onPick={onPick} labelledBy={titleId} />
    </div>
  )
}

/** The footer's two verbs: "Skip for now" small and plain, "Set as default" the primary, live once a tile is picked. */
export function SearchChoiceActions({
  picked,
  onSkip,
  onChoose
}: {
  picked: string | null
  onSkip(): void
  onChoose(): void
}): JSX.Element {
  return (
    <div className="flex items-center gap-2">
      <Button variant="ghost" size="sm" onClick={onSkip} data-testid="search-choice-skip">
        Skip for now
      </Button>
      <Button disabled={picked === null} onClick={onChoose} data-testid="search-choice-set">
        Set as default
      </Button>
    </div>
  )
}

/**
 * The screen on its own over the profile window (`searchChoiceCovers`): the tour's chassis –
 * the space's theme behind the 640 panel – holding this one step, no progress bar, no Back.
 * Escape is "Skip for now". The core answers `searchChoice.choose` / `searchChoice.skip` with
 * the state that takes the screen down; nothing is kept here.
 */
export function SearchChoiceScreen({ state }: { state: UIState }): JSX.Element {
  const [picked, setPicked] = useState<string | null>(null)
  const panel = useRef<HTMLDivElement>(null)
  const scheme = state.settings.colorScheme
  const dark =
    scheme === 'dark' ||
    (scheme === 'system' &&
      (state.systemDark ?? window.matchMedia('(prefers-color-scheme: dark)').matches))
  const theme = state.spaces.find((s) => s.id === state.activeSpaceId)?.theme ?? null
  const background = useMemo(() => resolveTheme(theme, dark).background, [theme, dark])
  // The screen takes the keyboard as it comes up, and Escape is "Skip for now" wherever the
  // keyboard is while it stands. The panel carries `KEEPS_KEYBOARD_ATTR`: the New Tab's view
  // taking the keyboard as it loads under the screen (`focus.page`) does not blur the panel –
  // the chrome's keyboard is asked back instead (lib/panes.ts `pageTookKeyboard`), as for the
  // open URL bar, whose case this is: the page beneath lies covered and cannot be pressed.
  useEffect(() => {
    panel.current?.focus()
    const onKey = (event: globalThis.KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      run('searchChoice.skip', undefined)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  const skip = (): void => run('searchChoice.skip', undefined)
  const choose = (): void => {
    if (picked !== null) run('searchChoice.choose', { engineId: picked })
  }
  return (
    <div
      className="absolute inset-0 z-50 flex items-center justify-center"
      style={{ background }}
      data-testid="search-choice-screen"
    >
      <div className="zen-texture" />
      <div
        ref={panel}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={SEARCH_CHOICE_TITLE}
        className="zen-panel zen-animate-pop relative w-[640px] max-w-[calc(100%-32px)] p-8 outline-none"
        {...{ [KEEPS_KEYBOARD_ATTR]: '' }}
      >
        <SearchChoiceStep seed={state.searchChoice.seed} picked={picked} onPick={setPicked} />
        <div className="mt-8 flex items-center justify-end">
          <SearchChoiceActions picked={picked} onSkip={skip} onChoose={choose} />
        </div>
      </div>
    </div>
  )
}
