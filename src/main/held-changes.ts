/**
 * Changes to the timesheet that Factorial would refuse today, kept until it
 * would not (`HeldChange` in `src/shared/timesheet.ts` says why they exist).
 *
 * On disk, because the approval they wait for can take days and the app gets
 * restarted in between: losing one would silently drop half of what somebody
 * asked for, with the other half already in front of their manager.
 *
 * Like `settings.ts`: no Electron import, so it is tested against a real temp
 * directory, and a missing or corrupt file means "nothing held" rather than an
 * app that will not start.
 *
 * Every entry names its employee. Somebody signing in to another account must
 * not have this one's changes sent as theirs.
 */

import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { MINUTES_PER_DAY, parseIsoDate, type TimesheetBlock } from '@shared/timesheet'

export interface HeldEntry {
  id: string
  employeeId: number
  date: string
  block: TimesheetBlock
}

export interface HeldStore {
  list(employeeId: number): HeldEntry[]
  add(employeeId: number, date: string, block: TimesheetBlock): HeldEntry
  remove(ids: readonly string[]): void
}

function isMinute(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= MINUTES_PER_DAY
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string'
}

/**
 * Whether what came off the disk can be sent as it stands. These numbers become
 * a real request, so an entry that does not check out is dropped, not repaired.
 */
function isEntry(value: unknown): value is HeldEntry {
  if (typeof value !== 'object' || value === null) return false
  const entry = value as Record<string, unknown>
  if (typeof entry.id !== 'string' || entry.id === '') return false
  if (typeof entry.employeeId !== 'number' || !Number.isInteger(entry.employeeId)) return false
  if (typeof entry.date !== 'string' || parseIsoDate(entry.date) === null) return false
  if (typeof entry.block !== 'object' || entry.block === null) return false
  const block = entry.block as Record<string, unknown>
  return (
    isNullableString(block.id) &&
    (block.kind === 'work' || block.kind === 'break') &&
    isMinute(block.start) &&
    isMinute(block.end) &&
    block.start < block.end &&
    isNullableString(block.breakConfigurationId) &&
    isNullableString(block.breakName) &&
    isNullableString(block.locationType) &&
    (block.workplaceId === null || typeof block.workplaceId === 'number')
  )
}

function read(filePath: string): HeldEntry[] {
  try {
    const parsed: unknown = JSON.parse(readFileSync(filePath, 'utf8'))
    return Array.isArray(parsed) ? parsed.filter(isEntry) : []
  } catch {
    return []
  }
}

export function createHeldStore({ filePath }: { filePath: string }): HeldStore {
  let entries = read(filePath)

  function persist(): void {
    mkdirSync(dirname(filePath), { recursive: true })
    const temp = `${filePath}.tmp`
    writeFileSync(temp, JSON.stringify(entries, null, 2), 'utf8')
    renameSync(temp, filePath)
  }

  return {
    list: (employeeId) => entries.filter((entry) => entry.employeeId === employeeId),
    add(employeeId, date, block) {
      const entry: HeldEntry = { id: randomUUID(), employeeId, date, block }
      entries = [...entries, entry]
      persist()
      return entry
    },
    remove(ids) {
      const next = entries.filter((entry) => !ids.includes(entry.id))
      if (next.length === entries.length) return
      entries = next
      persist()
    },
  }
}
