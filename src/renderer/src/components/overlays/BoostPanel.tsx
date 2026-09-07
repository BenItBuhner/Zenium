import type { JSX } from 'react'
import { useEffect, useMemo, useState } from 'react'
import { Crosshair, Trash2, X } from 'lucide-react'
import type { Boost, UIState } from '@shared/types'
import { BOOST_FONTS, emptyBoost } from '@shared/boosts'
import { getDomain } from '@shared/url'
import { run } from '@renderer/lib/api'
import { activeTab } from '@renderer/lib/selectors'
import { closeOverlay } from '@renderer/lib/ui'
import { cn, debounce } from '@renderer/lib/utils'
import { Button } from '../ui/button'
import { Label } from '../ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'
import { Slider } from '../ui/slider'
import { Switch } from '../ui/switch'
import { EmptyNote, OverlayShell } from './OverlayShell'

const TINTS = [
  '#ff5f5f',
  '#ff9f43',
  '#ffd93d',
  '#6bcb77',
  '#4d96ff',
  '#9b5de5',
  '#f15bb5',
  '#00c2a8'
]

/** Zen's Boost editor: tint, fonts, zapped elements, dark mode and custom CSS for one site. */
export function BoostPanel({ state }: { state: UIState }): JSX.Element {
  const tab = activeTab(state)
  const domain = tab && /^https?:/.test(tab.url) ? getDomain(tab.url) : ''
  const saved = state.boosts.find((b) => b.domain === domain)
  const [draft, setDraft] = useState<Boost>(() => saved ?? emptyBoost(domain))
  const [css, setCss] = useState(draft.css)
  // Zapped selectors are added from the page, so the saved list is the source of truth for them.
  const zapped = saved?.zapped ?? draft.zapped

  const apply = useMemo(
    () =>
      debounce((next: Boost) => {
        const { domain: _d, updatedAt: _u, zapped: _z, ...patch } = next
        void _d
        void _u
        void _z
        run('boost.update', { domain: next.domain, patch })
      }, 60),
    []
  )
  useEffect(() => () => apply.cancel(), [apply])

  const patch = (p: Partial<Boost>): void => {
    const next = { ...draft, ...p }
    setDraft(next)
    apply(next)
  }

  if (!domain) {
    return (
      <OverlayShell title="Boosts" variant="dialog" className="w-[460px]">
        <EmptyNote>Boosts customise web pages. Open a website to boost it.</EmptyNote>
      </OverlayShell>
    )
  }

  return (
    <OverlayShell
      title={`Boost · ${domain}`}
      variant="dialog"
      className="mb-3 ml-3 mr-auto mt-auto w-[440px]"
      actions={
        <label className="flex items-center gap-2 text-[12px] text-[var(--zen-muted)]">
          Enabled
          <Switch checked={draft.enabled} onCheckedChange={(v) => patch({ enabled: v })} />
        </label>
      }
    >
      <div className="flex flex-col gap-5 p-4">
        <section className="flex flex-col gap-2">
          <Label className="text-[12px] text-[var(--zen-muted)]">Tint</Label>
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              className={cn(
                'zen-squircle flex h-7 w-7 items-center justify-center rounded-lg border border-[var(--zen-border)] text-[11px]',
                !draft.tint && 'ring-2 ring-[var(--zen-accent)]'
              )}
              title="No tint"
              onClick={() => patch({ tint: null })}
            >
              <X className="h-3.5 w-3.5" />
            </button>
            {TINTS.map((c) => (
              <button
                key={c}
                type="button"
                className={cn(
                  'zen-squircle h-7 w-7 rounded-lg ring-1 ring-black/10 transition-transform hover:scale-105',
                  draft.tint === c && 'ring-2 ring-[var(--zen-accent)]'
                )}
                style={{ background: c }}
                title={c}
                onClick={() => patch({ tint: c })}
              />
            ))}
            <input
              type="color"
              className="h-7 w-7 cursor-pointer rounded-lg border-0 bg-transparent p-0"
              value={draft.tint ?? '#888888'}
              onChange={(e) => patch({ tint: e.target.value })}
              title="Custom colour"
            />
          </div>
          <div className="flex items-center gap-3">
            <Label className="w-16 text-[12px] text-[var(--zen-muted)]">Strength</Label>
            <Slider
              className="flex-1"
              min={0}
              max={1}
              step={0.01}
              disabled={!draft.tint}
              value={[draft.tintIntensity]}
              onValueChange={([v]) => patch({ tintIntensity: v })}
            />
            <span className="w-10 text-right text-[11px] tabular-nums text-[var(--zen-muted)]">
              {Math.round(draft.tintIntensity * 100)}%
            </span>
          </div>
        </section>

        <section className="flex flex-col gap-2">
          <Label className="text-[12px] text-[var(--zen-muted)]">Typography</Label>
          <div className="flex items-center gap-3">
            <Select
              value={draft.font ?? 'site'}
              onValueChange={(v) => patch({ font: v === 'site' ? null : v })}
            >
              <SelectTrigger className="h-8 flex-1 text-[12.5px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="site">Site fonts</SelectItem>
                {BOOST_FONTS.map((f) => (
                  <SelectItem key={f.id} value={f.id}>
                    <span style={{ fontFamily: f.stack }}>{f.label}</span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex items-center gap-3">
            <Label className="w-16 text-[12px] text-[var(--zen-muted)]">Size</Label>
            <Slider
              className="flex-1"
              min={70}
              max={150}
              step={5}
              value={[draft.fontSize]}
              onValueChange={([v]) => patch({ fontSize: v })}
            />
            <span className="w-10 text-right text-[11px] tabular-nums text-[var(--zen-muted)]">
              {draft.fontSize}%
            </span>
          </div>
        </section>

        <section className="flex items-center justify-between gap-3">
          <div>
            <div className="text-[13px]">Force dark mode</div>
            <div className="text-[11.5px] text-[var(--zen-muted)]">
              Invert light-only sites; images and video keep their colours.
            </div>
          </div>
          <Switch checked={draft.darkMode} onCheckedChange={(v) => patch({ darkMode: v })} />
        </section>

        <section className="flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <Label className="flex-1 text-[12px] text-[var(--zen-muted)]">
              Zapped elements ({zapped.length})
            </Label>
            <Button
              size="sm"
              variant="secondary"
              disabled={!tab || tab.discarded}
              onClick={() => {
                if (!tab) return
                closeOverlay()
                run('boost.startZap', { tabId: tab.id })
              }}
            >
              <Crosshair className="mr-1.5 h-3.5 w-3.5" /> Zap element
            </Button>
          </div>
          {zapped.length > 0 && (
            <ul className="zen-squircle max-h-32 overflow-y-auto rounded-xl border border-[var(--zen-border)]">
              {zapped.map((sel) => (
                <li
                  key={sel}
                  className="flex items-center gap-2 border-b border-[var(--zen-border)] px-3 py-1.5 text-[11.5px] last:border-b-0"
                >
                  <code className="min-w-0 flex-1 truncate font-mono" title={sel}>
                    {sel}
                  </code>
                  <button
                    type="button"
                    className="zen-toolbar-button h-6 w-6"
                    title="Show again"
                    onClick={() =>
                      run('boost.update', {
                        domain,
                        patch: { zapped: zapped.filter((s) => s !== sel) }
                      })
                    }
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="flex flex-col gap-1.5">
          <Label className="text-[12px] text-[var(--zen-muted)]">Custom CSS</Label>
          <textarea
            value={css}
            spellCheck={false}
            placeholder={`/* applied to every ${domain} page */`}
            className="zen-squircle h-24 w-full resize-y rounded-xl bg-[var(--zen-element-bg)] p-2.5 font-mono text-[12px] outline-none ring-1 ring-transparent focus:ring-[var(--zen-accent)]/60"
            onChange={(e) => setCss(e.target.value)}
            onBlur={() => css !== draft.css && patch({ css })}
          />
        </section>

        <div className="flex justify-between">
          <Button
            variant="ghost"
            size="sm"
            className="text-red-500"
            disabled={!saved}
            onClick={() => {
              run('boost.remove', { domain })
              closeOverlay()
            }}
          >
            Remove boost
          </Button>
          <Button size="sm" onClick={() => closeOverlay()}>
            Done
          </Button>
        </div>
      </div>
    </OverlayShell>
  )
}
