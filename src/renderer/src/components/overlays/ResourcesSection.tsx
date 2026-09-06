import type { JSX } from 'react'
import { useState } from 'react'
import {
  BatteryCharging,
  Cpu,
  MemoryStick,
  Monitor,
  RefreshCw,
  RotateCw,
  Snowflake,
  Turtle,
  Zap
} from 'lucide-react'
import type {
  GovernorAction,
  GovernorActionKind,
  GpuMode,
  ResourceEnforcement,
  ResourceGauge,
  ResourceProcessProfile,
  ResourceSettings,
  Settings,
  UIState
} from '@shared/types'
import { run } from '@renderer/lib/api'
import { tabTitle } from '@renderer/lib/selectors'
import { cn } from '@renderer/lib/utils'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Slider } from '../ui/slider'
import { Switch } from '../ui/switch'
import { Choice, Group, Row } from './SettingsPrimitives'

const ACTION_LABELS: Record<GovernorActionKind, string> = {
  purge: 'Purged memory of',
  throttle: 'Throttled CPU of',
  unthrottle: 'Unthrottled',
  freeze: 'Froze',
  thaw: 'Woke',
  discard: 'Unloaded',
  reload: 'Reloaded',
  'pause-media': 'Paused media in',
  defer: 'Deferred loading'
}

