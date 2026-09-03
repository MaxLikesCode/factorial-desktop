import { describe, expect, it } from 'vitest'
import { asUpdateWindowAction, formatBytes, updateWindowSizeFor } from '../update-window'

describe('formatBytes', () => {
  it('says megabytes with one decimal, the way a download dialog does', () => {
    expect(formatBytes(31_900_000)).toBe('31.9 MB')
    expect(formatBytes(59_000_000)).toBe('59.0 MB')
    expect(formatBytes(1_000_000)).toBe('1.0 MB')
  })

  it('says kilobytes below a megabyte, so a small number never reads as nothing', () => {
    expect(formatBytes(512_000)).toBe('512 KB')
    expect(formatBytes(0)).toBe('0 KB')
  })

  it('does not throw on garbage', () => {
    expect(formatBytes(-5)).toBe('0 KB')
    expect(formatBytes(Number.NaN)).toBe('0 KB')
  })
})

describe('updateWindowSizeFor', () => {
  it('gives the offer room for its notes and the rest a small window', () => {
    const offer = updateWindowSizeFor('available')
    const progress = updateWindowSizeFor('downloading')
    expect(offer.height).toBeGreaterThan(progress.height)
    expect(updateWindowSizeFor('ready')).toEqual(progress)
    expect(updateWindowSizeFor('failed')).toEqual(progress)
    expect(updateWindowSizeFor('upToDate').height).toBeGreaterThan(progress.height)
  })
})

describe('asUpdateWindowAction', () => {
  it('accepts the buttons', () => {
    expect(asUpdateWindowAction({ kind: 'skip' })).toEqual({ kind: 'skip' })
    expect(asUpdateWindowAction({ kind: 'restart' })).toEqual({ kind: 'restart' })
    expect(asUpdateWindowAction({ kind: 'autoInstall', value: true })).toEqual({
      kind: 'autoInstall',
      value: true,
    })
  })

  it('refuses anything else, including a checkbox without a value', () => {
    expect(asUpdateWindowAction(null)).toBeNull()
    expect(asUpdateWindowAction('install')).toBeNull()
    expect(asUpdateWindowAction({ kind: 'format' })).toBeNull()
    expect(asUpdateWindowAction({ kind: 'autoInstall' })).toBeNull()
    expect(asUpdateWindowAction({ kind: 'autoInstall', value: 'yes' })).toBeNull()
  })
})
