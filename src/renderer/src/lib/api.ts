import type { CommandArgs, CommandName, CommandResult, EventName, Events } from '@shared/types'

/** Typed command invocation. Errors are logged, never thrown into React trees. */
export async function cmd<K extends CommandName>(
  name: K,
  args: CommandArgs<K>
): Promise<CommandResult<K>> {
  try {
    return await window.zen.invoke(name, args)
  } catch (error) {
    console.error(`[zen] command ${name} failed`, error)
    throw error
  }
}

/** Fire-and-forget variant for event handlers. */
export function run<K extends CommandName>(name: K, args: CommandArgs<K>): void {
  void cmd(name, args).catch(() => undefined)
}

export function onEvent<K extends EventName>(
  name: K,
  listener: (payload: Events[K]) => void
): () => void {
  return window.zen.on(name, listener)
}
