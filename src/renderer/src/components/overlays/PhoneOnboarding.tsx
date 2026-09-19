import type { JSX, ReactNode, RefCallback } from 'react'
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Layers, Sparkles, Star } from 'lucide-react'
import type { ColorScheme, UIState } from '@shared/types'
import { THEME_PRESETS, resolveTheme } from '@shared/theme'
import { cmd, run } from '@renderer/lib/api'
import { useBackSurface } from '@renderer/lib/back'
import { fadeOpacity } from '@renderer/lib/motion/fade'
import { reducedMotion, SPRING_GENTLE, SpringAnimation } from '@renderer/lib/motion/spring'
import { phoneSteps, type PhoneStep } from '@renderer/lib/onboarding'
import { activeSpace, isDarkScheme } from '@renderer/lib/selectors'
import { useFadeEdges } from '@renderer/hooks/useFadeEdges'
import { V2Button } from '../extensions/v2'

/** Engines offered on the phone (the rest are a Settings visit away). */
const ENGINES = ['google', 'duckduckgo', 'ecosia', 'bing']

/** How far (px) a step's content travels between off and in place. */
const TRAVEL = 64

const SCHEMES: Array<{ value: ColorScheme; label: string }> = [
  { value: 'system', label: 'Match the system' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' }
]

/**
 * The first run on a phone: three or four full-screen steps on the space gradient – the
 * wordmark, the look (applied live, the whole screen is the preview), the search engine and,
 * where the host has a browser role to give, set as default. The flow is one page that is the
 * window (v2 §9.29, like the new tab page): its root is `data-surface="window"`, so its text is
 * the theme's ink and its controls read the window family. No cards (§9.17): each choice is a
 * group of rows under a 15/600 heading, the rows edge to edge with their text at the 16 gutter
 * (§5, §10.3), plus the image radio tiles of the colour presets (§9.14); one primary button per
 * step in a §9.11 footer, the progress a row of dots. Steps slide in on `SPRING_GENTLE` – a
 * 120 ms fade in place under reduced motion (§11.3) – and the system back gesture peels the
 * current step away towards the previous one and springs it back when abandoned.
 */
export function PhoneOnboarding({ state }: { state: UIState }): JSX.Element {
  const steps = useMemo(
    () =>
      phoneSteps({
        defaultBrowser: state.capabilities.defaultBrowser,
        isDefault: state.defaultBrowser.isDefault
      }),
    [state.capabilities.defaultBrowser, state.defaultBrowser.isDefault]
  )
  const [position, setPosition] = useState(0)
  const index = Math.min(position, steps.length - 1)
  const step: PhoneStep = steps[index]
  const [busy, setBusy] = useState(false)

  const space = activeSpace(state)
  const [scheme, setScheme] = useState<ColorScheme>(state.settings.colorScheme)
  const [engine, setEngine] = useState(state.settings.searchEngineId)
  const [presetIndex, setPresetIndex] = useState(() => presetOf(space.theme))
  const dark = isDarkScheme(state)

  // The look is applied as it is picked: the window behind the overlay is the preview. A space
  // that has no colours yet gets the first preset the moment the flow opens.
  useLayoutEffect(() => {
    if (space.theme === null) {
      run('space.update', { spaceId: space.id, patch: { theme: THEME_PRESETS[0].theme } })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, at the start of the flow
  }, [])
  const pickPreset = (i: number): void => {
    setPresetIndex(i)
    run('space.update', { spaceId: space.id, patch: { theme: THEME_PRESETS[i].theme } })
  }
  const pickScheme = (s: ColorScheme): void => {
    setScheme(s)
    run('settings.update', { colorScheme: s })
  }

  const [attachStep, motion] = useStepMotion(index)
  const go = (delta: 1 | -1): void => {
    const next = index + delta
    if (next < 0 || next >= steps.length) return
    motion.enterFrom(delta)
    setPosition(next)
  }
  // The back gesture pulls the step aside towards the one before it; on the first step there
  // is nothing before, and back leaves the app the way it does everywhere else.
  useBackSurface(
    index > 0
      ? {
          name: 'onboarding',
          onStart: () => motion.hold(),
          onProgress: (p) => motion.peel(p),
          onCommit: () => motion.leave(() => go(-1)),
          onCancel: () => motion.settle()
        }
      : null
  )

  const finish = (): void => {
    run('onboarding.complete', { searchEngineId: engine, colorScheme: scheme, essentials: [] })
  }
  // The button is busy (§9.30) while the host's role request is out – on Android until the
  // system's dialog has come back – and the flow completes then, whatever was chosen.
  const requestDefault = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    try {
      await cmd('defaultBrowser.request', { source: 'onboarding' })
    } catch {
      // The host could not show the role dialog; the settings row offers it again later.
    } finally {
      setBusy(false)
      finish()
    }
  }

  const last = index === steps.length - 1
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Welcome to Zenium"
      data-surface="window"
      className="zen-firstrun absolute inset-0 z-50 flex flex-col"
      style={{
        paddingTop: 'var(--zen-inset-top)',
        paddingBottom: 'var(--zen-inset-bottom)',
        paddingLeft: 'var(--zen-inset-left)',
        paddingRight: 'var(--zen-inset-right)'
      }}
    >
      <div className="zen-texture" />
      <div
        className="flex h-14 shrink-0 items-center justify-center gap-1.5"
        role="progressbar"
        aria-label="Setup progress"
        aria-valuemin={1}
        aria-valuemax={steps.length}
        aria-valuenow={index + 1}
      >
        {steps.map((s, i) => (
          <span key={s} className="zen-firstrun-dot" data-active={i === index} />
        ))}
      </div>

      <div className="relative min-h-0 flex-1">
        {/* The column is the sheet's 520 (BottomSheet) on wide screens; rows bleed to its edges. */}
        <div
          key={step}
          ref={attachStep}
          className="absolute inset-x-0 inset-y-0 mx-auto flex w-full max-w-[520px] flex-col overflow-y-auto pb-4"
          style={{ touchAction: 'pan-y', overscrollBehavior: 'contain' }}
        >
          {step === 'welcome' && <Welcome />}
          {step === 'look' && (
            <Look
              scheme={scheme}
              dark={dark}
              presetIndex={presetIndex}
              onScheme={pickScheme}
              onPreset={pickPreset}
            />
          )}
          {step === 'search' && (
            <SearchEngine
              engines={state.searchEngines.filter((e) => ENGINES.includes(e.id))}
              value={engine}
              onChange={setEngine}
            />
          )}
          {step === 'default' && <DefaultBrowser />}
        </div>
      </div>

      {/* The footer (§9.11): one action spans the column; the Default step's Skip and Set as
          default split it with an 8 px gap, the primary trailing; 16 to the edges. */}
      <div className="mx-auto flex w-full max-w-[520px] shrink-0 gap-2 px-4 pb-4 pt-2">
        {step === 'default' ? (
          <>
            <V2Button className="min-w-0 flex-1" disabled={busy} onClick={finish}>
              Skip
            </V2Button>
            <V2Button
              className="min-w-0 flex-1"
              variant="primary"
              busy={busy}
              onClick={() => void requestDefault()}
            >
              Set as default
            </V2Button>
          </>
        ) : (
          <V2Button
            className="min-w-0 flex-1"
            variant="primary"
            onClick={() => (last ? finish() : go(1))}
          >
            {last ? 'Start browsing' : index === 0 ? 'Get started' : 'Continue'}
          </V2Button>
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Motion of a step's content: one spring on its horizontal offset
// ---------------------------------------------------------------------------

interface StepMotion {
  /** The next step enters from this side (+1 from the right, −1 from the left). */
  enterFrom(direction: 1 | -1): void
  /** A back gesture began: freeze whatever motion is running. */
  hold(): void
  /** The finger is `progress` of the way through the gesture: pull the step aside that far. */
  peel(progress: number): void
  /** Spring the step the rest of the way out, then run `then`. */
  leave(then: () => void): void
  /** The gesture was abandoned: spring the step back into place. */
  settle(): void
}

/**
 * The step content lives at offset `x` (px): 0 in place, ±TRAVEL off to a side, fading as it
 * goes. Every movement is one `SpringAnimation` over `{x, v}` painted straight onto the element,
 * so a back gesture can catch a step mid-flight and the flow never sets React state per frame.
 * Under reduced motion (§11.3) a new step does not travel: it appears in place on a 120 ms
 * opacity fade; the springs themselves jump, so a back gesture's commit cuts. Returns the
 * callback ref for the step's content element (a new step is a new element) and the controls.
 */
function useStepMotion(index: number): [RefCallback<HTMLDivElement>, StepMotion] {
  const element = useRef<HTMLDivElement | null>(null)
  const fade = useFadeEdges<HTMLDivElement>({ axis: 'y' })
  const x = useRef(0)
  const enterDirection = useRef<1 | -1 | 0>(0)
  const afterRest = useRef<(() => void) | null>(null)
  const spring = useRef<SpringAnimation | null>(null)

  const paint = useCallback((value: number): void => {
    x.current = value
    const el = element.current
    if (!el) return
    const away = Math.min(1, Math.abs(value) / TRAVEL)
    el.style.transform = `translate3d(${value.toFixed(2)}px, 0, 0)`
    el.style.opacity = (1 - away * 0.85).toFixed(3)
  }, [])
  const animation = useCallback(
    (): SpringAnimation =>
      (spring.current ??= new SpringAnimation(SPRING_GENTLE, paint, (rest) => {
        paint(rest)
        const then = afterRest.current
        afterRest.current = null
        then?.()
      })),
    [paint]
  )

  // A new step has mounted: bring it in from the side the flow moved towards.
  useLayoutEffect(() => {
    const direction = enterDirection.current
    enterDirection.current = 0
    if (direction === 0) return
    afterRest.current = null
    if (reducedMotion()) {
      paint(0)
      const el = element.current
      if (!el) return
      el.style.opacity = '0'
      return fadeOpacity(el, 1)
    }
    const from = direction * TRAVEL
    paint(from)
    animation().start(from, 0, 0)
    return undefined
  }, [index, paint, animation])

  const attach = useCallback<RefCallback<HTMLDivElement>>(
    (el) => {
      element.current = el
      if (!el) return undefined
      // The element is new; it starts where the last paint left the offset.
      paint(x.current)
      return fade(el)
    },
    [fade, paint]
  )

  const controls: StepMotion = {
    enterFrom: (direction) => {
      spring.current?.stop()
      afterRest.current = null
      enterDirection.current = direction
    },
    hold: () => {
      spring.current?.stop()
      afterRest.current = null
    },
    peel: (progress) => {
      spring.current?.stop()
      afterRest.current = null
      paint(Math.min(1, Math.max(0, progress)) * TRAVEL)
    },
    leave: (then) => {
      afterRest.current = then
      const { v } = spring.current?.stop() ?? { v: 0 }
      animation().start(x.current, Math.max(v, 600), TRAVEL)
    },
    settle: () => {
      afterRest.current = null
      const { v } = spring.current?.stop() ?? { v: 0 }
      animation().start(x.current, Math.min(v, 0), 0)
    }
  }
  return [attach, controls]
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

function Welcome(): JSX.Element {
  return (
    <div className="my-auto flex flex-col">
      <div className="flex flex-col gap-3 px-4">
        <h1 className="zen-firstrun-wordmark">Zenium</h1>
        <p className="zen-firstrun-body zen-firstrun-deemphasized">
          A calmer way to browse. Your tabs sorted into Spaces, your favourite sites one tap away,
          and a window in your own colours.
        </p>
      </div>
      <ul className="flex flex-col pt-6">
        <Feature icon={<Layers aria-hidden />} title="Spaces">
          Keep work, home and hobbies apart, each with its own tabs and colours.
        </Feature>
        <Feature icon={<Star aria-hidden />} title="Essentials">
          The sites you live in, pinned at the top of every Space.
        </Feature>
        <Feature icon={<Sparkles aria-hidden />} title="Boosts">
          Tint a site, swap its fonts or force dark mode, and it stays that way.
        </Feature>
      </ul>
    </div>
  )
}

/**
 * A two-line row (§9.2): the bare 20 px glyph on the first text line, the label 15/600 over a
 * 13 description at 69% on 20 px lines, 12 px above and below, rows touching (§9.21).
 */
function Feature({
  icon,
  title,
  children
}: {
  icon: ReactNode
  title: string
  children: ReactNode
}): JSX.Element {
  return (
    <li className="zen-firstrun-row">
      <span className="zen-firstrun-row-glyph">{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block font-semibold">{title}</span>
        <span className="zen-firstrun-small zen-firstrun-deemphasized block">{children}</span>
      </span>
    </li>
  )
}

function Look({
  scheme,
  dark,
  presetIndex,
  onScheme,
  onPreset
}: {
  scheme: ColorScheme
  dark: boolean
  presetIndex: number
  onScheme: (s: ColorScheme) => void
  onPreset: (i: number) => void
}): JSX.Element {
  return (
    <div className="my-auto flex flex-col">
      <StepHeading title="Choose your look">
        These colours belong to the Space you are in; every Space you make can wear its own.
      </StepHeading>
      <Group label="Colour scheme">
        <div role="radiogroup" aria-label="Colour scheme" className="flex flex-col">
          {SCHEMES.map((s) => (
            <RadioRow
              key={s.value}
              checked={scheme === s.value}
              label={s.label}
              onPick={() => onScheme(s.value)}
            />
          ))}
        </div>
      </Group>
      <Group label="Space colours">
        {/* Six presets: three columns in the gutter at §10.4's 8 px gap (two would run three rows). */}
        <div role="radiogroup" aria-label="Space colours" className="grid grid-cols-3 gap-2 px-4">
          {THEME_PRESETS.map((p, i) => (
            <button
              key={p.name}
              type="button"
              role="radio"
              aria-checked={presetIndex === i}
              aria-label={p.name}
              className="zen-firstrun-tile"
              onClick={() => onPreset(i)}
            >
              <span
                className="zen-firstrun-tile-image"
                style={{ background: resolveTheme(p.theme, dark).background }}
              />
              <span className="max-w-full truncate">{shortName(p.name)}</span>
            </button>
          ))}
        </div>
      </Group>
    </div>
  )
}

/** "Zenium Purple" is the one preset name that does not fit under a third of the column. */
function shortName(name: string): string {
  return name.startsWith('Zenium ') ? name.slice('Zenium '.length) : name
}

function SearchEngine({
  engines,
  value,
  onChange
}: {
  engines: UIState['searchEngines']
  value: string
  onChange: (id: string) => void
}): JSX.Element {
  return (
    <div className="my-auto flex flex-col">
      <StepHeading title="Pick a search engine">
        What the address bar searches with. More engines, and keywords for them, live in Settings.
      </StepHeading>
      <div role="radiogroup" aria-label="Search engine" className="flex flex-col pt-4">
        {engines.map((e) => (
          <RadioRow
            key={e.id}
            checked={e.id === value}
            label={e.name}
            onPick={() => onChange(e.id)}
          />
        ))}
      </div>
    </div>
  )
}

/**
 * A radio row (§9.2, §9.14, §9.21): the 20 px circle on the first text line, the label 15/400;
 * 44 tall, growing with its label, the whole row taps and its press fill bleeds to the edge.
 */
function RadioRow({
  checked,
  label,
  onPick
}: {
  checked: boolean
  label: string
  onPick: () => void
}): JSX.Element {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={checked}
      aria-label={label}
      className="zen-firstrun-radio"
      onClick={onPick}
    >
      <span className="zen-firstrun-radio-mark" aria-hidden />
      <span className="min-w-0 flex-1 truncate">{label}</span>
    </button>
  )
}

function DefaultBrowser(): JSX.Element {
  return (
    <div className="my-auto flex flex-col">
      <StepHeading title="Make Zenium your default browser">
        Links from other apps open in Zenium, in your Spaces, with your Boosts and settings. Android
        asks you to confirm, and you can change this any time in Settings.
      </StepHeading>
    </div>
  )
}

/** The step's title block (§9.26): 22/600 at 28, its description 15 at 69% 4 below, at the gutter. */
function StepHeading({ title, children }: { title: string; children: ReactNode }): JSX.Element {
  return (
    <div className="zen-firstrun-intro flex flex-col gap-1 px-4">
      <h2 className="zen-firstrun-title">{title}</h2>
      <p className="zen-firstrun-body zen-firstrun-deemphasized">{children}</p>
    </div>
  )
}

/**
 * A group of choices (§9.17, §9.27, §10.3): a bare 15/600 sub-heading at the gutter with the
 * first row's box 4 below it; 20 above the heading, 16 when the group follows the step's title
 * block (§9.26) – the stylesheet's `zen-firstrun-group` rules.
 */
function Group({ label, children }: { label: string; children: ReactNode }): JSX.Element {
  return (
    <section className="zen-firstrun-group flex flex-col">
      <h3 className="zen-firstrun-heading px-4 pb-1">{label}</h3>
      {children}
    </section>
  )
}

/** Which preset a space's theme is (the first, when it is none of them). */
function presetOf(theme: UIState['spaces'][number]['theme']): number {
  if (!theme) return 0
  const i = THEME_PRESETS.findIndex(
    (p) => JSON.stringify(p.theme.colors) === JSON.stringify(theme.colors)
  )
  return i < 0 ? 0 : i
}
