import { useCallback, useEffect, useRef, useState } from 'react'
import { cmd } from '@renderer/lib/api'

/**
 * Settings › Languages › Spell check › Custom dictionary: Chrome's "Customize spell check", the
 * words the checker never marks. The profile's dictionary is not part of the UI state (a text
 * field's Add to Dictionary writes it too), so the page reads it with `spellcheck.words` while
 * the Languages category is shown and again after every change here, and the builder – a plain
 * function of the state – gets the result through its `SectionContext`, as Autofill's vault
 * lists do (`useAutofillSettings`).
 */
export interface DictionaryWords {
  /** The words, sorted as the profile holds them; `null` until read, and while the list is not live. */
  words: string[] | null
  /**
   * Add one word: refused with the form's validation text (one word without spaces, not there
   * already, the host declined it), `undefined` once it is in and the list has been read again.
   */
  add(word: string): Promise<string | undefined>
  /** Remove a word; the list is read again either way. */
  remove(word: string): void
}

/** Why a word cannot go in, or `undefined` for one the host may take. */
export function wordProblem(word: string, words: readonly string[] | null): string | undefined {
  if (!word) return 'Enter a word'
  if (/\s/.test(word)) return 'Enter one word without spaces'
  if (words?.some((w) => w.toLowerCase() === word.toLowerCase())) {
    return 'This word is in the dictionary already'
  }
  return undefined
}

export function useDictionaryWords(live: boolean): DictionaryWords {
  const [words, setWords] = useState<string[] | null>(null)
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])
  const refresh = useCallback((): Promise<void> => {
    return cmd('spellcheck.words', undefined)
      .then((list) => {
        if (alive.current) setWords(Array.isArray(list) ? list : [])
      })
      .catch(() => {
        if (alive.current) setWords([])
      })
  }, [])
  useEffect(() => {
    if (live) void refresh()
  }, [live, refresh])
  const add = useCallback(
    async (raw: string): Promise<string | undefined> => {
      const word = raw.trim()
      const problem = wordProblem(word, words)
      if (problem) return problem
      const added = await cmd('spellcheck.addWord', { word }).catch(() => false)
      if (!added) return 'This word could not be added'
      await refresh()
      return undefined
    },
    [words, refresh]
  )
  const remove = useCallback(
    (word: string): void => {
      void cmd('spellcheck.removeWord', { word }).then(refresh, refresh)
    },
    [refresh]
  )
  return { words: live ? words : null, add, remove }
}

/** No dictionary to read (a test, a preview): no words, actions that do nothing. */
export function idleDictionaryWords(): DictionaryWords {
  return { words: null, add: async () => undefined, remove: () => undefined }
}
