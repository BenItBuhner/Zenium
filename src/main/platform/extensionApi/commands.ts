import type { KeyEventInput } from '../../../core/platform'
import type { ZenWindow } from '../../../core/window'
import type { ExtensionCommandInfo } from '../../../shared/types'
import { bindingFromInput, formatBinding, isModifierKey } from '../../../shared/shortcuts'
import {
  EXECUTE_ACTION_COMMANDS,
  commandForBinding,
  describeUnbound,
  formatCommandShortcut,
  resolveCommands,
  type ExtensionCommand,
  type TakenBinding
} from '../../../core/extensions/api/commands'
import type { ActionApi } from './action'
import type { ActiveTabGrants } from './activeTab'
import type { SidePanelApi } from './sidePanel'
import type { ApiContext, ApiHost, LoadedExtension, NamespaceHandlers } from './types'

/**
 * `chrome.commands`: the manifest's commands resolved against Zenium's shortcut table (an
 * extension never takes a Zenium key; the first extension to claim a key keeps it), `getAll`, and
 * the dispatch from the key handling: `_execute_action` opens the popup or fires `action.onClicked`
 * like a toolbar click, everything else is `commands.onCommand(name, tab)`. Manifest `global`
 * shortcuts are bound per window like the others (Zenium registers no system-wide keys).
 */
export class CommandsApi {
  private readonly commands = new Map<string, ExtensionCommand[]>()

  constructor(
    private readonly host: ApiHost,
    private readonly action: ActionApi,
    private readonly activeTab: ActiveTabGrants,
    private readonly sidePanel: SidePanelApi
  ) {}

  readonly handlers: NamespaceHandlers = {
    getAll: (ctx) => this.getAll(ctx)
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  load(ext: LoadedExtension): void {
    this.commands.set(ext.id, this.resolve(ext, this.taken(ext.id)))
  }

  unload(extensionId: string): void {
    this.commands.delete(extensionId)
  }

  /** Zenium's shortcut table changed: every binding is decided again, in load order. */
  refresh(): void {
    const taken: TakenBinding[] = []
    for (const id of [...this.commands.keys()]) {
      const ext = this.host.loaded(id)
      if (!ext) {
        this.commands.delete(id)
        continue
      }
      const resolved = this.resolve(ext, taken)
      this.commands.set(id, resolved)
      taken.push(...this.takenOf(ext, resolved))
    }
    this.host.commitUi()
  }

  private resolve(ext: LoadedExtension, taken: TakenBinding[]): ExtensionCommand[] {
    const { state } = this.host.browser
    return resolveCommands(ext.manifest.commands, state.platform, state.shortcuts, taken)
  }

  /** Keys the other loaded extensions hold. */
  private taken(except: string): TakenBinding[] {
    const out: TakenBinding[] = []
    for (const [id, commands] of this.commands) {
      if (id === except) continue
      const ext = this.host.loaded(id)
      if (ext) out.push(...this.takenOf(ext, commands))
    }
    return out
  }

  private takenOf(ext: LoadedExtension, commands: readonly ExtensionCommand[]): TakenBinding[] {
    const out: TakenBinding[] = []
    for (const command of commands) {
      if (command.binding) {
        out.push({ binding: command.binding, owner: `${ext.manifest.name}: ${command.name}` })
      }
    }
    return out
  }

  // ---------------------------------------------------------------------------
  // What the UI shows
  // ---------------------------------------------------------------------------

  /** The commands of an extension for `ExtensionInfo`, or null when it is not loaded. */
  infoFor(extensionId: string): { commands: ExtensionCommandInfo[]; conflicts: string[] } | null {
    const commands = this.commands.get(extensionId)
    if (!commands) return null
    const platform = this.host.browser.state.platform
    const conflicts: string[] = []
    const infos: ExtensionCommandInfo[] = commands.map((command) => {
      const reason = describeUnbound(command)
      if (reason && command.suggested) conflicts.push(reason)
      return {
        name: command.name,
        description: command.description,
        shortcut: command.binding ? formatBinding(command.binding, platform) : null,
        executesAction: EXECUTE_ACTION_COMMANDS.has(command.name)
      }
    })
    return { commands: infos, conflicts }
  }

  // ---------------------------------------------------------------------------
  // Routed calls
  // ---------------------------------------------------------------------------

  private getAll(ctx: ApiContext): Array<{ name: string; description: string; shortcut: string }> {
    const platform = this.host.browser.state.platform
    return (this.commands.get(ctx.extensionId) ?? []).map((command) => ({
      name: command.name,
      description: command.description,
      shortcut: formatCommandShortcut(command.binding, platform)
    }))
  }

  // ---------------------------------------------------------------------------
  // Key dispatch
  // ---------------------------------------------------------------------------

  /**
   * A key no Zenium shortcut claimed. True when an extension command is bound to it and was
   * dispatched; the caller then swallows the event so the page never sees it.
   */
  handleKey(input: KeyEventInput, win: ZenWindow): boolean {
    if (input.type !== 'keyDown' || isModifierKey(input.key)) return false
    const pressed = bindingFromInput(input)
    for (const [extensionId, commands] of this.commands) {
      const command = commandForBinding(commands, pressed)
      if (!command) continue
      const ext = this.host.loaded(extensionId)
      if (!ext) continue
      this.trigger(ext, command, win)
      return true
    }
    return false
  }

  private trigger(ext: LoadedExtension, command: ExtensionCommand, win: ZenWindow): void {
    const active = this.host.browser.tabs.activeTabFor(win)
    if (active) this.activeTab.grant(ext.id, active)
    if (EXECUTE_ACTION_COMMANDS.has(command.name)) {
      const { popup, enabled } = this.action.clickState(ext.id, win)
      if (!enabled) return
      if (this.sidePanel.opensOnActionClick(ext.id, win)) this.sidePanel.toggle(ext.id, win)
      else if (popup) this.host.openPopup(ext.id, win)
      else this.action.clicked(ext.id, win)
      return
    }
    const tab = active
      ? this.host.model.chromeTab(active, this.host.canSeeTab(ext, active.url))
      : undefined
    const args: unknown[] = tab ? [command.name, tab] : [command.name]
    this.host.dispatch(ext.id, 'commands', 'onCommand', args, { wake: true })
  }
}
