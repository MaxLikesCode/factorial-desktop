import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { ProgressRing, RING_CIRCUMFERENCE } from '@renderer/components/ProgressRing'

// Vitest runs without `globals`, so Testing Library cannot register its own
// `afterEach` — without this every render stacks up in the same document and
// the next `getBy*` fails with "found multiple elements".
afterEach(cleanup)

function arcOffset(progress: number): number {
  const { container } = render(<ProgressRing progress={progress} label="0:00:00" tone="idle" />)
  const arc = container.querySelector('[data-slot="progress-ring-arc"]')
  if (!arc) throw new Error('arc not rendered')
  return Number(arc.getAttribute('stroke-dashoffset'))
}

describe('ProgressRing', () => {
  it('draws nothing at zero and a full circle at one', () => {
    expect(arcOffset(0)).toBeCloseTo(RING_CIRCUMFERENCE, 5)
    expect(arcOffset(1)).toBeCloseTo(0, 5)
  })

  it('draws half a circle at one half', () => {
    expect(arcOffset(0.5)).toBeCloseTo(RING_CIRCUMFERENCE / 2, 5)
  })

  it('clamps overtime instead of overdrawing the ring', () => {
    expect(arcOffset(2.4)).toBeCloseTo(0, 5)
  })

  it('clamps a negative progress rather than drawing backwards', () => {
    expect(arcOffset(-1)).toBeCloseTo(RING_CIRCUMFERENCE, 5)
  })

  it('treats a non-finite progress as empty — a NaN dash offset erases the ring', () => {
    expect(arcOffset(Number.NaN)).toBeCloseTo(RING_CIRCUMFERENCE, 5)
    expect(arcOffset(Number.POSITIVE_INFINITY)).toBeCloseTo(0, 5)
  })

  it('shows the label it is given and nothing it invented', () => {
    const { getByText } = render(<ProgressRing progress={0.3} label="2:05:00" tone="active" />)
    expect(getByText('2:05:00')).toBeTruthy()
  })

  it('colours the arc by tone', () => {
    for (const [tone, expected] of [
      ['active', 'stroke-emerald-500'],
      ['paused', 'stroke-amber-500'],
    ] as const) {
      const { container } = render(<ProgressRing progress={0.3} label="x" tone={tone} />)
      const arc = container.querySelector('[data-slot="progress-ring-arc"]')
      expect(arc?.getAttribute('class')).toContain(expected)
    }
  })
})
