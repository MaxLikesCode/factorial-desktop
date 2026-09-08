import { useState } from 'react'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TimesheetBlock } from '@shared/timesheet'
import { Timeline } from '@renderer/app/Timeline'

/**
 * The strip driven by a real pointer, because the bug this covers was not in
 * the arithmetic: a five-minute block is five pixels wide, both fixed-width
 * grips overflowed it, and the one that ended up under the pointer was the one
 * for the other end. Grabbing its right edge dragged it left. Such a block now
 * keeps its true width and is resized from the empty strip beside it.
 *
 * jsdom lays nothing out, so the two things a drag reads — the strip's width
 * and the block's box — are answered from the inline percentages the component
 * itself wrote. The strip is 840 px for the 14 hours it shows, so a minute is
 * a pixel and the numbers below can be read as both.
 */
const TRACK_WIDTH = 840

function box(left: number, width: number): DOMRect {
  return { x: left, y: 0, left, right: left + width, width, top: 0, bottom: 44, height: 44, toJSON: () => ({}) } as DOMRect
}

function layOut(): () => void {
  const rect = Element.prototype.getBoundingClientRect
  const capture = Element.prototype.setPointerCapture
  const release = Element.prototype.releasePointerCapture
  const held = Element.prototype.hasPointerCapture
  Element.prototype.getBoundingClientRect = function (this: Element): DOMRect {
    const el = this as HTMLElement
    if (el.classList.contains('tl-track')) return box(0, TRACK_WIDTH)
    if (el.classList.contains('tl-block')) {
      return box((parseFloat(el.style.left) / 100) * TRACK_WIDTH, (parseFloat(el.style.width) / 100) * TRACK_WIDTH)
    }
    return box(0, 0)
  }
  Element.prototype.setPointerCapture = (): void => {}
  Element.prototype.releasePointerCapture = (): void => {}
  Element.prototype.hasPointerCapture = (): boolean => true
  return () => {
    Element.prototype.getBoundingClientRect = rect
    Element.prototype.setPointerCapture = capture
    Element.prototype.releasePointerCapture = release
    Element.prototype.hasPointerCapture = held
  }
}

/** 11:00–11:05, the block left behind by typing 11 into a start. */
function short(): TimesheetBlock {
  return { id: '1', kind: 'work', start: 660, end: 665, breakConfigurationId: null, breakName: null, locationType: 'office', workplaceId: null }
}

/**
 * Where a minute of the day sits on the strip. The strip shows 06:00–20:00 for
 * any ordinary day, which is 840 minutes across 840 px: one minute, one pixel.
 */
function x(minute: number): number {
  return minute - 6 * 60
}

function draw(blocks: TimesheetBlock[]): { onChange: ReturnType<typeof vi.fn>; block: HTMLElement } {
  const onChange = vi.fn()
  render(<Timeline blocks={blocks} now={null} onChange={onChange} nowLabel="jetzt" />)
  const block = document.querySelector('[data-slot="timeline"] [data-slot="block"]') as HTMLElement
  return { onChange, block }
}

/** The strip beside a block that resizes it, one side or the other. */
function reach(side: 'start' | 'end'): HTMLElement | null {
  return document.querySelector(`[data-slot="reach"][data-reach="${side}"]`)
}

/** What the last change made of the first block. */
function changed(onChange: ReturnType<typeof vi.fn>): TimesheetBlock {
  return onChange.mock.calls.at(-1)?.[0]?.[0] as TimesheetBlock
}

function strip(): HTMLElement {
  return document.querySelector('[data-slot="timeline"]') as HTMLElement
}

function shown(): string | null {
  return document.querySelector('[data-slot="block"]')?.getAttribute('title') ?? null
}

/**
 * The strip as the editor holds it: what a drag changes comes straight back as
 * the blocks it draws. Needed wherever the drag has to survive the redraw it
 * causes itself.
 */
function Editable({ initial }: { initial: TimesheetBlock[] }): React.JSX.Element {
  const [blocks, setBlocks] = useState(initial)
  return <Timeline blocks={blocks} now={null} onChange={setBlocks} nowLabel="jetzt" />
}

let restore: (() => void) | null = null
afterEach(() => {
  restore?.()
  restore = null
  cleanup()
  vi.clearAllMocks()
})

