import type { JSX } from 'react'
import type { ToolbarLayout } from '@shared/types'
import { TOOLBAR_LAYOUTS, TOOLBAR_LAYOUT_LABELS } from '@shared/toolbarLayout'

/**
 * Look and Feel › Layout (design language v2 §9.37; §10.4's image radio cards; Zen 1.22's
 * Browser layout): the desktop's four layouts as one grid of picture cards – Only sidebar,
 * Sidebar and top toolbar, Collapsed sidebar, Horizontal tabs – each a line drawing of the
 * window it makes, in the page's ink on the page's fill so both schemes draw it from the
 * tokens, the choice wearing the shared card radio's 2 px accent outline and the caption 13
 * centred beneath. One setting with four pictures: picking a card applies live and
 * profile-wide; `Tabs on the right`, the switch under it, mirrors whichever layout is up.
 * The desktop's alone (`layouts: ['desktop']` on its row): the phone and the tablet have
 * shells of their own.
 */
export function LayoutCards({
  value,
  onChange
}: {
  value: ToolbarLayout
  onChange: (layout: ToolbarLayout) => void
}): JSX.Element {
  return (
    <div className="zen-settings-layout-block">
      <span className="zen-settings-label" id="zen-settings-layout-label">
        Layout
      </span>
      <div
        role="radiogroup"
        aria-labelledby="zen-settings-layout-label"
        className="zen-settings-layout-grid"
        data-layout-cards
      >
        {TOOLBAR_LAYOUTS.map((layout) => (
          <button
            key={layout}
            type="button"
            role="radio"
            aria-checked={layout === value}
            className="zen-settings-layout-card zen-v2-card-radio"
            data-value={layout}
            onClick={() => onChange(layout)}
          >
            <LayoutPicture layout={layout} />
            <span className="zen-settings-icon-caption">{TOOLBAR_LAYOUT_LABELS[layout]}</span>
          </button>
        ))}
      </div>
    </div>
  )
}

/** The drawing's box: a window 160 × 100, its outline inset 1 for the stroke. */
const W = 160
const H = 100
/** The stroke every line takes; the ink at 55 %, so the picture reads as a drawing, not a glyph. */
const STROKE = 1.5

/**
 * The window a layout makes, as a line drawing: the outline, the frame the page fills, the
 * chrome's rows as rounded strokes – the URL pill, the tab rows, the favicon squares – and the
 * active tab as one accent pill so the four pictures differ where the layouts do.
 */
export function LayoutPicture({ layout }: { layout: ToolbarLayout }): JSX.Element {
  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className="zen-settings-layout-art"
      aria-hidden="true"
      focusable="false"
      data-layout-picture={layout}
    >
      <rect
        x={1}
        y={1}
        width={W - 2}
        height={H - 2}
        rx={8}
        fill="none"
        stroke="currentColor"
        strokeOpacity={0.55}
        strokeWidth={STROKE}
      />
      {layout === 'single' && <OnlySidebar />}
      {layout === 'multiple' && <SidebarAndToolbar />}
      {layout === 'collapsed' && <CollapsedSidebar />}
      {layout === 'horizontal' && <HorizontalTabs />}
    </svg>
  )
}

/** The page's frame: the fill token, a rounded box. */
function Frame({ x, y, w, h }: { x: number; y: number; w: number; h: number }): JSX.Element {
  return <rect x={x} y={y} width={w} height={h} rx={5} fill="var(--v2-fill)" />
}

/** A chrome row drawn as a stroke with round caps: the URL pill, a tab's title bar. */
function Row({
  x,
  y,
  w,
  h = 6,
  active = false
}: {
  x: number
  y: number
  w: number
  h?: number
  active?: boolean
}): JSX.Element {
  return active ? (
    <rect x={x} y={y} width={w} height={h} rx={h / 2} fill="var(--v2-accent)" />
  ) : (
    <rect
      x={x}
      y={y}
      width={w}
      height={h}
      rx={h / 2}
      fill="none"
      stroke="currentColor"
      strokeOpacity={0.55}
      strokeWidth={STROKE}
    />
  )
}

/** A favicon-only tab: a small square, the active one filled. */
function Square({
  x,
  y,
  s = 8,
  active = false
}: {
  x: number
  y: number
  s?: number
  active?: boolean
}): JSX.Element {
  return active ? (
    <rect x={x} y={y} width={s} height={s} rx={2} fill="var(--v2-accent)" />
  ) : (
    <rect
      x={x}
      y={y}
      width={s}
      height={s}
      rx={2}
      fill="none"
      stroke="currentColor"
      strokeOpacity={0.55}
      strokeWidth={STROKE}
    />
  )
}

/** Only sidebar: the URL pill and the tab rows down the sidebar, the frame beside it. */
function OnlySidebar(): JSX.Element {
  return (
    <>
      <Row x={9} y={9} w={32} />
      <Row x={9} y={23} w={32} active />
      <Row x={9} y={35} w={32} />
      <Row x={9} y={47} w={32} />
      <Row x={9} y={59} w={32} />
      <Frame x={49} y={9} w={102} h={82} />
    </>
  )
}

/** Sidebar and top toolbar: the pill across the top, the tab rows down the sidebar under it. */
function SidebarAndToolbar(): JSX.Element {
  return (
    <>
      <Row x={9} y={9} w={142} />
      <Row x={9} y={23} w={32} active />
      <Row x={9} y={35} w={32} />
      <Row x={9} y={47} w={32} />
      <Row x={9} y={59} w={32} />
      <Frame x={49} y={23} w={102} h={68} />
    </>
  )
}

/** Collapsed sidebar: favicon squares down a narrow column, the frame taking the rest. */
function CollapsedSidebar(): JSX.Element {
  return (
    <>
      <Row x={9} y={9} w={14} />
      <Square x={12} y={23} active />
      <Square x={12} y={37} />
      <Square x={12} y={51} />
      <Square x={12} y={65} />
      <Frame x={31} y={9} w={120} h={82} />
    </>
  )
}

/** Horizontal tabs: the tab pills along the top, the toolbar row under them, the rail beside the frame. */
function HorizontalTabs(): JSX.Element {
  return (
    <>
      <Row x={9} y={8} w={26} active />
      <Row x={39} y={8} w={26} />
      <Row x={69} y={8} w={26} />
      <Row x={99} y={8} w={26} />
      <Row x={9} y={20} w={142} />
      <Square x={9} y={34} s={7} />
      <Square x={9} y={46} s={7} />
      <Square x={9} y={58} s={7} />
      <Frame x={22} y={32} w={129} h={59} />
    </>
  )
}
