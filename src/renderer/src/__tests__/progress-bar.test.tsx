import { act, cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { BarPart } from '@shared/day-timeline'
import { ProgressBar } from '@renderer/components/ProgressBar'

// Vitest runs without `globals`, so Testing Library cannot register its own
// `afterEach` — without this every render stacks up in the same document.
afterEach(cleanup)

/** The reported day: 4:30 worked, 33 minutes of break, 2:53 more, 37 to go. */
const DAY: BarPart[] = [
  { kind: 'work', percent: 52.63 },
  { kind: 'break', percent: 6.43 },
  { kind: 'work', percent: 33.72 },
  { kind: 'rest', percent: 7.21 },
]

/**
 * The bar fills itself in on the frame after mount, so its first frame is
 * deliberately empty. Every width assertion is about the settled bar.
 */
async function draw(parts: BarPart[], tone: 'idle' | 'active' | 'paused' = 'active') {
  const { container } = render(<ProgressBar parts={parts} tone={tone} />)
  await act(async () => {
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)))
  })
  return container
}

describe('ProgressBar', () => {
  it('draws the day in order, with every part at its own width', async () => {
    const container = await draw(DAY)
    const drawn = [...container.querySelectorAll<HTMLElement>('[data-slot^="bar-"]')]

    expect(drawn.map((el) => el.dataset.slot)).toEqual([
      'bar-work',
      'bar-break',
      'bar-work',
      'bar-rest',
    ])
    expect(drawn.map((el) => el.style.width)).toEqual([
      '52.63%',
      '6.43%',
      '33.72%',
      '7.21%',
    ])
  })

  /**
   * The reason the bar carries the day at all: on the old worked-against-goal
   * axis a break had no width, because it is exactly the time that axis does not
   * count. A day with a break looked identical to one without.
   */
  it('gives the break its own colour, in the app’s break colour', async () => {
    const container = await draw(DAY)
    const brk = container.querySelector('[data-slot="bar-break"]')
    expect(brk?.getAttribute('class')).toContain('bg-amber-500')
  })

  /**
   * Amber whether or not the break is still running. It is the app's colour for
   * a break everywhere else, and one that changed once the break was over would
   * be a second vocabulary for the same thing.
   */
  it('keeps breaks amber while the work parts follow the day', async () => {
    for (const [tone, expected] of [
      ['active', 'bg-emerald-500'],
      ['paused', 'bg-emerald-500'],
      ['idle', 'bg-muted-foreground/40'],
    ] as const) {
      const container = await draw(DAY, tone)
      expect(container.querySelector('[data-slot="bar-work"]')?.getAttribute('class')).toContain(
        expected,
      )
      expect(container.querySelector('[data-slot="bar-break"]')?.getAttribute('class')).toContain(
        'bg-amber-500',
      )
      cleanup()
    }
  })

  /**
   * Absent, not empty. An empty track claims "0 % of something", and the day
   * builder returns nothing exactly when there is no something — no goal, or no
   * records yet.
   */
  it('renders nothing at all when there is no day to draw', async () => {
    const container = await draw([])
    expect(container.querySelector('[data-slot^="bar-"]')).toBeNull()
    expect(container.firstChild).toBeNull()
  })
})
