/**
 * Electron announces itself in the User-Agent:
 *
 *   ...AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.7871.224 Electron/43.4.0 Safari/537.36
 *
 * That token is the only thing separating this string from a plain Chrome on the
 * same machine. Factorial's sign-in rejected every emailed OTP and every MFA
 * code with "invalid code" — for both kinds at once, which means the codes were
 * never the problem and the verification request was being refused before the
 * code was even considered.
 *
 * Removing the token leaves the string Chromium built for its own engine, which
 * is what this window in fact is: a first-party desktop client signing a user
 * into their own account. Nothing is impersonated that is not already true — the
 * Chrome version is real, the platform is real. Only the build flavour is
 * dropped.
 */

/** Matches ` Electron/<version>` anywhere in the string. */
const ELECTRON_TOKEN = /\sElectron\/\S+/g

export function stripElectronToken(userAgent: string): string {
  return userAgent.replace(ELECTRON_TOKEN, '')
}
