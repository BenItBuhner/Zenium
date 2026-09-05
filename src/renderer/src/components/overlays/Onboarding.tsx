import type { JSX } from 'react'
import { useMemo, useState } from 'react'
import { Check } from 'lucide-react'
import type { ColorScheme, UIState } from '@shared/types'
import { ONBOARDING_ESSENTIALS } from '@shared/defaults'
import { THEME_PRESETS, resolveTheme } from '@shared/theme'
import { formatBinding } from '@shared/shortcuts'
import { run } from '@renderer/lib/api'
import { cn } from '@renderer/lib/utils'
import { Button } from '../ui/button'

type Step = 'welcome' | 'look' | 'search' | 'essentials' | 'shortcuts'
const STEPS: Step[] = ['welcome', 'look', 'search', 'essentials', 'shortcuts']

/** First-run experience mirroring Zen's onboarding: look, search engine, Essentials, shortcuts. */
export function Onboarding({ state }: { state: UIState }): JSX.Element {
  const [step, setStep] = useState<Step>('welcome')
  const [scheme, setScheme] = useState<ColorScheme>('system')
  const [engine, setEngine] = useState('google')
  const [picked, setPicked] = useState<string[]>([])
  const [presetIndex, setPresetIndex] = useState(0)
  const dark =
    scheme === 'dark' ||
    (scheme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches)
  const index = STEPS.indexOf(step)
  const preview = useMemo(
    () => resolveTheme(THEME_PRESETS[presetIndex].theme, dark),
    [presetIndex, dark]
  )

  const finish = (): void => {
    run('space.update', {
      spaceId: state.activeSpaceId,
      patch: { theme: THEME_PRESETS[presetIndex].theme }
    })
    run('onboarding.complete', { searchEngineId: engine, colorScheme: scheme, essentials: picked })
  }

  const highlights = state.shortcuts.filter((s) =>
    [
      'zen-compact-mode-toggle',
      'key_newNavigatorTab',
      'zen-workspace-forward',
      'zen-split-view-vertical',
      'zen-toggle-pin-tab',
      'focusURLBar'
    ].includes(s.id)
  )

  return (
    <div
      className="absolute inset-0 z-50 flex items-center justify-center"
      style={{ background: preview.background }}
    >
      <div className="zen-texture" />
      <div className="zen-panel zen-animate-pop relative w-[620px] max-w-[calc(100%-32px)] p-8">
        <div className="mb-6 flex items-center gap-1.5">
          {STEPS.map((s, i) => (
            <span
              key={s}
              className={cn(
                'h-1 flex-1 rounded-full transition-colors',
                i <= index ? 'bg-[var(--zen-accent)]' : 'bg-[var(--zen-element-bg-active)]'
              )}
            />
          ))}
        </div>

        {step === 'welcome' && (
          <div className="flex flex-col gap-4">
            <h1 className="text-2xl font-semibold tracking-tight">Welcome to Zen</h1>
            <p className="text-[14px] leading-relaxed text-[var(--zen-muted)]">
              A calmer way to browse, now running on Chromium. Vertical tabs, Spaces, Essentials,
              Glance, Split View and Compact Mode — all here. Let&apos;s set things up in a minute.
            </p>
          </div>
        )}

        {step === 'look' && (
          <div className="flex flex-col gap-4">
            <h2 className="text-xl font-semibold">Choose your look</h2>
            <div className="grid grid-cols-3 gap-2">
              {(['system', 'light', 'dark'] as ColorScheme[]).map((s) => (
                <button
                  key={s}
                  type="button"
                  className={cn(
                    'h-10 rounded-xl border border-[var(--zen-border)] text-[13px] capitalize hover:bg-[var(--zen-element-bg)]',
                    scheme === s && 'ring-2 ring-[var(--zen-accent)]'
                  )}
                  onClick={() => setScheme(s)}
                >
                  {s === 'system' ? 'Follow system' : s}
                </button>
              ))}
            </div>
            <div className="grid grid-cols-6 gap-2">
              {THEME_PRESETS.map((p, i) => (
                <button
                  key={p.name}
                  type="button"
                  title={p.name}
                  className={cn(
                    'h-14 rounded-xl ring-1 ring-black/10 transition-transform hover:scale-[1.03]',
                    presetIndex === i && 'ring-2 ring-[var(--zen-accent)]'
                  )}
                  style={{ background: resolveTheme(p.theme, dark).background }}
                  onClick={() => setPresetIndex(i)}
                />
              ))}
            </div>
            <p className="text-[12px] text-[var(--zen-muted)]">
              Every space can have its own gradient — change it anytime from the palette button in
              the sidebar.
            </p>
          </div>
        )}

        {step === 'search' && (
          <div className="flex flex-col gap-4">
            <h2 className="text-xl font-semibold">Pick a search engine</h2>
            <div className="grid grid-cols-3 gap-2">
              {state.searchEngines
                .filter((e) => ['google', 'duckduckgo', 'ecosia'].includes(e.id))
                .map((e) => (
                  <button
                    key={e.id}
                    type="button"
                    className={cn(
                      'flex h-20 flex-col items-center justify-center gap-1 rounded-xl border border-[var(--zen-border)] hover:bg-[var(--zen-element-bg)]',
                      engine === e.id && 'ring-2 ring-[var(--zen-accent)]'
                    )}
                    onClick={() => setEngine(e.id)}
                  >
                    <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-[var(--zen-element-bg)] text-sm font-semibold">
                      {e.glyph}
                    </span>
                    <span className="text-[13px]">{e.name}</span>
                  </button>
                ))}
            </div>
            <p className="text-[12px] text-[var(--zen-muted)]">
              You can add more engines and keywords later in Settings → Search.
            </p>
          </div>
        )}

        {step === 'essentials' && (
          <div className="flex flex-col gap-4">
            <h2 className="text-xl font-semibold">Choose your Essentials</h2>
            <p className="text-[13px] text-[var(--zen-muted)]">
              Essentials sit at the top of every space. They stay unloaded until you click them.
            </p>
            <div className="grid grid-cols-4 gap-2">
              {ONBOARDING_ESSENTIALS.map((e) => {
                const on = picked.includes(e.url)
                return (
                  <button
                    key={e.url}
                    type="button"
                    className={cn(
                      'relative flex h-16 flex-col items-center justify-center gap-1 rounded-xl border border-[var(--zen-border)] text-[12.5px] hover:bg-[var(--zen-element-bg)]',
                      on && 'bg-[var(--zen-element-bg-active)] ring-2 ring-[var(--zen-accent)]'
                    )}
                    onClick={() =>
                      setPicked((p) => (on ? p.filter((u) => u !== e.url) : [...p, e.url]))
                    }
                  >
                    {on && (
                      <Check className="absolute right-1.5 top-1.5 h-3.5 w-3.5 text-[var(--zen-accent)]" />
                    )}
                    <span className="text-base font-semibold">{e.title.slice(0, 1)}</span>
                    <span>{e.title}</span>
                  </button>
                )
              })}
            </div>
          </div>
        )}

        {step === 'shortcuts' && (
          <div className="flex flex-col gap-4">
            <h2 className="text-xl font-semibold">A few shortcuts to know</h2>
            <div className="grid grid-cols-2 gap-2">
              {highlights.map((s) => (
                <div
                  key={s.id}
                  className="flex items-center justify-between rounded-xl border border-[var(--zen-border)] px-3 py-2 text-[13px]"
                >
                  <span>{s.label}</span>
                  <kbd className="zen-kbd">{formatBinding(s.binding, state.platform)}</kbd>
                </div>
              ))}
              <div className="flex items-center justify-between rounded-xl border border-[var(--zen-border)] px-3 py-2 text-[13px]">
                <span>Glance a link</span>
                <kbd className="zen-kbd">Alt + Click</kbd>
              </div>
            </div>
            <p className="text-[12px] text-[var(--zen-muted)]">
              All shortcuts can be changed in Settings → Keyboard Shortcuts.
            </p>
          </div>
        )}

        <div className="mt-8 flex items-center justify-between">
          <Button
            variant="ghost"
            onClick={() => setStep(STEPS[Math.max(0, index - 1)])}
            disabled={index === 0}
          >
            Back
          </Button>
          {index < STEPS.length - 1 ? (
            <Button onClick={() => setStep(STEPS[index + 1])}>Continue</Button>
          ) : (
            <Button onClick={finish}>Start browsing</Button>
          )}
        </div>
      </div>
    </div>
  )
}
