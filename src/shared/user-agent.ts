/**
 * Reduces Electron's User-Agent to the plain Chrome one.
 *
 * Electron announces itself twice. The obvious one is the engine token:
 *
 *   ...(KHTML, like Gecko) Chrome/150.0.7871.224 Electron/43.4.0 Safari/537.36
 *
 * The second only appears in a real app, which is how it survived a first fix:
 * Electron also inserts the application's own name and version, taken from
 * `package.json`, *before* the Chrome token:
 *
 *   ...(KHTML, like Gecko) factorial-desktop-2/0.1.0 Chrome/150.0.7871.224 Safari/537.36
 *
 * Both are foreign to a browser, and Factorial's sign-in runs behind Cloudflare
 * bot management — the login host serves `/cdn-cgi/rum` and an obfuscated
 * challenge path alongside the form.
 *
 * So this rebuilds the string from the two parts that are true of this client
 * anyway — the platform and the Chromium version it actually runs — rather than
 * subtracting tokens one at a time and hoping none is left. Nothing is claimed
 * that is not the case: the Chrome version is genuine, the platform is genuine.
 * Only the build flavour and the product name are dropped.
 */

/**
 * `Mozilla/5.0 (<platform>) AppleWebKit/537.36 (KHTML, like Gecko) ... Chrome/<version> ...`
 * Everything between the Gecko marker and the Chrome token is a product token.
 */
const CHROME_SHAPE =
  /^Mozilla\/5\.0 \(([^)]*)\) AppleWebKit\/537\.36 \(KHTML, like Gecko\).*?\bChrome\/(\S+)/

/** Fallback removals, for a string that does not match the expected shape. */
const FOREIGN_TOKENS = /\s(?:Electron)\/\S+/g

export function toBrowserUserAgent(userAgent: string): string {
  const match = CHROME_SHAPE.exec(userAgent)
  if (!match) {
    // Better a partial cleanup than none: still drop the Electron token.
    return userAgent.replace(FOREIGN_TOKENS, '')
  }
  const [, platform, chromeVersion] = match
  return `Mozilla/5.0 (${platform}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion} Safari/537.36`
}
