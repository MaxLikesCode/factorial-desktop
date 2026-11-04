import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { TimesheetBlock } from '@shared/timesheet'
import { createHeldStore } from '../held-changes'

const block: TimesheetBlock = {
  id: '2',
  kind: 'work',
  start: 825,
  end: 1145,
  breakConfigurationId: null,
  breakName: null,
  locationType: 'work_from_home',
  workplaceId: null,
}

describe('createHeldStore', () => {
  let dir: string
  let filePath: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'held-'))
    filePath = join(dir, 'nested', 'held.json')
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('survives a restart, because the approval can take days', () => {
    const entry = createHeldStore({ filePath }).add(7, '2026-11-04', block)
    expect(createHeldStore({ filePath }).list(7)).toEqual([entry])
  })

  it('never hands one account the changes of another', () => {
    const store = createHeldStore({ filePath })
    store.add(7, '2026-11-04', block)
    expect(store.list(8)).toEqual([])
  })

  it('forgets what is removed, on disk too', () => {
    const store = createHeldStore({ filePath })
    const entry = store.add(7, '2026-11-04', block)
    store.remove([entry.id])
    expect(store.list(7)).toEqual([])
    expect(JSON.parse(readFileSync(filePath, 'utf8'))).toEqual([])
  })

  it('treats a corrupt file as nothing held', () => {
    const path = join(dir, 'held.json')
    writeFileSync(path, '{ not json', 'utf8')
    expect(createHeldStore({ filePath: path }).list(7)).toEqual([])
  })

  it('drops an entry that could not be sent as it stands', () => {
    const path = join(dir, 'held.json')
    const good = { id: 'a', employeeId: 7, date: '2026-11-04', block }
    writeFileSync(
      path,
      JSON.stringify([
        good,
        { ...good, id: 'bad-date', date: 'yesterday' },
        { ...good, id: 'open-end', block: { ...block, end: null } },
        { ...good, id: 'inside-out', block: { ...block, start: 900, end: 800 } },
        { ...good, id: 'no-kind', block: { ...block, kind: 'nap' } },
      ]),
      'utf8',
    )
    expect(createHeldStore({ filePath: path }).list(7).map((entry) => entry.id)).toEqual(['a'])
  })
})
