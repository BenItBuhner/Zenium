import { describe, expect, it } from 'vitest'
import {
  articleSampleText,
  rebuildUnitHtml,
  renderArticleHtml,
  splitArticleHtml
} from '../articleHtml'

const ARTICLE = `<div id="readability-page-1" class="page"><div>
<p>Este es un párrafo con <a href="/x">un enlace</a> dentro del texto.</p>
<h2>Segundo título</h2>
<ul><li>Primero</li><li>Segundo con <code>código</code> dentro</li></ul>
<figure><img src="/a.png" alt="foto"><figcaption>Una foto</figcaption></figure>
<pre>no se traduce
  nunca</pre>
<p><img src="/b.png"></p>
<p translate="no">Marca registrada</p>
<table><tbody><tr><td>Celda &amp; más</td><td>42</td></tr></tbody></table>
<blockquote>Cita<br>con salto</blockquote>
</div></div>`

describe('splitArticleHtml', () => {
  it('makes one unit of every block with prose and leaves the rest literal', () => {
    const split = splitArticleHtml(ARTICLE)
    expect(split.units.map((u) => u.text)).toEqual([
      'Este es un párrafo con un enlace dentro del texto.',
      'Segundo título',
      'Primero',
      'Segundo con dentro',
      'Una foto',
      'Celda & más',
      'Cita con salto'
    ])
    // The literal parts and the units read back as the article, byte for byte.
    const joined = split.parts
      .map((part) => (typeof part === 'string' ? part : split.units[part].html))
      .join('')
    expect(joined).toBe(ARTICLE)
  })

  it('serialises inline elements as the page runtime does, opaque ones as tokens', () => {
    const split = splitArticleHtml(ARTICLE)
    const [link, , , code, , cell, quote] = split.units
    expect(link.source).toBe(
      'Este es un párrafo con <span data-zt="0">un enlace</span> dentro del texto.'
    )
    expect(link.inlines[0]).toMatchObject({
      open: '<a href="/x">',
      close: '</a>',
      parent: -1,
      opaque: false,
      spaced: [true, true]
    })
    expect(code.source).toBe('Segundo con <img data-zt="0"> dentro')
    expect(code.inlines[0]).toMatchObject({ open: '<code>código</code>', opaque: true })
    expect(cell.source).toBe('Celda &amp; más')
    expect(quote.source).toBe('Cita<br data-zt="0">con salto')
  })

  it('skips pre blocks, no-translate blocks, images alone and whitespace between blocks', () => {
    const split = splitArticleHtml(ARTICLE)
    const literal = split.parts.filter((p): p is string => typeof p === 'string').join('')
    expect(literal).toContain('<pre>no se traduce\n  nunca</pre>')
    expect(literal).toContain('<p translate="no">Marca registrada</p>')
    expect(literal).toContain('<p><img src="/b.png"></p>')
    expect(literal).toContain('<td>42</td>')
    expect(split.units.some((u) => u.text.includes('nunca'))).toBe(false)
    expect(split.units.some((u) => u.text.includes('Marca'))).toBe(false)
  })

  it('keeps runs of inline siblings between block children as their own units', () => {
    const split = splitArticleHtml('<li>Tema principal<ul><li>Detalle</li></ul> y coda</li>')
    expect(split.units.map((u) => u.html)).toEqual(['Tema principal', 'Detalle', ' y coda'])
    expect(split.parts).toEqual(['<li>', 0, '<ul><li>', 1, '</li></ul>', 2, '</li>'])
  })

  it('treats a block inside an inline element as part of the run, like the runtime', () => {
    const split = splitArticleHtml('<div><a href="/c"><div>Tarjeta</div><span>Más</span></a></div>')
    expect(split.units).toHaveLength(1)
    expect(split.units[0].source).toBe(
      '<span data-zt="0"><span data-zt="1">Tarjeta</span><span data-zt="2">Más</span></span>'
    )
    expect(split.units[0].inlines.map((i) => i.parent)).toEqual([-1, 0, 0])
  })

  it('tolerates paragraphs and list items without end tags', () => {
    const split = splitArticleHtml('<div><p>Uno<p>Dos<ul><li>Tres<li>Cuatro</ul></div>')
    expect(split.units.map((u) => u.text)).toEqual(['Uno', 'Dos', 'Tres', 'Cuatro'])
  })

  it('leaves an unclosed inline at the block end to the browser and closes it for the engine', () => {
    const split = splitArticleHtml('<p>Texto <b>fuerte</p>')
    expect(split.units[0].html).toBe('Texto <b>fuerte')
    expect(split.units[0].source).toBe('Texto <span data-zt="0">fuerte</span>')
    expect(split.units[0].inlines[0].close).toBe('')
  })

  it('samples the units in order up to the cap', () => {
    const split = splitArticleHtml(ARTICLE)
    expect(articleSampleText(split, 30)).toBe('Este es un párrafo con un enla')
    expect(articleSampleText(split, 10_000)).toContain('Cita con salto')
  })
})

