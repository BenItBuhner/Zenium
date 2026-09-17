import type { JSX } from 'react'
import type { Platform } from '@shared/types'
import {
  APP_ICON_DESKTOP,
  APP_ICON_INK,
  APP_ICON_MARK,
  APP_ICON_VARIANTS,
  appIconVariant,
  squirclePath,
  type AppIconId,
  type AppIconVariant
} from '@shared/appIcon'
import { Group, Row } from './SettingsPrimitives'

/** What changing the icon does on this host, in one breath. */
const HINT: Record<Platform, string> = {
  android:
    'Changes the icon on your home screen and in the app list straight away. Some launchers take a moment to redraw it, and a shortcut you placed on the home screen may need adding again.',
  win32:
    'Applies to the window and the taskbar now. The Start menu and desktop shortcuts keep the icon the installer gave them until the next update, when they take this one.',
  darwin:
    'Applies to the Dock while Zenium is running. Finder and Launchpad keep the icon inside the app bundle.',
  linux:
    'Applies to the window and its dock entry now. The app menu keeps the icon the package installed.'
}

/**
 * Settings → Look and Feel → App icon: a row naming the current colour, then every colour as
 * the icon itself; picking one applies it at once. The picked one wears the accent ring the
 * theme swatches use.
 */
export function AppIconGroup({
  value,
  platform,
  onChange
}: {
  value: AppIconId
  platform: Platform
  onChange: (id: AppIconId) => void
}): JSX.Element {
  return (
    <Group title="App icon">
      <Row label="Colour" hint={HINT[platform]}>
        <span className="text-[12.5px] text-[var(--zen-muted)]">{appIconVariant(value).name}</span>
      </Row>
      <div role="radiogroup" aria-label="App icon colour" className="zen-app-icon-grid p-3">
        {APP_ICON_VARIANTS.map((variant) => (
          <button
            key={variant.id}
            type="button"
            role="radio"
            aria-checked={variant.id === value}
            aria-label={`${variant.name} app icon`}
            className="zen-app-icon"
            onClick={() => onChange(variant.id)}
          >
            <AppIconImage variant={variant} />
            <span className="zen-app-icon-name">{variant.name}</span>
          </button>
        ))}
      </div>
    </Group>
  )
}

const VIEW = 100
const RING_OUTER = VIEW * APP_ICON_DESKTOP.ringOuter

/** The desktop icon as vector art, from the same geometry the generated assets come from. */
export function AppIconImage({
  variant,
  className
}: {
  variant: AppIconVariant
  className?: string
}): JSX.Element {
  return (
    <svg viewBox={`0 0 ${VIEW} ${VIEW}`} className={className} aria-hidden="true" focusable="false">
      <path d={squirclePath(VIEW)} fill={variant.fill} />
      <circle
        cx={VIEW / 2}
        cy={VIEW / 2}
        r={RING_OUTER * APP_ICON_MARK.ring}
        fill="none"
        stroke={APP_ICON_INK}
        strokeWidth={RING_OUTER * APP_ICON_MARK.stroke}
      />
      <circle cx={VIEW / 2} cy={VIEW / 2} r={RING_OUTER * APP_ICON_MARK.dot} fill={APP_ICON_INK} />
    </svg>
  )
}
