import type { JSX, ReactNode, RefCallback } from 'react'
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Globe, Layers, Sparkles, Star } from 'lucide-react'
import type { ColorScheme, UIState } from '@shared/types'
import { THEME_PRESETS, resolveTheme } from '@shared/theme'
import { cmd, run } from '@renderer/lib/api'
import { useBackSurface } from '@renderer/lib/back'
import { SPRING_GENTLE, SpringAnimation } from '@renderer/lib/motion/spring'
import { phoneSteps, type PhoneStep } from '@renderer/lib/onboarding'
import { activeSpace, isDarkScheme } from '@renderer/lib/selectors'
import { useFadeEdges } from '@renderer/hooks/useFadeEdges'

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
 * where the host has a browser role to give, set as default. Text is the window's ink on the
 * gradient, the choices sit in neutral v2 cards (radio rows, image radio tiles), one primary
 * button per step, the progress a row of dots. Steps slide in on `SPRING_GENTLE`; the system
 * back gesture peels the current step away towards the previous one and springs it back when
 * abandoned.
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
        <div
          key={step}
          ref={attachStep}
          className="absolute inset-0 flex flex-col overflow-y-auto px-6 pb-4"
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

      {/* The Default step's Skip and Set as default split the footer with an 8 px gap (v2 §9.11). */}
      <div className="flex shrink-0 justify-center gap-2 px-6 pb-4 pt-2">
        {step === 'default' ? (
          <>
            <button
              type="button"
              className="zen-v2-button max-w-[180px] flex-1"
              disabled={busy}
              onClick={finish}
            >
              Skip
            </button>
            <button
              type="button"
              className="zen-v2-button max-w-[180px] flex-1"
              data-primary
              disabled={busy}
              onClick={() => void requestDefault()}
            >
              Set as default
            </button>
          </>
        ) : (
          <button
            type="button"
            className="zen-v2-button w-full max-w-[320px]"
            data-primary
            onClick={() => (last ? finish() : go(1))}
          >
            {last ? 'Start browsing' : index === 0 ? 'Get started' : 'Continue'}
          </button>
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
 * Returns the callback ref for the step's content element (a new step is a new element) and
 * the controls.
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
    const from = direction * TRAVEL
    paint(from)
    animation().start(from, 0, 0)
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
    <div className="my-auto flex flex-col gap-8">
      <div className="flex flex-col gap-3">
        <h1 className="text-[34px] font-semibold leading-[1.1] tracking-[-0.02em]">Zenium</h1>
        <p className="text-[15px] leading-[22px] text-[var(--zen-muted)]">
          A calmer way to browse. Your tabs sorted into Spaces, your favourite sites one tap away,
          and a window in your own colours.
        </p>
      </div>
      <ul className="flex flex-col gap-2">
        <Feature icon={<Layers className="h-5 w-5" strokeWidth={1.75} />} title="Spaces">
          Keep work, home and hobbies apart, each with its own tabs and colours.
        </Feature>
        <Feature icon={<Star className="h-5 w-5" strokeWidth={1.75} />} title="Essentials">
          The sites you live in, pinned at the top of every Space.
        </Feature>
        <Feature icon={<Sparkles className="h-5 w-5" strokeWidth={1.75} />} title="Boosts">
          Tint a site, swap its fonts or force dark mode, and it stays that way.
        </Feature>
      </ul>
    </div>
  )
}

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
    <li className="flex items-start gap-3 py-1.5">
      <span className="zen-v2-glyph mt-px">{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block text-[15px] font-semibold leading-[20px]">{title}</span>
        <span className="block text-[15px] leading-[20px] text-[var(--zen-muted)]">{children}</span>
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
    <div className="my-auto flex flex-col gap-6">
      <StepHeading title="Choose your look">
        These colours belong to the Space you are in; every Space you make can wear its own.
      </StepHeading>
      <div className="flex flex-col gap-3">
        <SectionLabel>Colour scheme</SectionLabel>
        <div role="radiogroup" aria-label="Colour scheme" className="zen-v2-card flex flex-col">
          {SCHEMES.map((s) => (
            <RadioRow
              key={s.value}
              checked={scheme === s.value}
              label={s.label}
              onPick={() => onScheme(s.value)}
            />
          ))}
        </div>
      </div>
      <div className="flex flex-col gap-3">
        <SectionLabel>Space colours</SectionLabel>
        <div
          role="radiogroup"
          aria-label="Space colours"
          className="zen-v2-card grid grid-cols-3 gap-x-2 gap-y-4 px-3 py-4"
        >
          {THEME_PRESETS.map((p, i) => (
            <button
              key={p.name}
              type="button"
              role="radio"
              aria-checked={presetIndex === i}
              aria-label={p.name}
              className="zen-v2-tile"
              onClick={() => onPreset(i)}
            >
              <span
                className="zen-v2-tile-image"
                style={{ background: resolveTheme(p.theme, dark).background }}
              />
              <span className="max-w-full truncate">{shortName(p.name)}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}

/** "Zenium Purple" is the one preset name that does not fit under a 64 px tile. */
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
    <div className="my-auto flex flex-col gap-6">
      <StepHeading title="Pick a search engine">
        What the address bar searches with. More engines, and keywords for them, live in Settings.
      </StepHeading>
      <div role="radiogroup" aria-label="Search engine" className="zen-v2-card flex flex-col">
        {engines.map((e) => (
          <RadioRow
            key={e.id}
            checked={e.id === value}
            label={e.name}
            glyph={<span className="text-[14px] font-semibold">{e.glyph}</span>}
            onPick={() => onChange(e.id)}
          />
        ))}
      </div>
    </div>
  )
}

/** A v2 radio row: the 20 px circle, an optional glyph box, the label; 44 tall, the whole row taps. */
function RadioRow({
  checked,
  label,
  glyph,
  onPick
}: {
  checked: boolean
  label: string
  glyph?: ReactNode
  onPick: () => void
}): JSX.Element {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={checked}
      aria-label={label}
      className="zen-v2-radio"
      onClick={onPick}
    >
      <span className="zen-v2-radio-mark" aria-hidden />
      {glyph && <span className="zen-v2-glyph">{glyph}</span>}
      <span className="min-w-0 flex-1 truncate">{label}</span>
    </button>
  )
}

