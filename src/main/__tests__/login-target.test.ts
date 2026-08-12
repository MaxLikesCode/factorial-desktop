import { describe, it, expect } from 'vitest'
import { indicatesSignedIn, LOGIN_URL } from '../login-target'

/**
 * This predicate is the only thing standing between the app and a request fired
 * into the middle of a sign-in challenge. Answering "yes" too eagerly is what
 * made Factorial reject every OTP and every TOTP as invalid.
 */
describe('indicatesSignedIn', () => {
  it('says no for the login host itself, on every step of the sign-in', () => {
    expect(indicatesSignedIn(LOGIN_URL)).toBe(false)
    expect(indicatesSignedIn('https://id.factorialhr.com/login')).toBe(false)
    expect(indicatesSignedIn('https://id.factorialhr.com/login/password')).toBe(false)
    expect(indicatesSignedIn('https://id.factorialhr.com/login/mfa')).toBe(false)
    expect(indicatesSignedIn('https://id.factorialhr.com/login/mfa?error=invalid_code')).toBe(false)
  })

  it('says yes once the window lands on the Factorial app', () => {
    expect(indicatesSignedIn('https://app.factorialhr.com/')).toBe(true)
    expect(indicatesSignedIn('https://app.factorialhr.com/dashboard')).toBe(true)
  })

  it('accepts the bare domain and other Factorial subdomains', () => {
    expect(indicatesSignedIn('https://factorialhr.com/')).toBe(true)
    expect(indicatesSignedIn('https://api.factorialhr.com/graphql')).toBe(true)
  })

  it('stays quiet for an SSO detour, which is still part of signing in', () => {
    expect(indicatesSignedIn('https://accounts.google.com/o/oauth2/auth')).toBe(false)
    expect(indicatesSignedIn('https://login.microsoftonline.com/common/oauth2/authorize')).toBe(false)
  })

  it('stays quiet for non-http URLs the window passes through', () => {
    expect(indicatesSignedIn('about:blank')).toBe(false)
    expect(indicatesSignedIn('data:text/html,hi')).toBe(false)
    expect(indicatesSignedIn('chrome-error://chromewebdata/')).toBe(false)
  })

  it('says no rather than throwing on a malformed URL', () => {
    expect(indicatesSignedIn('not a url at all')).toBe(false)
    expect(indicatesSignedIn('')).toBe(false)
  })

  it('is not fooled by a look-alike domain', () => {
    // Suffix matching must be on a dot boundary, or evilfactorialhr.com passes.
    expect(indicatesSignedIn('https://evilfactorialhr.com/dashboard')).toBe(false)
    expect(indicatesSignedIn('https://factorialhr.com.attacker.test/')).toBe(false)
  })
})
