import { describe, expect, it } from 'vitest'
import { isBlank, sanitiseReleaseNotes } from '@renderer/update/release-notes'

describe('sanitiseReleaseNotes', () => {
  it('keeps the shape GitHub renders release notes in', () => {
    const html =
      '<h2>Fixes</h2><ul><li>Stops the widget <strong>sticking</strong> to the cursor</li></ul><p>See <a href="https://github.com/x/y/compare/v1...v2">the diff</a>.</p>'
    expect(sanitiseReleaseNotes(html)).toBe(html)
  })

  it('drops scripts, styles and event handlers, and unwraps unknown tags', () => {
    const html =
      '<script>alert(1)</script><style>p{}</style><div onclick="x()"><p onmouseover="y()">Hello <span class="c">there</span></p></div>'
    expect(sanitiseReleaseNotes(html)).toBe('<p>Hello there</p>')
  })

  it('keeps only http(s) links, and nothing else on a link', () => {
    expect(
      sanitiseReleaseNotes(
        '<a href="javascript:alert(1)" target="_blank">a</a> <a href="file:///etc/passwd">b</a> <a href="HTTPS://example.com" rel="x">c</a>',
      ),
    ).toBe('<a>a</a> <a>b</a> <a href="HTTPS://example.com">c</a>')
  })

  it('keeps images out — they would be fetched from wherever the notes say', () => {
    expect(sanitiseReleaseNotes('<p>x <img src="https://evil/track.gif"> y</p>')).toBe(
      '<p>x  y</p>',
    )
  })
})

describe('isBlank', () => {
  it('sees through empty markup', () => {
    expect(isBlank('<p></p><ul></ul>')).toBe(true)
    expect(isBlank('  \n ')).toBe(true)
    expect(isBlank('<p>x</p>')).toBe(false)
  })
})
