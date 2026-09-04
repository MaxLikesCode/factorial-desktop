/**
 * The timesheet as the app window edits it: days made of blocks.
 *
 * Factorial stores a working day as a list of shift records, and a break is a
 * record like any other — starting one closes the work record and opens a
 * break record (DESIGN.md, "Zustandsmodell"). The editor shows exactly that
 * list, one block per record, with a start and an end in minutes of the day.
 * Nothing is merged or invented: what the user drags is what gets written.
 *
 * Minutes of the day rather than instants, because that is what the editor
 * draws and what the user types. The main process turns them back into local
 * instants with an offset at the moment of saving (`timesheet.ts` there), the
 * same way `now` is built for a clock-in.
 *
 * Plain data throughout: this crosses IPC.
 */

export const MINUTES_PER_DAY = 24 * 60

export type BlockKind = 'work' | 'break'

export interface TimesheetBlock {
  /** Factorial's shift id, or null for a block the editor added and has not saved. */
  id: string | null
  kind: BlockKind
  /** Minutes since midnight of the day, 0 … 1440. */
  start: number
  /**
   * Null for the record that is still running: it has no clock-out yet, and
   * the editor draws it up to now and does not let its end be dragged.
   */
  end: number | null
  /** The break type, for `kind: 'break'`. */
  breakConfigurationId: string | null
  breakName: string | null
  locationType: string | null
}

export interface TimesheetDay {
  /** `YYYY-MM-DD`, local. */
  date: string
  blocks: TimesheetBlock[]
  /** The day's target, or null when there is none (day off, absence, unknown). */
  expectedMinutes: number | null
}

export interface TimesheetMonth {
  year: number
  /** 1 … 12. */
  month: number
  days: TimesheetDay[]
}

/** What the editor asks the main process to make true for one day. */
export interface DayEdit {
  date: string
  blocks: TimesheetBlock[]
}

/** How a saved day differs from the stored one, as the three mutations. */
export interface DayChanges {
  create: TimesheetBlock[]
  update: TimesheetBlock[]
  delete: string[]
}

/** Minutes of work in a list of blocks, the running one counted up to `now`. */
export function workedMinutes(blocks: readonly TimesheetBlock[], now: number | null = null): number {
  return blocks.reduce((sum, block) => {
    if (block.kind !== 'work') return sum
    const end = block.end ?? now
    if (end === null) return sum
    return sum + Math.max(0, end - block.start)
  }, 0)
}

export function breakMinutes(blocks: readonly TimesheetBlock[], now: number | null = null): number {
  return blocks.reduce((sum, block) => {
    if (block.kind !== 'break') return sum
    const end = block.end ?? now
    if (end === null) return sum
    return sum + Math.max(0, end - block.start)
  }, 0)
}

/** `08:30` from 510. Clamped and rounded so a dragged value never renders as `8:60`. */
export function formatMinuteOfDay(minute: number): string {
  const clamped = Math.min(MINUTES_PER_DAY, Math.max(0, Math.round(minute)))
  const h = Math.floor(clamped / 60)
  const m = clamped % 60
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

/**
 * `8:30`, `08:30`, `830`, `8.30` and `8` all mean 510. Anything else is null —
 * a field the user is mid-way through typing must not move a block.
 */
export function parseTimeOfDay(text: string): number | null {
  const trimmed = text.trim()
  const match = /^(\d{1,2})(?:[:.]?(\d{2}))?$/.exec(trimmed)
  if (!match) return null
  const h = Number(match[1])
  const m = match[2] === undefined ? 0 : Number(match[2])
  if (h > 24 || m > 59) return null
  const total = h * 60 + m
  return total > MINUTES_PER_DAY ? null : total
}

/** `7:52 h` from 472. The sum the user is steering towards. */
export function formatHours(minutes: number): string {
  const total = Math.max(0, Math.round(minutes))
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')} h`
}

/**
 * Puts the blocks in order and keeps them from overlapping: each block is
 * clamped between its neighbours, and a block shorter than a minute is
 * dropped. Called after every edit so what the editor shows is always a day
 * Factorial would accept.
 */
export function normaliseBlocks(blocks: readonly TimesheetBlock[]): TimesheetBlock[] {
  const sorted = [...blocks].sort((a, b) => a.start - b.start)
  const out: TimesheetBlock[] = []
  for (const block of sorted) {
    const previous = out[out.length - 1]
    const floor = previous === undefined ? 0 : (previous.end ?? previous.start)
    const start = Math.min(MINUTES_PER_DAY, Math.max(floor, block.start))
    const end = block.end === null ? null : Math.min(MINUTES_PER_DAY, Math.max(start, block.end))
    if (end !== null && end - start < 1) continue
    out.push({ ...block, start, end })
  }
  return out
}

/**
 * The three mutations that turn `before` into `after`, by shift id.
 *
 * A block whose kind changed is deleted and created rather than updated:
 * `updateAttendanceShift` does not take `workable`, so a work record cannot
 * be turned into a break in place. The running block is never touched — it
 * has no end to write, and ending it is what "clock out" is for.
 */
export function diffDay(before: readonly TimesheetBlock[], after: readonly TimesheetBlock[]): DayChanges {
  const changes: DayChanges = { create: [], update: [], delete: [] }
  const seen = new Set<string>()

  for (const block of after) {
    if (block.end === null) {
      if (block.id !== null) seen.add(block.id)
      continue
    }
    if (block.id === null) {
      changes.create.push(block)
      continue
    }
    seen.add(block.id)
    const original = before.find((b) => b.id === block.id)
    if (original === undefined) {
      changes.create.push({ ...block, id: null })
      continue
    }
    if (original.kind !== block.kind || original.breakConfigurationId !== block.breakConfigurationId) {
      changes.delete.push(block.id)
      changes.create.push({ ...block, id: null })
      continue
    }
    if (original.start !== block.start || original.end !== block.end) {
      changes.update.push(block)
    }
  }

  for (const block of before) {
    if (block.id !== null && block.end !== null && !seen.has(block.id)) {
      changes.delete.push(block.id)
    }
  }
  return changes
}

export function hasChanges(changes: DayChanges): boolean {
  return changes.create.length + changes.update.length + changes.delete.length > 0
}

/** `2026-09-04` → `{ year: 2026, month: 9, day: 4 }`, or null. */
export function parseIsoDate(date: string): { year: number; month: number; day: number } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date)
  if (!match) return null
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  if (month < 1 || month > 12 || day < 1 || day > 31) return null
  return { year, month, day }
}

/** The days of a month as `YYYY-MM-DD`, first to last. */
export function daysOfMonth(year: number, month: number): string[] {
  const count = new Date(year, month, 0).getDate()
  const prefix = `${year}-${String(month).padStart(2, '0')}-`
  return Array.from({ length: count }, (_, i) => `${prefix}${String(i + 1).padStart(2, '0')}`)
}

/** Minutes since local midnight of `d`. */
export function minuteOfDay(d: Date): number {
  return d.getHours() * 60 + d.getMinutes()
}
