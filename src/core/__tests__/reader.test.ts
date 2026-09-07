import { describe, expect, it } from 'vitest'
import { sanitizeArticleHtml } from '../reader'

describe('sanitizeArticleHtml', () => {
  it('strips scripts, frames, forms and inline handlers', () => {
    const html =
      '<p onclick="x()">Hi</p><script>alert(1)</script><iframe src="https://evil"></iframe>' +
      '<form action="/x"><input></form><a href="javascript:alert(1)">l</a><img src="data:text/html,x">'
    const out = sanitizeArticleHtml(html)
    expect(out).not.toContain('<script')
    expect(out).not.toContain('<iframe')
    expect(out).not.toContain('<form')
    expect(out).not.toContain('onclick')
    expect(out).not.toContain('javascript:')
    expect(out).not.toContain('data:text/html')
    expect(out).toContain('<p>Hi</p>')
  })

  it('keeps ordinary article markup', () => {
    const html =
      '<h2>Title</h2><p>Text with <a href="https://ok.test/">link</a> and <img src="https://ok.test/i.png"></p>'
    expect(sanitizeArticleHtml(html)).toBe(html)
  })
})
