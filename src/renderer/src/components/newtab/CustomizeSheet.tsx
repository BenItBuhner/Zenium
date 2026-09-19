import type { ChangeEvent, JSX, ReactNode } from 'react'
import { useEffect, useRef, useState } from 'react'
import { SlidersHorizontal } from 'lucide-react'
import { useEscape } from '@renderer/hooks/useEscape'
import type {
  NewTabBackgroundKind,
  NewTabMode,
  NewTabModules,
  NewTabPreset,
  NewTabSettings,
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
} from '@shared/newTab'
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
import { FrameDialogPortal, useFrameDialog } from '@renderer/lib/portals'
import { browserStore, pushToast } from '@renderer/lib/ui'
import { RowView, type RowContext } from '../pages/settings/rows'
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

/** The Settings rows' context: a switch row never asks the page for a sheet, so nothing to open. */
const NO_SHEETS: RowContext = { open: () => {} }

const SHORTCUT_STYLES: Array<{ style: NewTabMode; label: string; description: string }> = [
  { style: 'most-visited', label: 'Most visited', description: 'The sites you go to most' },
  { style: 'my-shortcuts', label: 'My shortcuts', description: 'Only the sites you pin' }
]

/**
 * Mounted once, above whichever shell is up; while the store says open, the sheet renders in the
 * frame's dialog host (`FrameDialogPortal`, lib/portals.tsx) – a modal dialog over the content
 * frame, which recedes under a sheet and would shrink a sheet mounted inside it.
 */
export function NewTabCustomizeLayer(): JSX.Element | null {
  const open = customizeStore.use((s) => s.open)
  const state = browserStore.use((s) => s.state)
  if (!open || !state) return null
  return (
    <FrameDialogPortal>
      <CustomizeSheet state={state} />
    </FrameDialogPortal>
  )
}

/**
 * The new tab page's customise sheet (the gear on the page), a phone sheet in the v2 vocabulary:
 * the layout presets as image radio cards, the sections as switch rows (§10.4), the shortcut
 * style and the wallpaper source as radio rows. Every change is written to the settings at once,
 * so the page behind the sheet shows it as the sheet is used.
 *
 * The chassis (`BottomSheet`) is the page surface (§9.29) with the v2 header and grabber; the
 * sheet registers with the host as a dialog that draws its own scrim, fading with its motion
 * (§9.28). The scrim's press, the system back and Escape dismiss it. Focus is the chassis's:
 * it moves into the sheet as it opens, the chrome beneath is inert meanwhile, and it returns to
 * the gear that opened the sheet once the sheet is gone (§9.22, §9.24).
 */