export function ResourcesSection({
  state,
  set
}: {
  state: UIState
  set: (p: Partial<Settings>) => void
}): JSX.Element {
  const r = state.settings.resources
  const snap = state.resources
  const setR = (patch: Partial<ResourceSettings>): void => set({ resources: { ...r, ...patch } })
  const setP = (patch: Partial<ResourceProcessProfile>): void =>
    set({ resources: { ...r, process: { ...r.process, ...patch } } })
  const totalMb = snap.system.totalMemoryMb
  const percentBudget = totalMb ? Math.round((totalMb * r.memoryPercent) / 100) : 0

  return (
    <>
      <p className="text-[13px] text-[var(--zen-muted)]">
        The resource governor keeps every Chromium process of this browser under the budgets you
        set. Hidden pages are purged, CPU-throttled, frozen and finally unloaded – cheapest first –
        and background loads queue up instead of all starting at once.
      </p>

      <Group title="Live usage">
        <div className="flex flex-col gap-4 p-4">
          <Meter
            icon={MemoryStick}
            label="Memory"
            gauge={snap.memory}
            fallbackMax={totalMb}
            format={fmtMb}
            sub={`${snap.loadedTabs} live · ${snap.frozenTabs} frozen · ${snap.throttledTabs} throttled · ${snap.queuedLoads} waiting to load · ${fmtMb(snap.overheadMb)} browser, GPU & network overhead`}
          />
          <Meter
            icon={Cpu}
            label="CPU"
            gauge={snap.cpu}
            fallbackMax={100}
            format={(v) => `${Math.round(v)}%`}
            sub={`Share of all ${snap.system.cpuCount || '?'} cores; pages see ${concurrencyFor(r, snap.system.cpuCount)} of them.`}
          />
          <Meter
            icon={Monitor}
            label="GPU memory"
            gauge={snap.gpu}
            fallbackMax={0}
            format={fmtMb}
            sub={r.gpuMode === 'off' ? 'Hardware acceleration is off.' : undefined}
          />
          {snap.system.onBattery && (
            <div className="flex items-center gap-2 text-[12px] text-amber-600 dark:text-amber-400">
              <BatteryCharging className="h-3.5 w-3.5" />
              On battery – budgets are tightened to {Math.round(r.batteryFactor * 100)}%.
            </div>
          )}
          {snap.system.idle && (
            <div className="flex items-center gap-2 text-[12px] text-[var(--zen-muted)]">
              <Snowflake className="h-3.5 w-3.5" />
              System idle – hidden pages are frozen.
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            <Button size="sm" onClick={() => run('resources.trim', undefined)}>
              <Zap className="mr-1.5 h-3.5 w-3.5" />
              Free up memory now
            </Button>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => run('resources.snapshot', undefined)}
            >
              <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
              Refresh
            </Button>
            <span className="self-center text-[11.5px] text-[var(--zen-muted)]">
              {snap.sampledAt ? `Sampled ${ago(snap.sampledAt)}` : 'Waiting for the first sample…'}
            </span>
          </div>
        </div>
      </Group>

      {snap.tabs.some((u) => state.tabs[u.tabId] && !state.tabs[u.tabId].discarded) && (
        <Group title="Biggest pages">
          {snap.tabs.slice(0, 8).map((u) => {
            const tab = state.tabs[u.tabId]
            if (!tab || tab.discarded) return null
            return (
              <Row
                key={u.tabId}
                label={tabTitle(tab)}
                hint={`${fmtMb(u.memoryMb)} · ${u.cpuPercent.toFixed(1)}% CPU · ${u.processes} process${u.processes === 1 ? '' : 'es'}`}
              >
                {tab.frozen && <Snowflake className="h-3.5 w-3.5 text-[var(--zen-muted)]" />}
                {tab.cpuThrottle > 1 && (
                  <span className="flex items-center gap-1 text-[11.5px] text-[var(--zen-muted)]">
                    <Turtle className="h-3.5 w-3.5" />×{tab.cpuThrottle}
                  </span>
                )}
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => run('tab.unload', { tabId: u.tabId })}
                >
                  Unload
                </Button>
              </Row>
            )
          })}
        </Group>
      )}

      <Group title="Resource Governor">
        <Row
          label="Keep the browser within budgets"
          hint="Turning this off also drops the startup switches below after a relaunch."
        >
          <Switch checked={r.enabled} onCheckedChange={(v) => setR({ enabled: v })} />
        </Row>
        <Row
          label="Enforcement"
          hint="Balanced only touches hidden pages. Strict may also purge and throttle visible panes. Extreme may throttle and, as a last resort, reload the page you are looking at."
        >
          <Choice<ResourceEnforcement>
            value={r.enforcement}
            onChange={(v) => setR({ enforcement: v })}
            options={[
              { value: 'balanced', label: 'Balanced – hidden pages only' },
              { value: 'strict', label: 'Strict – visible panes too' },
              { value: 'extreme', label: 'Extreme – even the active page' }
            ]}
          />
        </Row>
      </Group>

      <Group title="Budgets">
        <Row
          label="Memory budget (MB)"
          hint={
            r.memoryMb > 0
              ? 'Every Chromium process together. Set to 0 to use a share of installed RAM instead.'
              : `Using ${r.memoryPercent}% of installed RAM${totalMb ? ` = ${fmtMb(percentBudget)}` : ''}.`
          }
        >
          <NumberField
            value={r.memoryMb}
            min={0}
            max={1_048_576}
            step={256}
            onCommit={(v) => setR({ memoryMb: v })}
          />
        </Row>
        <Row label="Share of installed RAM" hint="Used when the MB budget above is 0.">
          <PercentSlider
            value={r.memoryPercent}
            min={5}
            max={100}
            step={5}
            disabled={r.memoryMb > 0}
            onCommit={(v) => setR({ memoryPercent: v })}
          />
        </Row>
        <Row
          label="CPU budget"
          hint="Share of the whole machine. Pages are also told they have proportionally fewer cores (navigator.hardwareConcurrency). 100% = no limit."
        >
          <PercentSlider
            value={r.cpuPercent}
            min={5}
            max={100}
            step={5}
            onCommit={(v) => setR({ cpuPercent: v })}
          />
        </Row>
        <Row
          label="GPU memory budget (MB)"
          hint="0 = no limit. Also caps Chromium's GPU tile memory after a relaunch."
        >
          <NumberField
            value={r.gpuMemoryMb}
            min={0}
            max={65_536}
            step={128}
            onCommit={(v) => setR({ gpuMemoryMb: v })}
          />
        </Row>
        <Row label="On battery, shrink budgets to">
          <Choice
            value={String(Math.round(r.batteryFactor * 100))}
            onChange={(v) => setR({ batteryFactor: Number(v) / 100 })}
            options={[
              { value: '100', label: '100% (no change)' },
              { value: '85', label: '85%' },
              { value: '70', label: '70%' },
              { value: '50', label: '50%' },
              { value: '25', label: '25%' }
            ]}
          />
        </Row>
      </Group>

      <Group title="Sleeping & unloading">
        <Row
          label="Freeze hidden pages after (minutes)"
          hint="A frozen page keeps its state but runs no script or timers, like Chrome's tab freezing. 0 freezes as soon as a page is hidden."
        >
          <NumberField
            value={r.freezeAfterMinutes}
            min={0}
            max={1440}
            onCommit={(v) => setR({ freezeAfterMinutes: v })}
          />
        </Row>
        <Row
          label="Freeze everything when idle for (minutes)"
          hint="No input anywhere on the system. 0 = off. Extreme enforcement freezes visible pages as well."
        >
          <NumberField
            value={r.idleFreezeMinutes}
            min={0}
            max={1440}
            onCommit={(v) => setR({ idleFreezeMinutes: v })}
          />
        </Row>
        <Row
          label="Unload hidden pages after (minutes)"
          hint="Zen's tab unloading; the same setting as under Tab Management."
        >
          <Switch
            checked={state.settings.unloadEnabled}
            onCheckedChange={(v) => set({ unloadEnabled: v })}
          />
          <NumberField
            value={state.settings.unloadTimeoutMinutes}
            min={1}
            max={1440}
            onCommit={(v) => set({ unloadTimeoutMinutes: v })}
          />
        </Row>
        <Row
          label="Maximum live pages"
          hint="Hard cap on pages kept in memory; the oldest hidden page is unloaded to make room. 0 = unlimited."
        >
          <NumberField
            value={r.maxLoadedTabs}
            min={0}
            max={500}
            onCommit={(v) => setR({ maxLoadedTabs: v })}
          />
        </Row>
        <Row
          label="Background loads at once"
          hint="Further background tabs wait in a queue instead of starting more renderers."
        >
          <NumberField
            value={r.maxConcurrentLoads}
            min={1}
            max={16}
            onCommit={(v) => setR({ maxConcurrentLoads: v })}
          />
        </Row>
      </Group>

      <Group title="Never touch">
        <Row label="Pages playing audio">
          <Switch checked={r.protectAudible} onCheckedChange={(v) => setR({ protectAudible: v })} />
        </Row>
        <Row label="Pinned tabs">
          <Switch checked={r.protectPinned} onCheckedChange={(v) => setR({ protectPinned: v })} />
        </Row>
        <Row label="Essentials">
          <Switch
            checked={r.protectEssentials}
            onCheckedChange={(v) => setR({ protectEssentials: v })}
          />
        </Row>
        <Row
          label="Excluded domains"
          hint={
            state.settings.unloadExcludedDomains.length
              ? state.settings.unloadExcludedDomains.join(', ')
              : 'None – add them under Tab Management → Never unload these domains.'
          }
        >
          <span />
        </Row>
      </Group>

      <Group title="Process profile (relaunch required)">
        {snap.restartRequired && (
          <div className="flex items-center gap-3 border-b border-[var(--zen-border)] bg-amber-500/10 px-4 py-3 text-[12.5px]">
            <span className="flex-1">
              These switches only take effect when the browser starts. Relaunch to apply them.
            </span>
            <Button size="sm" onClick={() => run('resources.relaunch', undefined)}>
              <RotateCw className="mr-1.5 h-3.5 w-3.5" />
              Relaunch Zen
            </Button>
          </div>
        )}
        <Row
          label="GPU"
          hint="Low keeps compositing on the GPU but rasterises, decodes video and draws canvases on the CPU. Off disables hardware acceleration."
        >
          <Choice<GpuMode>
            value={r.gpuMode}
            onChange={(v) => setR({ gpuMode: v })}
            options={[
              { value: 'auto', label: 'Automatic' },
              { value: 'low', label: 'Low GPU usage' },
              { value: 'off', label: 'Off – software rendering' }
            ]}
          />
        </Row>
        <Row
          label="Renderer process limit"
          hint="Chromium reuses processes across sites once the limit is reached. 0 = Chromium's default."
        >
          <NumberField
            value={r.process.rendererProcessLimit}
            min={0}
            max={64}
            onCommit={(v) => setP({ rendererProcessLimit: v })}
          />
        </Row>
        <Row
          label="JavaScript heap cap per page (MB)"
          hint="A page that grows past its V8 heap cap is unloaded instead of bloating. 0 = default."
        >
          <NumberField
            value={r.process.rendererHeapMb}
            min={0}
            max={16384}
            step={128}
            onCommit={(v) => setP({ rendererHeapMb: v })}
          />
        </Row>
        <Row
          label="Low-end device mode"
          hint="Chromium sizes every cache and tile budget as if this were a low-memory device."
        >
          <Switch
            checked={r.process.lowEndDeviceMode}
            onCheckedChange={(v) => setP({ lowEndDeviceMode: v })}
          />
        </Row>
        <Row
          label="Drop the back/forward cache"
          hint="Chromium otherwise keeps up to six previous documents alive per tab."
        >
          <Switch
            checked={r.process.disableBackForwardCache}
            onCheckedChange={(v) => setP({ disableBackForwardCache: v })}
          />
        </Row>
        <Row
          label="Block prerendering"
          hint="Stops pages from loading other pages in hidden renderers ahead of time."
        >
          <Switch
            checked={r.process.disablePrerender}
            onCheckedChange={(v) => setP({ disablePrerender: v })}
          />
        </Row>
        <Row label="Raster threads per page" hint="0 = Chromium's default.">
          <NumberField
            value={r.process.rasterThreads}
            min={0}
            max={8}
            onCommit={(v) => setP({ rasterThreads: v })}
          />
        </Row>
        <Row label="V8: favour memory over speed" hint="Smaller heaps, slightly slower script.">
          <Switch
            checked={r.process.v8OptimizeForSize}
            onCheckedChange={(v) => setP({ v8OptimizeForSize: v })}
          />
        </Row>
      </Group>

      <Group title="Recent actions">
        {snap.recentActions.length === 0 ? (
          <div className="px-4 py-6 text-center text-[12.5px] text-[var(--zen-muted)]">
            Nothing yet – the governor has not had to act.
          </div>
        ) : (
          snap.recentActions
            .slice(0, 15)
            .map((a, i) => <ActionRow key={`${a.at}-${i}`} action={a} />)
        )}
      </Group>
    </>
  )
}

