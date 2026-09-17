// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest'
import type { TranslateRuntimeStatus } from '../translate'
import {
  TRANSLATE_RUNTIME_GLOBAL,
  TRANSLATE_RUNTIME_MISSING,
  TRANSLATE_RUNTIME_SOURCE,
  translateCall,
  translateInstallCall,
  type TranslatePageRuntime
} from '../translateScript'

/**
 * The runtime is shipped as source text and evaluated inside pages; here it runs against
 * happy-dom. happy-dom has no layout: element boxes come from a `data-box="x,y,w,h"` attribute
 * (everything else counts as not rendered, which still sorts deterministically).
 */

function installLayout(): void {
  Element.prototype.getBoundingClientRect = function (this: Element) {
    const spec = this.getAttribute('data-box')
    if (!spec) return new DOMRect(0, 0, 0, 0)
    const [x, y, w, h] = spec.split(',').map(Number)
    return new DOMRect(x, y, w, h)
  }
  Object.defineProperty(window, 'innerHeight', { value: 800, configurable: true })
}

function runtime(): TranslatePageRuntime {
  return new Function(`return ${TRANSLATE_RUNTIME_SOURCE}()`)() as TranslatePageRuntime
}

function evaluate<T>(script: string): T {
  return new Function(`return ${script}`)() as T
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

describe('translate page runtime', () => {
  let rt: TranslatePageRuntime

  beforeEach(() => {
    installLayout()
    document.documentElement.removeAttribute('lang')
    document.documentElement.removeAttribute('translate')
    document.documentElement.className = ''
    document.head.innerHTML = ''
    document.body.innerHTML = ''
    delete (globalThis as Record<string, unknown>)[TRANSLATE_RUNTIME_GLOBAL]
    rt = runtime()
  })

  it('is self-contained source', () => {
    expect(TRANSLATE_RUNTIME_SOURCE).not.toMatch(/\brequire\(|\bimport\b|\bexports\b/)
  })

  describe('sample', () => {
    it('reports the hints, the visible text (viewport first) and the total', () => {
      document.documentElement.setAttribute('lang', 'es-ES')
      document.head.innerHTML = '<meta http-equiv="Content-Language" content="es, en">'
      document.body.innerHTML = `
        <h1 data-box="0,900,100,20">Más abajo</h1>
        <p data-box="0,10,100,20">Primero en pantalla</p>
        <script>var x = 1</script>
        <p translate="no">No me traduzcas</p>
        <p>12345 --- </p>
        <p>Segundo</p>`
      const sample = rt.sample(2000)
      expect(sample.lang).toBe('es-ES')
      expect(sample.contentLanguage).toBe('es, en')
      expect(sample.notranslate).toBe(false)
      expect(sample.doc).toBeGreaterThan(0)
      // In the viewport first, then rendered below the fold, then elements without a box.
      expect(sample.text.split('\n')).toEqual(['Primero en pantalla', 'Más abajo', 'Segundo'])
      expect(sample.chars).toBe(
        'Primero en pantalla'.length + 'Segundo'.length + 'Más abajo'.length
      )
      expect(rt.sample(10).text.length).toBeLessThanOrEqual(10)
    })

    it('flags pages that opt out of translation', () => {
      document.body.innerHTML = '<p>Hello</p>'
      expect(rt.sample(100).notranslate).toBe(false)
      document.documentElement.setAttribute('translate', 'no')
      expect(rt.sample(100).notranslate).toBe(true)
      document.documentElement.removeAttribute('translate')
      document.head.innerHTML = '<meta name="google" content="notranslate">'
      expect(rt.sample(100).notranslate).toBe(true)
      document.head.innerHTML = ''
      document.documentElement.className = 'notranslate'
      expect(rt.sample(100).notranslate).toBe(true)
    })
  })

  describe('collection', () => {
    it('makes one unit per block and skips code, editable and no-translate content', () => {
      document.body.innerHTML = `
        <h1>Title</h1>
        <p>Read <a href="/x">the <em>docs</em></a> now.</p>
        <ul><li>One</li><li>Two</li></ul>
        <pre>code block</pre>
        <p><code>onlyCode()</code></p>
        <p translate="no">Keep me</p>
        <div contenteditable="">Editing here</div>
        <div class="notranslate">Brand name</div>
        <p>€ 12,50 (2024)</p>
        <div>Intro text<p>Nested block</p>trailing run <b>bold</b></div>
        <textarea>typed</textarea>`
      const status = rt.start(1)
      expect(status.session).toBe(1)
      expect(status.ended).toBe(false)
      const batch = rt.next(1, 100, 100000)
      expect(batch.items.map((item) => item.html)).toEqual([
        'Title',
        'Read <span data-zt="0">the <span data-zt="1">docs</span></span> now.',
        'One',
        'Two',
        'Intro text',
        'Nested block',
        'trailing run <span data-zt="0">bold</span>'
      ])
      expect(batch.total).toBe(7)
      expect(rt.next(1, 100, 100000).items).toEqual([])
    })

    it('serialises opaque inline elements as images and line breaks as br', () => {
      document.body.innerHTML = `<p>Run <code>ls -la</code> then<br>press <kbd>Enter</kbd> <img src="a.png" alt="x"> done</p>`
      rt.start(1)
      const [item] = rt.next(1, 10, 10000).items
      expect(item.html).toBe(
        'Run <img data-zt="0"> then<br data-zt="1">press <img data-zt="2"> <img data-zt="3"> done'
      )
    })

    it('hands out the viewport first and honours the batch limits', () => {
      document.body.innerHTML = `
        <p data-box="0,2000,100,20">Far below</p>
        <p data-box="0,100,100,20">Visible second</p>
        <p>Not rendered</p>
        <p data-box="0,-500,100,20">Above</p>
        <p data-box="0,10,100,20">Visible first</p>`
      rt.start(1)
      const first = rt.next(1, 2, 100000)
      expect(first.items.map((i) => i.html)).toEqual(['Visible first', 'Visible second'])
      const rest = rt.next(1, 10, 100000)
      expect(rest.items.map((i) => i.html)).toEqual(['Above', 'Far below', 'Not rendered'])
      rt.revert()
      rt.start(2)
      // The character budget is checked after every item, so one item always goes out.
      expect(rt.next(2, 10, 5).items).toHaveLength(1)
      expect(rt.next(2, 10, 30).items.length).toBeGreaterThanOrEqual(2)
    })
  })

  describe('apply and revert', () => {
    it('rebuilds the translation around the original inline elements and can undo it', () => {
      document.body.innerHTML =
        '<p id="p">Read <a id="link" href="/docs">the <em>docs</em></a> now.</p>'
      const original = document.getElementById('p')!.innerHTML
      const link = document.getElementById('link')!
      let clicks = 0
      link.addEventListener('click', () => clicks++)
      rt.start(1)
      const [item] = rt.next(1, 10, 10000).items
      const status = rt.apply(1, [
        {
          id: item.id,
          html: 'Lee ahora <span data-zt="0"><span data-zt="1">la documentación</span></span>.'
        }
      ])
      expect(status.done).toBe(1)
      expect(status.pending).toBe(0)
      const p = document.getElementById('p')!
      expect(p.textContent).toBe('Lee ahora la documentación.')
      const rebuilt = document.getElementById('link')!
      expect(rebuilt).toBe(link)
      expect(rebuilt.getAttribute('href')).toBe('/docs')
      expect(rebuilt.querySelector('em')?.textContent).toBe('la documentación')
      rebuilt.dispatchEvent(new Event('click'))
      expect(clicks).toBe(1)
      const reverted = rt.revert()
      expect(reverted.ended).toBe(true)
      expect(p.innerHTML).toBe(original)
      expect(rt.status().session).toBe(0)
    })

    it('never loses an inline element the translation dropped, and keeps untranslated units', () => {
      document.body.innerHTML =
        '<p id="p">See <a href="/a">A</a> and <a href="/b">B</a>.</p><p id="q">Other</p>'
      rt.start(1)
      const batch = rt.next(1, 10, 10000)
      rt.apply(1, [
        { id: batch.items[0].id, html: 'Ver <span data-zt="0">A</span>.' },
        { id: batch.items[1].id, html: null }
      ])
      const p = document.getElementById('p')!
      expect(p.querySelectorAll('a')).toHaveLength(2)
      expect(p.textContent).toBe('Ver A.B')
      expect(document.getElementById('q')!.textContent).toBe('Other')
      expect(rt.status().done).toBe(2)
      rt.revert()
      expect(p.textContent).toBe('See A and B.')
    })

    it('puts the space back between a word and an opaque element the engine glued together', () => {
      document.body.innerHTML =
        '<p id="p">Usa la aplicación <span translate="no">eBiblio</span>, en «<span translate="no">Zenium</span>» o <code>ls</code>.</p>'
      rt.start(1)
      const [item] = rt.next(1, 10, 10000).items
      expect(item.html).toBe(
        'Usa la aplicación <img data-zt="0">, en «<img data-zt="1">» o <img data-zt="2">.'
      )
      // Spaces lost around the first and third, none to add around the quoted one.
      rt.apply(1, [
        {
          id: item.id,
          html: 'Use the app<img data-zt="0">, in «<img data-zt="1">» or<img data-zt="2">.'
        }
      ])
      expect(document.getElementById('p')!.textContent).toBe(
        'Use the app eBiblio, in «Zenium» or ls.'
      )
      rt.revert()
      expect(document.getElementById('p')!.textContent).toBe(
        'Usa la aplicación eBiblio, en «Zenium» o ls.'
      )
    })

    it('ignores answers for other sessions or units it did not send', () => {
      document.body.innerHTML = '<p>Hello</p>'
      rt.start(1)
      const [item] = rt.next(1, 10, 10000).items
      rt.apply(2, [{ id: item.id, html: 'Hola' }])
      rt.apply(1, [{ id: 999, html: 'Hola' }])
      expect(document.body.textContent).toBe('Hello')
      rt.apply(1, [{ id: item.id, html: 'Hola' }])
      expect(document.body.textContent).toBe('Hola')
      rt.apply(1, [{ id: item.id, html: 'Again' }])
      expect(document.body.textContent).toBe('Hola')
    })

    it('starting a new session reverts the previous one', () => {
      document.body.innerHTML = '<p>Hello</p>'
      rt.start(1)
      const [item] = rt.next(1, 10, 10000).items
      rt.apply(1, [{ id: item.id, html: 'Hola' }])
      rt.start(2)
      expect(document.body.textContent).toBe('Hello')
      expect(rt.next(1, 10, 10000).items).toEqual([])
      expect(rt.next(2, 10, 10000).items[0].html).toBe('Hello')
    })
  })

  describe('mutations', () => {
    it('picks up content added later and wakes a waiting caller', async () => {
      document.body.innerHTML = '<div id="feed"><p>First</p></div>'
      rt.start(1)
      const batch = rt.next(1, 10, 10000)
      rt.apply(1, [{ id: batch.items[0].id, html: 'Primero' }])
      const waiting = rt.wait(1, 5000)
      const p = document.createElement('p')
      p.textContent = 'Second'
      document.getElementById('feed')!.appendChild(p)
      await tick()
      const woke = await waiting
      expect(woke).toEqual({ pending: 1, ended: false })
      const next = rt.next(1, 10, 10000)
      expect(next.items.map((i) => i.html)).toEqual(['Second'])
      expect(next.total).toBe(2)
    })

    it('leaves live text edits inside translated units alone but re-sends replaced content', async () => {
      document.body.innerHTML = '<p id="a">Count <span id="n">1</span></p><p id="b">Old</p>'
      rt.start(1)
      const batch = rt.next(1, 10, 10000)
      rt.apply(1, [
        { id: batch.items[0].id, html: 'Cuenta <span data-zt="0">1</span>' },
        { id: batch.items[1].id, html: 'Viejo' }
      ])
      document.getElementById('n')!.firstChild!.textContent = '2'
      await tick()
      expect(rt.status().pending).toBe(0)
      expect(document.getElementById('a')!.textContent).toBe('Cuenta 2')
      document.getElementById('b')!.textContent = 'Brand new'
      await tick()
      expect(rt.status().pending).toBe(1)
      const again = rt.next(1, 10, 10000)
      expect(again.items.map((i) => i.html)).toEqual(['Brand new'])
      rt.apply(1, [{ id: again.items[0].id, html: 'Nuevo' }])
      expect(document.getElementById('b')!.textContent).toBe('Nuevo')
      rt.revert()
      expect(document.getElementById('b')!.textContent).toBe('Brand new')
    })

    it('wait returns at once for ended or foreign sessions and after the timeout', async () => {
      document.body.innerHTML = '<p>Hello</p>'
      rt.start(1)
      rt.next(1, 10, 10000)
      expect(await rt.wait(2, 5000)).toEqual({ pending: 0, ended: true })
      expect(await rt.wait(1, 0)).toEqual({ pending: 0, ended: false })
      const pending = rt.wait(1, 5000)
      rt.revert()
      expect((await pending).ended).toBe(true)
    })
  })

  describe('scripts', () => {
    it('install once, then call the installed runtime', () => {
      document.body.innerHTML = '<p>Hello</p>'
      expect(evaluate(translateCall('status'))).toBe(TRANSLATE_RUNTIME_MISSING)
      const installed = evaluate<TranslateRuntimeStatus>(translateInstallCall('status'))
      expect(installed.session).toBe(0)
      const doc = installed.doc
      expect(evaluate<TranslateRuntimeStatus>(translateCall('status')).doc).toBe(doc)
      expect(evaluate<TranslateRuntimeStatus>(translateCall('start', 7)).session).toBe(7)
      expect(
        evaluate<{ items: { html: string }[] }>(translateCall('next', 7, 5, 100)).items[0].html
      ).toBe('Hello')
      expect(translateCall('next', 7, 5, 100).length).toBeLessThan(300)
      expect(translateInstallCall('status').length).toBeGreaterThan(5000)
    })

    it('reads the selection as plain text', () => {
      document.body.innerHTML = '<p id="p">Some  selected\n text</p>'
      const selection = document.getSelection()
      if (!selection) return
      const range = document.createRange()
      range.selectNodeContents(document.getElementById('p')!)
      selection.removeAllRanges()
      selection.addRange(range)
      const text = rt.selection(100)
      if (text) expect(text).toBe('Some selected text')
      expect(rt.selection(4).length).toBeLessThanOrEqual(4)
    })
  })
})
