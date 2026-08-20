import { act, cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { ProgressBar } from '@renderer/components/ProgressBar'

// Vitest runs without `globals`, so Testing Library cannot register its own
// `afterEach` — without this every render stacks up in the same document and
// the next query finds several bars instead of one.
afterEach(cleanup)

/**
 * The bar fills itself in on mount, so its very first frame is deliberately
 * empty — that is what gives the CSS transition something to animate from.
 * Every geometry assertion here is about the *settled* value, so each render is
 * carried one real animation frame forward first.
 */
async function fill(progress: number): Promise<string> {
  const { container } = render(<ProgressBar progress={progress} tone="idle" />)
  await act(async () => {
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)))
  })
  const bar = container.querySelector<HTMLElement>('[data-slot="progress-bar-fill"]')
  if (!bar) throw new Error('fill not rendered')
  return bar.style.width
}

describe('ProgressBar', () => {
  it('draws nothing at zero and the whole track at one', async () => {
    expect(await fill(0)).toBe('0%')
    expect(await fill(1)).toBe('100%')
  })

  it('draws half the track at one half', async () => {
    expect(await fill(0.5)).toBe('50%')
  })

  it('clamps overtime instead of overflowing the track', async () => {
    expect(await fill(2.4)).toBe('100%')
  })

  it('clamps a negative progress rather than filling backwards', async () => {
    expect(await fill(-1)).toBe('0%')
  })

  /**
   * A zero day target makes `worked / target` exactly NaN (`0/0`). React would
   * write `width: NaN%`, the browser drops the invalid declaration, and a block
   * child with no width falls back to `auto` — the *full* track. That failure
   * mode claims the day is complete, so it is asserted rather than assumed.
   */
  it('treats a non-finite progress as empty, never as a full day', async () => {
    expect(await fill(Number.NaN)).toBe('0%')
    expect(await fill(Number.POSITIVE_INFINITY)).toBe('100%')
  })

  it('colours the fill by tone', () => {
    for (const [tone, expected] of [
      ['active', 'bg-emerald-500'],
      ['paused', 'bg-amber-500'],
      ['idle', 'bg-muted-foreground/40'],
    ] as const) {
      const { container } = render(<ProgressBar progress={0.3} tone={tone} />)
      const bar = container.querySelector('[data-slot="progress-bar-fill"]')
      expect(bar?.getAttribute('class')).toContain(expected)
    }
  })
})