// ---------------------------------------------------------------------------

function Meter({
  icon: Icon,
  label,
  gauge,
  fallbackMax,
  format,
  sub
}: {
  icon: typeof Cpu
  label: string
  gauge: ResourceGauge
  /** Scale for the bar when there is no budget (0 = no bar). */
  fallbackMax: number
  format: (v: number) => string
  sub?: string
}): JSX.Element {
  const max = gauge.budget > 0 ? gauge.budget : fallbackMax
  const pct = max > 0 ? (gauge.used / max) * 100 : 0
  const tone =
    gauge.budget === 0
      ? 'bg-[var(--zen-accent)]/50'
      : pct >= 100
        ? 'bg-red-500'
        : pct >= 85
          ? 'bg-amber-500'
          : 'bg-[var(--zen-accent)]'
  return (
    <div>
      <div className="mb-1 flex items-center justify-between text-[12.5px]">
        <span className="flex items-center gap-1.5">
          <Icon className="h-3.5 w-3.5 text-[var(--zen-muted)]" />
          {label}
        </span>
        <span className="tabular-nums text-[var(--zen-muted)]">
          {format(gauge.used)}
          {gauge.budget > 0 ? ` / ${format(gauge.budget)}` : ' · no limit'}
          {gauge.budget > 0 && gauge.budget !== gauge.configured
            ? ` (${format(gauge.configured)} on mains)`
            : ''}
        </span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-[var(--zen-element-bg-active)]">
        <div
          className={cn('h-full rounded-full transition-[width] duration-500', tone)}
          style={{ width: `${Math.max(0, Math.min(100, pct))}%` }}
        />
      </div>
      {sub && <div className="mt-1 text-[11.5px] text-[var(--zen-muted)]">{sub}</div>}
    </div>
  )
}