describe('rebuildUnitHtml', () => {
  const unit = (html: string): ReturnType<typeof splitArticleHtml>['units'][number] =>
    splitArticleHtml(`<p>${html}</p>`).units[0]

  it('puts the article tags back around the translated text', () => {
    const u = unit('Este es un párrafo con <a href="/x" class="c">un enlace</a> dentro.')
    expect(
      rebuildUnitHtml(u, 'This is a paragraph with <span data-zt="0">a link</span> inside.')
    ).toBe('This is a paragraph with <a href="/x" class="c">a link</a> inside.')
  })

  it('re-escapes the text and drops markup of the answer', () => {
    const u = unit('Tom &amp; Jerry')
    expect(rebuildUnitHtml(u, 'Tom &amp; Jerry <b>said</b> &lt;hi&gt;')).toBe(
      'Tom &amp; Jerry said &lt;hi&gt;'
    )
    expect(rebuildUnitHtml(u, 'x <script>alert(1)</script> y')).toBe('x alert(1) y')
  })

  it('puts opaque elements back whole and restores the space the engine dropped', () => {
    const u = unit('Abre la app <code>eBiblio</code> ahora')
    expect(u.source).toBe('Abre la app <img data-zt="0"> ahora')
    expect(rebuildUnitHtml(u, 'Open the<img data-zt="0">app now')).toBe(
      'Open the <code>eBiblio</code> app now'
    )
  })

  it('returns an inline element the answer lost to where it stood', () => {
    const u = unit('Ver <a href="/x">más</a> aquí <img src="/i.png">')
    expect(rebuildUnitHtml(u, 'See more here')).toBe(
      'See more here<a href="/x"></a><img src="/i.png">'
    )
    const nested = unit('<a href="/x">Ver <em>más</em></a>')
    expect(rebuildUnitHtml(nested, '<span data-zt="0">See more</span>')).toBe(
      '<a href="/x">See more<em></em></a>'
    )
  })

  it('keeps nesting as the answer has it and ignores a marker used twice', () => {
    const u = unit('<a href="/x">uno <em>dos</em></a> tres')
    expect(
      rebuildUnitHtml(
        u,
        '<span data-zt="0">one <span data-zt="1">two</span></span> three <span data-zt="1">again</span>'
      )
    ).toBe('<a href="/x">one <em>two</em></a> three again')
  })

  it('keeps line breaks as tokens without adding spaces around them', () => {
    const u = unit('Cita<br>con salto')
    expect(rebuildUnitHtml(u, 'Quote<br data-zt="0">with a break')).toBe('Quote<br>with a break')
  })
})

describe('renderArticleHtml', () => {
  it('wraps every unit in a marker span around what it shows', () => {
    const split = splitArticleHtml('<div><p>Hola</p><hr><p>Adiós <b>ya</b></p></div>')
    const original = renderArticleHtml(split, (id) => split.units[id].html)
    expect(original).toBe(
      '<div><p><span data-zu="0">Hola</span></p><hr><p><span data-zu="1">Adiós <b>ya</b></span></p></div>'
    )
    const translated = renderArticleHtml(split, (id) => (id === 0 ? 'Hello' : split.units[id].html))
    expect(translated).toContain('<span data-zu="0">Hello</span>')
    expect(translated).toContain('<span data-zu="1">Adiós <b>ya</b></span>')
  })
})
