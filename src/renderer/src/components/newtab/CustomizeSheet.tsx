import type { ChangeEvent, JSX, ReactNode } from 'react'
import { useEffect, useRef } from 'react'
import { ImagePlus, Trash2 } from 'lucide-react'
import type {
  NewTabModules,
  NewTabPreset,
  NewTabSettings,
  NewTabShortcutStyle,
  NewTabWallpaper,
  UIState
} from '@shared/types'
import {
  FEED_AVAILABLE,
  NEW_TAB_PRESETS,
  newTabSections,
  pickNewTabPreset,
  presetAvailable,
  toggleNewTabModule
} from '@shared/newtab'
import { run } from '@renderer/lib/api'
import { useBackSurface } from '@renderer/lib/back'
import {
  closeCustomize,
  customizeStore,
  loadWallpaperImage,
  readWallpaperFile,
  setWallpaperImage,
  wallpaperImageStore
} from '@renderer/lib/newtab'
import { browserStore, pushToast } from '@renderer/lib/ui'
import { cn } from '@renderer/lib/utils'
import { BottomSheet, type BottomSheetHandle } from '../sheet/BottomSheet'
import { Switch } from '../ui/switch'

const PRESET_LABELS: Record<NewTabPreset, string> = {
  focused: 'Focused',
  inspirational: 'Inspirational',
  informational: 'Informational',
  custom: 'Custom'
}

const MODULE_LABELS: Array<{ key: keyof NewTabModules; label: string }> = [
  { key: 'searchBox', label: 'Search field' },
  { key: 'shortcuts', label: 'Shortcuts' },
  { key: 'wallpaper', label: 'Wallpaper' },
  { key: 'feed', label: 'Feed' }
]

/** Mounted above whichever shell is up; the sheet itself renders while the store says open. */
export function NewTabCustomizeLayer(): JSX.Element | null {
  const open = customizeStore.use((s) => s.open)
  const state = browserStore.use((s) => s.state)
  return open && state ? <CustomizeSheet state={state} /> : null
}

/**
 * The new tab page's customise sheet (the gear on the page): the layout presets as chips, the
 * sections as toggle rows, the shortcut style and the wallpaper source. Every change is written
 * to the settings at once, so the page behind the sheet shows it as the sheet is used.
 */