interface NumberFieldProps {
  value: number
  min: number
  max: number
  step?: number
  onCommit: (v: number) => void
}

/** Number input that commits on blur / Enter, so typing "10" never gets clamped at "1". */
function NumberField(props: NumberFieldProps): JSX.Element {
  // Remount when the committed value changes elsewhere so the draft text follows it.
  return <NumberDraft key={props.value} {...props} />
}

function NumberDraft({ value, min, max, step = 1, onCommit }: NumberFieldProps): JSX.Element {
  const [text, setText] = useState(String(value))
  const commit = (): void => {
    const n = Number(text)
    if (!Number.isFinite(n)) {
      setText(String(value))
      return
    }
    const clamped = Math.max(min, Math.min(max, Math.round(n)))
    setText(String(clamped))
    if (clamped !== value) onCommit(clamped)
  }
  return (
    <Input
      type="number"
      min={min}
      max={max}
      step={step}
      className="w-24"
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit()
      }}
    />
  )
}

interface PercentSliderProps {
  value: number
  min: number
  max: number
  step: number
  disabled?: boolean
  onCommit: (v: number) => void
}

function PercentSlider(props: PercentSliderProps): JSX.Element {
  return <PercentDraft key={props.value} {...props} />
}

function PercentDraft({
  value,
  min,
  max,
  step,
  disabled,
  onCommit
}: PercentSliderProps): JSX.Element {
  const [local, setLocal] = useState(value)
  return (
    <div className={cn('flex w-56 items-center gap-3', disabled && 'opacity-50')}>
      <Slider
        value={[local]}
        min={min}
        max={max}
        step={step}
        disabled={disabled}
        onValueChange={([v]) => setLocal(v)}
        onValueCommit={([v]) => onCommit(v)}
      />
      <span className="w-10 text-right text-[12.5px] tabular-nums">{local}%</span>
    </div>
  )
}

