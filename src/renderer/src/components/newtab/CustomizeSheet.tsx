import type { ChangeEvent, JSX, ReactNode } from 'react'
import { useEffect, useRef } from 'react'
import { Check, SlidersHorizontal } from 'lucide-react'
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
  toggleNewTabModule,
  type NewTabSections
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
import { BottomSheet, type BottomSheetHandle } from '../sheet/BottomSheet'

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

const SHORTCUT_STYLES: Array<{ style: NewTabShortcutStyle; label: string; description: string }> = [
  { style: 'most-visited', label: 'Most visited', description: 'The sites you go to most' },
  { style: 'my-shortcuts', label: 'My shortcuts', description: 'Only the sites you pin' }
]

/** Mounted above whichever shell is up; the sheet itself renders while the store says open. */
export function NewTabCustomizeLayer(): JSX.Element | null {
  const open = customizeStore.use((s) => s.open)
  const state = browserStore.use((s) => s.state)
  return open && state ? <CustomizeSheet state={state} /> : null
}

/**
 * The new tab page's customise sheet (the gear on the page), a phone sheet in the v2 vocabulary:
 * the layout presets as image radio cards, the sections as checkbox rows, the shortcut style and
 * the wallpaper source as radio rows. Every change is written to the settings at once, so the
 * page behind the sheet shows it as the sheet is used.
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
      className="zen-v2-sheet"
      fadeEdges={false}
      onDismissed={closeCustomize}
      handleLabel="Resize sheet"
      header={
        <div className="zen-v2-sheet-header">
          <h2 className="zen-v2-title min-w-0 truncate">New Tab Page</h2>
        </div>
      }
    >
      <div className="flex flex-col gap-6 pb-4">
        <Section title="Layout">
          <div
            role="radiogroup"
            aria-label="Layout"
            className="grid grid-cols-2 gap-x-3 gap-y-4 px-4 pt-1"
          >
            {NEW_TAB_PRESETS.map((preset) => (
              <PresetCard
                key={preset}
                preset={preset}
                sections={newTabSections(pickNewTabPreset(settings, preset))}
                active={settings.preset === preset}
                disabled={!presetAvailable(preset)}
                onSelect={() => update(pickNewTabPreset(settings, preset))}
              />
            ))}
          </div>
          {!FEED_AVAILABLE && (
            <p className="zen-v2-description px-4 pt-3">
              Informational is not available: Zenium has no feed.
            </p>
          )}
        </Section>

        <Section title="Show">
          {MODULE_LABELS.map(({ key, label }) => {
            const unavailable = key === 'feed' && !FEED_AVAILABLE
            return (
              <CheckRow
                key={key}
                label={label}
                checked={sections[key]}
                disabled={unavailable}
                trailing={unavailable ? 'Not available' : undefined}
                onChange={(checked) => update(toggleNewTabModule(settings, key, checked))}
              />
            )
          })}
        </Section>

        <Section title="Shortcuts">
          <div role="radiogroup" aria-label="Shortcuts">
            {SHORTCUT_STYLES.map(({ style, label, description }) => (
              <RadioRow
                key={style}
                label={label}
                description={description}
                checked={settings.shortcutStyle === style}
                onSelect={() => update({ ...settings, shortcutStyle: style })}
              />
            ))}
          </div>
        </Section>

        <Section title="Wallpaper">
          <div role="radiogroup" aria-label="Wallpaper">
            <RadioRow
              label="Space colours"
              checked={settings.wallpaper === 'space'}
              onSelect={() => pickWallpaper('space')}
            />
            <RadioRow
              label="Image"
              description={image.dataUrl ? 'The picture you chose' : 'A picture from this device'}
              checked={settings.wallpaper === 'image'}
              onSelect={() => pickWallpaper('image')}
            />
          </div>
          <div className="flex gap-2 px-4 pt-2">
            <button
              type="button"
              className="zen-v2-button"
              onClick={() => fileInput.current?.click()}
            >
              {image.dataUrl ? 'Choose another image' : 'Choose an image'}
            </button>
            {image.dataUrl && (
              <button
                type="button"
                className="zen-v2-button"
                data-danger
                onClick={() => void setWallpaperImage(null)}
              >
                Remove
              </button>
            )}
          </div>
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

/** A group of the sheet: a sentence-case sub-heading and its rows, set apart by spacing alone. */
function Section({ title, children }: { title: string; children: ReactNode }): JSX.Element {
  return (
    <section className="flex flex-col">
      <h3 className="zen-v2-heading px-4 pb-1">{title}</h3>
      {children}
    </section>
  )
}

/** A checkbox row: the 20 square on the left, the label to its right, the row is the target. */
function CheckRow({
  label,
  checked,
  disabled,
  trailing,
  onChange
}: {
  label: string
  checked: boolean
  disabled?: boolean
  trailing?: string
  onChange: (checked: boolean) => void
}): JSX.Element {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      disabled={disabled}
      className="zen-v2-row"
      onClick={() => onChange(!checked)}
    >
      <span className="zen-v2-check" data-checked={checked || undefined} aria-hidden>
        <Check className="h-3.5 w-3.5" strokeWidth={3} />
      </span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {trailing && <span className="zen-v2-description shrink-0">{trailing}</span>}
    </button>
  )
}

/** A radio row: the 20 ring on the left; with a description the row grows to two lines. */
function RadioRow({
  label,
  description,
  checked,
  disabled,
  onSelect
}: {
  label: string
  description?: string
  checked: boolean
  disabled?: boolean
  onSelect: () => void
}): JSX.Element {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={checked}
      disabled={disabled}
      className="zen-v2-row"
      onClick={onSelect}
    >
      <span className="zen-v2-radio" data-checked={checked || undefined} aria-hidden />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate">{label}</span>
        {description && <span className="zen-v2-description line-clamp-2">{description}</span>}
      </span>
    </button>
  )
}

/**
 * An image radio card for a layout preset: the space's gradient as a miniature of the page with
 * the parts the preset shows drawn on it (Custom shows the user's own choice), the name beneath,
 * and an accent outline on the picked one.
 */
function PresetCard({
  preset,
  sections,
  active,
  disabled,
  onSelect
}: {
  preset: NewTabPreset
  sections: NewTabSections
  active: boolean
  disabled: boolean
  onSelect: () => void
}): JSX.Element {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={active}
      disabled={disabled}
      className="zen-v2-image-radio"
      onClick={onSelect}
    >
      <span className="zen-v2-image-radio-picture">
        <span
          className="zen-ntp-preview"
          data-picture={sections.wallpaper || undefined}
          aria-hidden
        >
          {sections.searchBox && <span className="zen-ntp-preview-field" />}
          {sections.shortcuts && (
            <span className="zen-ntp-preview-tiles">
              {Array.from({ length: 4 }, (_, i) => (
                <span key={i} className="zen-ntp-preview-tile" />
              ))}
            </span>
          )}
          {preset === 'informational' && (
            <>
              <span className="zen-ntp-preview-line" />
              <span className="zen-ntp-preview-line" style={{ width: '42%' }} />
            </>
          )}
          {preset === 'custom' && (
            <span className="zen-ntp-preview-glyph">
              <SlidersHorizontal className="h-4 w-4" strokeWidth={1.75} />
            </span>
          )}
        </span>
      </span>
      <span className="truncate px-0.5">{PRESET_LABELS[preset]}</span>
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