function CustomizeSheet({ state }: { state: UIState }): JSX.Element {
  const settings = state.settings.newTab
  const sections = newTabSections(settings)
  const image = wallpaperImageStore.use()
  const sheet = useRef<BottomSheetHandle>(null)
  const fileInput = useRef<HTMLInputElement>(null)

  useEffect(() => {
    void loadWallpaperImage()
  }, [])

  useBackSurface({
    name: 'newtab-customize',
    onProgress: (progress) => sheet.current?.backProgress(progress),
    onCommit: () => sheet.current?.commitBack(),
    onCancel: () => sheet.current?.cancelBack()
  })
  useEscape(() => sheet.current?.dismiss())

  const update = (next: NewTabSettings): void => run('settings.update', { newTab: next })

  const pickWallpaper = (wallpaper: NewTabWallpaper): void => {
    // "Image" without one picked yet asks for the picture first; the pick turns the source over.
    if (wallpaper === 'image' && !image.dataUrl) fileInput.current?.click()
    else update({ ...settings, wallpaper })
  }

  const onFile = async (e: ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    try {
      await setWallpaperImage(await readWallpaperFile(file))
      // Picking a picture is meant to be seen: the sheet moves to a preset that shows it.
      if (!sections.wallpaper) update(toggleNewTabModule(settings, 'wallpaper', true))
    } catch (error) {
      pushToast(error instanceof Error ? error.message : 'The image could not be used', 'error')
    }
  }

  return (
    <BottomSheet
      ref={sheet}
      onDismissed={closeCustomize}
      handleLabel="Resize sheet"
      header={
        <div className="flex h-9 items-center px-3">
          <span className="zen-title min-w-0 flex-1 truncate">New tab page</span>
        </div>
      }
    >
      <div className="flex flex-col gap-4 pb-2">
        <Section title="Layout">
          <ChipStrip>
            {NEW_TAB_PRESETS.map((preset) => (
              <Chip
                key={preset}
                active={settings.preset === preset}
                disabled={!presetAvailable(preset)}
                onClick={() => update(pickNewTabPreset(settings, preset))}
              >
                {PRESET_LABELS[preset]}
              </Chip>
            ))}
          </ChipStrip>
          {!FEED_AVAILABLE && (
            <p className="px-3 pt-2 text-[12px] leading-4 text-[var(--zen-muted)]">
              Informational is not available: Zenium has no feed.
            </p>
          )}
        </Section>

        <Section title="Show">
          {MODULE_LABELS.map(({ key, label }) => {
            const unavailable = key === 'feed' && !FEED_AVAILABLE
            return (
              <label
                key={key}
                className={cn('zen-sheet-item', unavailable && 'pointer-events-none opacity-40')}
              >
                <span className="min-w-0 flex-1 truncate">{label}</span>
                {unavailable && (
                  <span className="shrink-0 text-[13px] text-[var(--zen-muted)]">
                    Not available
                  </span>
                )}
                <Switch
                  checked={sections[key]}
                  disabled={unavailable}
                  aria-label={label}
                  onCheckedChange={(checked) => update(toggleNewTabModule(settings, key, checked))}
                />
              </label>
            )
          })}
        </Section>

        <Section title="Shortcuts">
          <ChipStrip>
            {(
              [
                ['most-visited', 'Most visited'],
                ['my-shortcuts', 'My shortcuts']
              ] as Array<[NewTabShortcutStyle, string]>
            ).map(([style, label]) => (
              <Chip
                key={style}
                active={settings.shortcutStyle === style}
                onClick={() => update({ ...settings, shortcutStyle: style })}
              >
                {label}
              </Chip>
            ))}
          </ChipStrip>
        </Section>

        <Section title="Wallpaper">
          <ChipStrip>
            <Chip active={settings.wallpaper === 'space'} onClick={() => pickWallpaper('space')}>
              Space colours
            </Chip>
            <Chip active={settings.wallpaper === 'image'} onClick={() => pickWallpaper('image')}>
              Image
            </Chip>
          </ChipStrip>
          <button
            type="button"
            className="zen-sheet-item mt-1"
            onClick={() => fileInput.current?.click()}
          >
            <span className="flex h-8 w-8 shrink-0 items-center justify-center">
              <ImagePlus className="h-5 w-5" strokeWidth={1.75} />
            </span>
            <span className="min-w-0 flex-1 truncate">
              {image.dataUrl ? 'Choose another image' : 'Choose an image'}
            </span>
          </button>
          {image.dataUrl && (
            <button
              type="button"
              className="zen-sheet-item"
              onClick={() => void setWallpaperImage(null)}
            >
              <span className="flex h-8 w-8 shrink-0 items-center justify-center">
                <Trash2 className="h-5 w-5" strokeWidth={1.75} />
              </span>
              <span className="min-w-0 flex-1 truncate">Remove the image</span>
            </button>
          )}
          <input
            ref={fileInput}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(e) => void onFile(e)}
          />
        </Section>
      </div>
    </BottomSheet>
  )
}

/** A group of the sheet: a sentence-case heading and its rows, set apart by spacing alone. */
function Section({ title, children }: { title: string; children: ReactNode }): JSX.Element {
  return (
    <section className="flex flex-col">
      <h3 className="px-3 pb-1 text-[14px] font-semibold leading-5 tracking-[-0.006em]">{title}</h3>
      {children}
    </section>
  )
}

function ChipStrip({ children }: { children: ReactNode }): JSX.Element {
  return (
    <div role="radiogroup" className="flex flex-wrap gap-1.5 px-3 pt-1">
      {children}
    </div>
  )
}

/** A pill in the element tone; the picked one wears the accent tint, as the overview's spaces do. */
function Chip({
  active,
  disabled,
  onClick,
  children
}: {
  active: boolean
  disabled?: boolean
  onClick: () => void
  children: ReactNode
}): JSX.Element {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={active}
      disabled={disabled}
      className={cn(
        'flex h-9 shrink-0 items-center rounded-full px-3.5 text-[13px] font-medium transition-[background] duration-150 active:scale-[0.98] disabled:opacity-40',
        active
          ? 'bg-[rgb(var(--zen-accent-rgb)/0.16)]'
          : 'bg-[var(--zen-element-bg)] active:bg-[var(--zen-element-bg-hover)]'
      )}
      onClick={onClick}
    >
      {children}
    </button>
  )
}

/** Escape closes the sheet (hardware keyboards exist on tablets and DeX too). */
function useEscape(close: () => void): void {
  const latest = useRef(close)
  useEffect(() => {
    latest.current = close
  })
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopImmediatePropagation()
      latest.current()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])
}