describe('dragging a block that is barely there', () => {
  it('is drawn as short as it really is, with a reach either side', () => {
    restore = layOut()
    const { block } = draw([short()])
    // Five minutes, five pixels — no minimum width dressing it up as longer.
    expect(block.getBoundingClientRect().width).toBeCloseTo(5, 5)
    expect(block.getAttribute('title')).toBe('11:00 – 11:05')
    expect(reach('start')?.style.width).toBe('12px')
    expect(reach('end')?.style.width).toBe('12px')
    // Nothing to grab inside it, so it shows no grips either.
    expect(block.querySelector('.tl-handle')).toBeNull()
  })

  it('grows to the right when the strip on its right is dragged right', () => {
    restore = layOut()
    const { onChange } = draw([short()])

    fireEvent.pointerDown(reach('end')!, { button: 0, clientX: x(665) + 3, pointerId: 1 })
    fireEvent.pointerMove(reach('end')!, { clientX: x(780), pointerId: 1 })

    expect(changed(onChange)).toMatchObject({ start: 660, end: 780 })
  })

  it('grows to the left when the strip on its left is dragged left', () => {
    restore = layOut()
    const { onChange } = draw([short()])

    fireEvent.pointerDown(reach('start')!, { button: 0, clientX: x(660) - 3, pointerId: 1 })
    fireEvent.pointerMove(reach('start')!, { clientX: x(600), pointerId: 1 })

    expect(changed(onChange)).toMatchObject({ start: 600, end: 665 })
  })

  it('moves the whole block when the block itself is taken', () => {
    restore = layOut()
    const { onChange, block } = draw([short()])
    const rect = block.getBoundingClientRect()

    fireEvent.pointerDown(block, { button: 0, clientX: rect.left + rect.width / 2, pointerId: 1 })
    fireEvent.pointerMove(block, { clientX: rect.left + rect.width / 2 + 60, pointerId: 1 })

    const moved = changed(onChange)
    expect(moved.end! - moved.start).toBe(5)
    expect(moved.start).toBeGreaterThan(660)
  })

  it('reaches into the gap only as far as the gap goes', () => {
    restore = layOut()
    // A break ending at 10:58, two minutes before the block starts.
    const before: TimesheetBlock = { ...short(), id: '0', kind: 'break', start: 600, end: 658 }
    draw([before, short()])
    expect(reach('start')).toBeNull()
    expect(reach('end')?.style.width).toBe('12px')
  })
})

describe('a drag that redraws what it started from', () => {
  it('carries on when the reach gives way to the block’s own grips', () => {
    restore = layOut()
    render(<Editable initial={[short()]} />)

    fireEvent.pointerDown(reach('end')!, { button: 0, clientX: x(665) + 3, pointerId: 1 })
    fireEvent.pointerMove(strip(), { clientX: x(700), pointerId: 1 })
    // Forty minutes is wide enough for ends of its own, so the reach the drag
    // began on is gone from the strip …
    expect(reach('end')).toBeNull()
    expect(shown()).toBe('11:00 – 11:40')

    // … and the drag has to carry on all the same. It used to stop dead here:
    // the capture went with the element that unmounted.
    fireEvent.pointerMove(strip(), { clientX: x(780), pointerId: 1 })
    expect(shown()).toBe('11:00 – 13:00')
  })

  it('lets go of the pointer when the button does', () => {
    restore = layOut()
    render(<Editable initial={[short()]} />)

    fireEvent.pointerDown(reach('end')!, { button: 0, clientX: x(665) + 3, pointerId: 1 })
    fireEvent.pointerMove(strip(), { clientX: x(780), pointerId: 1 })
    fireEvent.pointerUp(strip(), { pointerId: 1 })
    fireEvent.pointerMove(strip(), { clientX: x(900), pointerId: 1 })

    // A drag left live by a lost capture followed the pointer around with the
    // button up, and pressed again wherever it was let go.
    expect(shown()).toBe('11:00 – 13:00')
  })

  it('ends a drag whose capture is taken away', () => {
    restore = layOut()
    render(<Editable initial={[short()]} />)

    fireEvent.pointerDown(reach('end')!, { button: 0, clientX: x(665) + 3, pointerId: 1 })
    fireEvent.pointerMove(strip(), { clientX: x(780), pointerId: 1 })
    fireEvent.lostPointerCapture(strip(), { pointerId: 1 })
    fireEvent.pointerMove(strip(), { clientX: x(900), pointerId: 1 })

    expect(shown()).toBe('11:00 – 13:00')
  })
})

describe('dragging an ordinary block', () => {
  const work: TimesheetBlock = { id: '2', kind: 'work', start: 712, end: 772, breakConfigurationId: null, breakName: null, locationType: 'office', workplaceId: null }

  it('has no reach beside it: its own ends are wide enough', () => {
    restore = layOut()
    draw([work])
    expect(reach('start')).toBeNull()
    expect(reach('end')).toBeNull()
  })

  it('snaps to the five-minute marks of the day', () => {
    restore = layOut()
    const { onChange, block } = draw([work])
    fireEvent.pointerDown(block, { button: 0, clientX: block.getBoundingClientRect().right - 3, pointerId: 1 })
    // 12:57 under the pointer is 12:55 on the strip, not 12:57.
    fireEvent.pointerMove(block, { clientX: x(777), pointerId: 1 })
    expect(changed(onChange)).toMatchObject({ start: 712, end: 775 })
  })

  it('drags by the minute while Ctrl is held', () => {
    restore = layOut()
    const { onChange, block } = draw([work])
    fireEvent.pointerDown(block, { button: 0, clientX: block.getBoundingClientRect().right - 3, pointerId: 1 })
    fireEvent.pointerMove(block, { clientX: x(777), ctrlKey: true, pointerId: 1 })
    expect(changed(onChange)).toMatchObject({ start: 712, end: 777 })
  })

  it('leaves the running record alone', () => {
    restore = layOut()
    const running: TimesheetBlock = { ...work, end: null }
    const onChange = vi.fn()
    render(<Timeline blocks={[running]} now={826} onChange={onChange} nowLabel="jetzt" />)
    const block = document.querySelector('[data-slot="timeline"] [data-slot="block"]') as HTMLElement

    fireEvent.pointerDown(block, { button: 0, clientX: block.getBoundingClientRect().right - 3, pointerId: 1 })
    fireEvent.pointerMove(block, { clientX: x(900), pointerId: 1 })

    expect(onChange).not.toHaveBeenCalled()
  })
})
