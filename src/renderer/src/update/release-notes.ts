/**
 * Makes GitHub's release notes safe to put on a page.
 *
 * The notes arrive as HTML from the releases feed — markdown that GitHub
 * rendered — and they are rendered here with `dangerouslySetInnerHTML`, which
 * is exactly as dangerous as the name says. This renderer has a preload with
 * a bridge into the main process, so a script that ran in it would not be
 * harmless. The feed is GitHub's and the release is ours, but "the source is
 * trusted" is the sentence every injection starts with.
 *
 * So: a whitelist. Tags not on it are unwrapped (their text is kept, they are
 * not), every attribute is dropped except a link's `href`, and an `href` is
 * kept only when it is `http(s)`. Links are then opened by the main process
 * through `shell.openExternal`, never navigated to in this window — see the
 * click handler in `UpdateApp.tsx`.
 */

const ALLOWED_TAGS = new Set([
  'h1',
  'h2',
  'h3',
  'h4',
  'p',
  'ul',
  'ol',
  'li',
  'strong',
  'b',
  'em',
  'i',
  'code',
  'pre',
  'a',
  'br',
  'blockquote',
  'del',
  'hr',
])

function isSafeHref(value: string): boolean {
  return /^https?:\/\//i.test(value.trim())
}

function clean(node: Node, into: Node, doc: Document): void {
  for (const child of Array.from(node.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE) {
      into.appendChild(doc.createTextNode(child.textContent ?? ''))
      continue
    }
    if (child.nodeType !== Node.ELEMENT_NODE) continue
    const element = child as Element
    const tag = element.tagName.toLowerCase()
    // The contents of these are never text worth keeping.
    if (tag === 'script' || tag === 'style' || tag === 'template') continue
    if (!ALLOWED_TAGS.has(tag)) {
      clean(element, into, doc)
      continue
    }
    const copy = doc.createElement(tag)
    if (tag === 'a') {
      const href = element.getAttribute('href')
      if (href !== null && isSafeHref(href)) copy.setAttribute('href', href)
    }
    clean(element, copy, doc)
    into.appendChild(copy)
  }
}

/** Returns HTML that contains nothing but the tags above and safe links. */
export function sanitiseReleaseNotes(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  const out = doc.createElement('div')
  clean(doc.body, out, doc)
  return out.innerHTML
}

/** True when the notes, once sanitised, say nothing at all. */
export function isBlank(html: string): boolean {
  return html.replace(/<[^>]*>/g, '').trim() === ''
}