function DefaultBrowser(): JSX.Element {
  return (
    <div className="my-auto flex flex-col gap-6">
      <span className="zen-v2-glyph h-12 w-12">
        <Globe className="h-6 w-6" strokeWidth={1.5} />
      </span>
      <StepHeading title="Make Zenium your default browser">
        Links from other apps open in Zenium, in your Spaces, with your Boosts and settings.
      </StepHeading>
      <p className="text-[15px] leading-[20px] text-[var(--zen-muted)]">
        Android asks you to confirm. You can change this any time in Settings.
      </p>
    </div>
  )
}

function StepHeading({ title, children }: { title: string; children: ReactNode }): JSX.Element {
  return (
    <div className="flex flex-col gap-2">
      <h2 className="text-[22px] font-semibold leading-[28px]">{title}</h2>
      <p className="text-[15px] leading-[22px] text-[var(--zen-muted)]">{children}</p>
    </div>
  )
}

/** A sub-heading over a card: 15/600 in the window's ink. */
function SectionLabel({ children }: { children: ReactNode }): JSX.Element {
  return <h3 className="text-[15px] font-semibold leading-[20px]">{children}</h3>
}

/** Which preset a space's theme is (the first, when it is none of them). */
function presetOf(theme: UIState['spaces'][number]['theme']): number {
  if (!theme) return 0
  const i = THEME_PRESETS.findIndex(
    (p) => JSON.stringify(p.theme.colors) === JSON.stringify(theme.colors)
  )
  return i < 0 ? 0 : i
}
