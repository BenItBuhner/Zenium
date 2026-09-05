import type { JSX } from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Minus, Plus } from 'lucide-react'
import type { SpaceTheme, ThemeAlgorithm, ThemeColor, UIState } from '@shared/types'
import {
  THEME_PRESETS,
  deriveColors,
  resolveTheme,
  rgbToHex,
  toMonochrome,
  wheelToColor
} from '@shared/theme'
import { run } from '@renderer/lib/api'
import { isDarkScheme } from '@renderer/lib/selectors'
import { cn, debounce } from '@renderer/lib/utils'
import { Label } from '../ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'
import { Slider } from '../ui/slider'
import { Switch } from '../ui/switch'
import { Button } from '../ui/button'
import { OverlayShell } from './OverlayShell'

const ALGORITHMS: Array<{ id: ThemeAlgorithm; label: string }> = [
  { id: 'floating', label: 'Floating' },
  { id: 'complementary', label: 'Complementary' },
  { id: 'analogous', label: 'Analogous' },
  { id: 'splitComplementary', label: 'Split Complementary' },
  { id: 'triadic', label: 'Triadic' }
]

const WHEEL = 200

function defaultTheme(): SpaceTheme {
  return structuredClone(THEME_PRESETS[0].theme)
}

/** Zen's gradient theme picker: colour wheel dots, harmony algorithm, opacity, texture, rotation. */
export function ThemePicker({ state, spaceId }: { state: UIState; spaceId: string }): JSX.Element {
  const space = state.spaces.find((s) => s.id === spaceId) ?? state.spaces[0]
  const [theme, setTheme] = useState<SpaceTheme | null>(space.theme)
  const dark = isDarkScheme(state)
  const apply = useMemo(
    () =>
      debounce(
        (next: SpaceTheme | null) =>
          run('space.update', { spaceId: space.id, patch: { theme: next } }),
        40
      ),
    [space.id]
  )
  useEffect(() => () => apply.cancel(), [apply])

  const update = (next: SpaceTheme | null): void => {
    setTheme(next)
    apply(next)
  }
  const patch = (p: Partial<SpaceTheme>): void => update({ ...(theme ?? defaultTheme()), ...p })

  const working = theme ?? defaultTheme()
  const displayColors = useMemo(() => {
    let colors = deriveColors(working.colors, working.algorithm)
    if (working.monochrome) colors = toMonochrome(colors)
    return colors
  }, [working])
  const preview = resolveTheme(theme, dark)

  return (
    <OverlayShell
      title={`Theme · ${space.name}`}
      variant="dialog"
      className="mb-3 ml-3 mr-auto mt-auto w-[420px]"
    >
      <div className="flex flex-col gap-4 p-4">
        <div className="flex gap-4">
          <ColorWheel
            colors={working.colors}
            displayColors={displayColors}
            editableSecondary={working.algorithm === 'floating'}
            onChange={(colors) => patch({ colors })}
          />
          <div className="flex min-w-0 flex-1 flex-col gap-3">
            <div
              className="h-16 rounded-xl ring-1 ring-black/10"
              style={{ background: preview.background }}
            />
            <div className="flex items-center gap-1.5">
              {displayColors.map((c, i) => (
                <span
                  key={i}
                  className="h-5 w-5 rounded-full ring-1 ring-black/10"
                  style={{ background: rgbToHex(c.c) }}
                  title={rgbToHex(c.c)}
                />
              ))}
              <span className="flex-1" />
              <button
                type="button"
                className="zen-toolbar-button h-6 w-6"
                title="Add colour"
                disabled={working.colors.length >= 3}
                onClick={() => {
                  const angle = Math.random() * Math.PI * 2
                  const x = 0.5 + Math.cos(angle) * 0.35
                  const y = 0.5 + Math.sin(angle) * 0.35
                  patch({ colors: [...working.colors, { c: wheelToColor(x, y), x, y }] })
                }}
              >
                <Plus className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                className="zen-toolbar-button h-6 w-6"
                title="Remove last colour"
                disabled={working.colors.length <= 1}
                onClick={() => patch({ colors: working.colors.slice(0, -1) })}
              >
                <Minus className="h-3.5 w-3.5" />
              </button>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label className="text-[12px] text-[var(--zen-muted)]">Colour algorithm</Label>
              <Select
                value={working.algorithm}
                onValueChange={(v) => patch({ algorithm: v as ThemeAlgorithm })}
              >
                <SelectTrigger className="h-7 min-w-0 text-[12px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ALGORITHMS.map((a) => (
                    <SelectItem key={a.id} value={a.id}>
                      {a.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <label className="flex items-center justify-between gap-2 text-[12.5px]">
              Monochromatic
              <Switch
                checked={working.monochrome}
                onCheckedChange={(v) => patch({ monochrome: v })}
              />
            </label>
          </div>
        </div>

        <SliderRow
          label="Opacity"
          value={working.opacity}
          onChange={(v) => patch({ opacity: v })}
        />
        <SliderRow
          label="Texture"
          value={working.texture}
          onChange={(v) => patch({ texture: v })}
        />
        <SliderRow
          label="Rotation"
          value={working.rotation / 360}
          onChange={(v) => patch({ rotation: Math.round(v * 360) })}
          format={(v) => `${Math.round(v * 360)}°`}
        />

        <div>
          <Label className="text-[12px] text-[var(--zen-muted)]">Presets</Label>
          <div className="mt-2 flex flex-wrap gap-2">
            <button
              type="button"
              className={cn(
                'h-8 rounded-lg border border-[var(--zen-border)] px-3 text-[12px] hover:bg-[var(--zen-element-bg)]',
                theme === null && 'ring-2 ring-[var(--zen-accent)]'
              )}
              onClick={() => update(null)}
            >
              Default
            </button>
            {THEME_PRESETS.map((p) => (
              <button
                key={p.name}
                type="button"
                className="h-8 w-8 rounded-lg ring-1 ring-black/10 transition-transform hover:scale-105"
                style={{ background: resolveTheme(p.theme, dark).background }}
                title={p.name}
                onClick={() => update(structuredClone(p.theme))}
              />
            ))}
          </div>
        </div>
        <div className="flex justify-end">
          <Button variant="secondary" size="sm" onClick={() => update(null)}>
            Reset theme
          </Button>
        </div>
      </div>
    </OverlayShell>
  )
}

function SliderRow({
  label,
  value,
  onChange,
  format
}: {
  label: string
  value: number
  onChange: (v: number) => void
  format?: (v: number) => string
}): JSX.Element {
  return (
    <div className="flex items-center gap-3">
      <Label className="w-16 text-[12px] text-[var(--zen-muted)]">{label}</Label>
      <Slider
        className="flex-1"
        min={0}
        max={1}
        step={0.01}
        value={[value]}
        onValueChange={([v]) => onChange(v)}
      />
      <span className="w-10 text-right text-[11px] tabular-nums text-[var(--zen-muted)]">
        {format ? format(value) : `${Math.round(value * 100)}%`}
      </span>
    </div>
  )
}

interface WheelProps {
  colors: ThemeColor[]
  displayColors: ThemeColor[]
  editableSecondary: boolean
  onChange: (colors: ThemeColor[]) => void
}

function ColorWheel({
  colors,
  displayColors,
  editableSecondary,
  onChange
}: WheelProps): JSX.Element {
  const ref = useRef<HTMLDivElement>(null)

  const positionFrom = (e: PointerEvent | React.PointerEvent): { x: number; y: number } => {
    const rect = ref.current!.getBoundingClientRect()
    let dx = (e.clientX - rect.left) / rect.width - 0.5
    let dy = (e.clientY - rect.top) / rect.height - 0.5
    const r = Math.hypot(dx, dy)
    if (r > 0.5) {
      dx = (dx / r) * 0.5
      dy = (dy / r) * 0.5
    }
    return { x: dx + 0.5, y: dy + 0.5 }
  }

  const startDrag = (index: number, e: React.PointerEvent): void => {
    e.preventDefault()
    e.stopPropagation()
    const move = (ev: PointerEvent): void => {
      const { x, y } = positionFrom(ev)
      const next = colors.map((c, i) => (i === index ? { ...c, x, y, c: wheelToColor(x, y) } : c))
      onChange(next)
    }
    const up = (): void => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  const primaryIndex = Math.max(
    0,
    colors.findIndex((c) => c.isPrimary)
  )

  return (
    <div
      ref={ref}
      className="zen-color-wheel relative shrink-0 rounded-full shadow-inner"
      style={{ width: WHEEL, height: WHEEL }}
      onPointerDown={(e) => {
        if (colors.length >= 3 || (e.target as HTMLElement).dataset.dot) return
        const { x, y } = positionFrom(e)
        onChange([...colors, { c: wheelToColor(x, y), x, y }])
      }}
    >
      {displayColors.map((c, i) => {
        const primary = i === primaryIndex
        const draggable = primary || editableSecondary
        return (
          <button
            key={i}
            type="button"
            data-dot="true"
            className={cn(
              'absolute -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow-md transition-transform',
              primary ? 'h-7 w-7 z-10' : 'h-5 w-5',
              draggable ? 'cursor-grab active:cursor-grabbing hover:scale-110' : 'opacity-80'
            )}
            style={{ left: `${c.x * 100}%`, top: `${c.y * 100}%`, background: rgbToHex(c.c) }}
            title={
              primary ? 'Primary colour' : draggable ? 'Drag to change' : 'Derived by algorithm'
            }
            onPointerDown={(e) => draggable && startDrag(i, e)}
            onDoubleClick={(e) => {
              e.stopPropagation()
              if (!primary && colors.length > 1) onChange(colors.filter((_, idx) => idx !== i))
            }}
          />
        )
      })}
    </div>
  )
}