function CustomizeSheet({ state }: { state: UIState }): JSX.Element {
  const settings = state.settings.newTab
  const sections = newTabSections(settings)
  const image = wallpaperImageStore.use()
  const sheet = useRef<BottomSheetHandle>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  /** The picked picture is being read and scaled: the button shows a spinner meanwhile (§9.30). */
  const [reading, setReading] = useState(false)

  useEffect(() => {
    void loadWallpaperImage()
  }, [])

  const dismiss = (): void => sheet.current?.dismiss()
  useFrameDialog({ onScrimPress: dismiss, ownScrim: true })
  useBackSurface({
    name: 'newtab-customize',
    onProgress: (progress) => sheet.current?.backProgress(progress),
    onCommit: () => sheet.current?.commitBack(),
    onCancel: () => sheet.current?.cancelBack()
  })
  useEscape(dismiss)

  const update = (next: NewTabSettings): void => run('settings.update', { newTab: next })
  const chooseLabel = image.dataUrl ? 'Choose another image' : 'Choose an image'

  const pickWallpaper = (background: NewTabBackgroundKind): void => {
    // "Image" without one picked yet asks for the picture first; the pick turns the source over.
    if (background === 'image' && !image.dataUrl) fileInput.current?.click()
    else update({ ...settings, background })
  }

  const onFile = async (e: ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    setReading(true)
    try {
      // Picking a picture is meant to be seen: the browser turns the source over and, on a layout
      // without a wallpaper, the wallpaper section on (`newtab.setBackgroundImage`).
      await setWallpaperImage(await readWallpaperFile(file))
    } catch (error) {
      pushToast(error instanceof Error ? error.message : 'The image could not be used', 'error')
    } finally {
      setReading(false)
    }
  }

  return (
    <BottomSheet
      ref={sheet}
      hosted
      fadeEdges={false}
      onDismissed={closeCustomize}
      handleLabel="Resize sheet"
      header={<h2 className="zen-sheet-title">New tab page</h2>}
    >
      <div className="zen-ntp-customize flex flex-col pb-4">
        <Section title="Layout">
          <div role="radiogroup" aria-label="Layout" className="zen-ntp-preset-grid">
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
            // Feed has no source yet: its row stays, disabled, with the reason as its description.
            const unavailable = key === 'feed' && !FEED_AVAILABLE
            return (
              // The shared switch row (§9.34, the Settings tab's `RowView`): the whole row is the
              // switch, 44 tall with one line and 64 with a description (§10.4).
              <RowView
                key={key}
                ctx={NO_SHEETS}
                row={{
                  id: key,
                  kind: 'switch',
                  label,
                  description: unavailable ? 'Not available' : undefined,
                  checked: sections[key],
                  disabled: unavailable,
                  onChange: (checked) => update(toggleNewTabModule(settings, key, checked))
                }}
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
                checked={settings.mode === style}
                onSelect={() => update({ ...settings, mode: style })}
              />
            ))}
          </div>
        </Section>

        <Section title="Wallpaper">
          <div role="radiogroup" aria-label="Wallpaper">
            <RadioRow
              label="Space colours"
              checked={settings.background !== 'image'}
              onSelect={() => pickWallpaper('space')}
            />
            <RadioRow
              label="Image"
              description={image.dataUrl ? 'The picture you chose' : 'A picture from this device'}
              checked={settings.background === 'image'}
              onSelect={() => pickWallpaper('image')}
            />
          </div>
          <div className="zen-v2-control-row">
            <button
              type="button"
              className="zen-v2-button"
              aria-busy={reading || undefined}
              onClick={() => {
                if (!reading) fileInput.current?.click()
              }}
            >
              {reading ? (
                // Busy (§9.30), as the extensions UI's button does it (#68, assets/extensions.css):
                // the label stays in the flow unpainted, so the button keeps its width and its
                // name, and the 16 px spinner sits where the label was.
                <>
                  <span className="zen-v2-button-label">{chooseLabel}</span>
                  <span className="zen-v2-spinner" aria-hidden />
                </>
              ) : (
                chooseLabel
              )}
            </button>
            {image.dataUrl && (
              <button
                type="button"
                className="zen-v2-button"
                data-danger
                disabled={reading}
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

/**
 * A group of the sheet: a sentence-case sub-heading and its rows, set apart by spacing alone – the
 * heading's 20 above and 4 below (§10.3), the Settings pages' beat, from the stylesheet.
 */
function Section({ title, children }: { title: string; children: ReactNode }): JSX.Element {
  return (
    <section className="zen-v2-section flex flex-col">
      <h3 className="zen-v2-heading">{title}</h3>
      {children}
    </section>
  )
}

/**
 * A radio row: the shared row (§9.34) with the shared radio leading – the 20 ring on the left,
 * reading the row's `aria-checked`; with a description the row grows to two lines.
 */
function RadioRow({
  label,
  description,
  checked,
  onSelect
}: {
  label: string
  description?: string
  checked: boolean
  onSelect: () => void
}): JSX.Element {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={checked}
      className="zen-v2-row"
      onClick={onSelect}
    >
      <span className="zen-v2-radio" aria-hidden />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate">{label}</span>
        {description && <span className="zen-v2-description line-clamp-2">{description}</span>}
      </span>
    </button>
  )
}

/**
 * An image radio card for a layout preset (§10.4): the card is the shared `zen-v2-card-radio`
 * (§9.34: the 2 px accent outline on the picked one), its picture the space's gradient as a
 * miniature of the page with the parts the preset shows drawn on it (Custom shows the user's own
 * choice); the name sits 8 beneath the card and, as its label, picks it too.
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
    <label className="zen-ntp-preset" data-disabled={disabled || undefined}>
      <button
        type="button"
        role="radio"
        aria-checked={active}
        aria-label={PRESET_LABELS[preset]}
        disabled={disabled}
        className="zen-v2-card-radio zen-ntp-preset-card"
        onClick={onSelect}
      >
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
      </button>
      <span className="zen-ntp-preset-caption truncate">{PRESET_LABELS[preset]}</span>
    </label>
  )
}