function ActionRow({ action }: { action: GovernorAction }): JSX.Element {
  return (
    <div className="flex items-center gap-3 border-b border-[var(--zen-border)] px-4 py-2 text-[12.5px] last:border-b-0">
      <span className="w-16 shrink-0 text-[11.5px] tabular-nums text-[var(--zen-muted)]">
        {ago(action.at)}
      </span>
      <span className="min-w-0 flex-1 truncate">
        {ACTION_LABELS[action.kind]} <span className="font-medium">{action.title || 'a tab'}</span>
        <span className="text-[var(--zen-muted)]"> – {action.reason}</span>
      </span>
    </div>
  )
}

function concurrencyFor(r: ResourceSettings, cores: number): string {
  if (!cores) return '?'
  if (!r.enabled || r.cpuPercent >= 100) return String(cores)
  return String(Math.max(1, Math.min(cores, Math.round((cores * r.cpuPercent) / 100))))
}

function fmtMb(mb: number): string {
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`
  return `${Math.round(mb).toLocaleString('en-US')} MB`
}

function ago(at: number): string {
  const s = Math.max(0, Math.round((Date.now() - at) / 1000))
  if (s < 5) return 'just now'
  if (s < 60) return `${s}s ago`
  const m = Math.round(s / 60)
  if (m < 60) return `${m} min ago`
  return `${Math.round(m / 60)} h ago`
}
