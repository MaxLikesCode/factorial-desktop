import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * The Windows handoff, checked as data rather than by eye.
 *
 * `docs/WINDOWS.md` §2 claims to be the explained version of the recursive grep
 * for the platform marker over `src/` and `electron-builder.yml` that the
 * document quotes verbatim (`GREP_COMMAND` below). That claim is the whole
 * value of the document — an agent on a Windows machine has nothing else to go
 * on — and it rots the moment somebody adds a branch or a line moves. So it is
 * asserted here in both directions: no marker without a row, no row without a
 * marker.
 *
 * Like `packaging.test.ts`, this file has nothing to do with `src/shared`; that
 * is simply the only place both the test runner and `tsconfig.node.json` look.
 *
 * What this cannot prove: that the *prose* in the fourth column is correct.
 * Nobody has run any of it on Windows. See §4 of the document.
 */

// Vitest runs with the config root as cwd, and that root is this repository.
const ROOT = process.cwd()

// Assembled at runtime on purpose. If this file contained the marker verbatim,
// the command the document tells the next agent to run would return its own
// test fixtures alongside the production code, and the counts would not match.
const MARKER = `PLATFORM${':'}`

/** The command §2 tells the next agent to run. Assembled for the same reason. */
const GREP_COMMAND = `grep -rn "${MARKER}" src/ electron-builder.yml`

/** `path:line` for every production occurrence of the marker. */
function collectMarkers(): string[] {
  const found: string[] = []

  const scanFile = (absolute: string): void => {
    // `relative` yields backslashes on Windows and the document quotes POSIX
    // paths, so without this every row reads as stale there. (No marker comment
    // on this line by design: test files carry none, and this file must not
    // match its own scan.)
    const rel = relative(ROOT, absolute).split(sep).join('/')
    const lines = readFileSync(absolute, 'utf8').split('\n')
    lines.forEach((line, index) => {
      if (line.includes(MARKER)) found.push(`${rel}:${index + 1}`)
    })
  }

  const scanDir = (absolute: string): void => {
    for (const entry of readdirSync(absolute, { withFileTypes: true })) {
      // Test files carry no markers by design — the list documents production
      // code. Skipping the directory keeps that rule enforced rather than
      // merely stated.
      if (entry.isDirectory()) {
        if (entry.name !== '__tests__' && entry.name !== 'node_modules') {
          scanDir(join(absolute, entry.name))
        }
        continue
      }
      scanFile(join(absolute, entry.name))
    }
  }

  scanDir(join(ROOT, 'src'))
  scanFile(join(ROOT, 'electron-builder.yml'))
  return found.sort()
}

const windowsDoc = readFileSync(join(ROOT, 'docs', 'WINDOWS.md'), 'utf8')

type Row = { ref: string; cells: string[] }

/**
 * Rows of the platform table, recognised by their first cell being a
 * backticked `path:line`. No other table in the document has that shape — the
 * entry-point table lists paths without line numbers, and the command table
 * lists npm scripts.
 */
function platformRows(markdown: string): Row[] {
  const rows: Row[] = []
  for (const line of markdown.split('\n')) {
    if (!line.startsWith('|')) continue
    const cells = line
      .split('|')
      .slice(1, -1)
      .map((cell) => cell.trim())
    const first = cells[0]
    if (first === undefined) continue
    const ref = /^`([\w./-]+\.\w+:\d+)`$/.exec(first)
    const captured = ref?.[1]
    if (captured === undefined) continue
    rows.push({ ref: captured, cells })
  }
  return rows
}

describe('docs/WINDOWS.md covers every platform-dependent place', () => {
  const markers = collectMarkers()
  const rows = platformRows(windowsDoc)

  it('finds markers at all (guards against a broken scan)', () => {
    expect(markers.length).toBeGreaterThan(10)
  })

  it('documents every marker in the source tree', () => {
    const documented = new Set(rows.map((row) => row.ref))
    const missing = markers.filter((ref) => !documented.has(ref))
    expect(missing).toEqual([])
  })

  it('has no row pointing at a line that no longer carries a marker', () => {
    const present = new Set(markers)
    const stale = rows.map((row) => row.ref).filter((ref) => !present.has(ref))
    expect(stale).toEqual([])
  })

  it('lists each place exactly once', () => {
    const refs = rows.map((row) => row.ref)
    expect(refs.length).toBe(new Set(refs).size)
  })

  it('answers all four questions for every place', () => {
    // file:line | what | why | what to check on Windows. An empty cell here is
    // the failure mode the document exists to prevent.
    for (const row of rows) {
      expect(row.cells.length, `row ${row.ref}`).toBe(4)
      for (const cell of row.cells) {
        expect(cell.length, `row ${row.ref}`).toBeGreaterThan(0)
      }
    }
  })

  it('states a row count that matches the table', () => {
    const stated = /Die Tabelle hat \*\*(\d+)\*\* Zeilen/.exec(windowsDoc)
    expect(stated, 'the count sentence in §2 is missing').not.toBeNull()
    // Non-null assertion avoided: the expect above already failed if null.
    if (stated === null) return
    expect(Number(stated[1])).toBe(rows.length)
  })

  it('quotes the command that reproduces the list', () => {
    expect(windowsDoc).toContain(GREP_COMMAND)
  })
})

/** Repo-relative file paths a reader is invited to open. */
function citedPaths(markdown: string): string[] {
  const cited = new Set<string>()
  // Backticked tokens under a source directory that end in a file extension.
  // Deliberately narrow: globs, `%APPDATA%` paths and `tray-{idle,…}.ico`
  // shorthands contain characters this class rejects, so they never match.
  const pattern = /`((?:src|docs|build|resources)\/[\w./@-]+\.\w+)(?::\d+)?`/g
  for (const match of markdown.matchAll(pattern)) {
    const path = match[1]
    if (path !== undefined) cited.add(path)
  }
  return [...cited].sort()
}

describe('the handoff documents cite files that exist', () => {
  it('every path in docs/WINDOWS.md resolves', () => {
    const cited = citedPaths(windowsDoc)
    // Guards against a silently vacuous check: the document names dozens.
    expect(cited.length).toBeGreaterThan(20)
    const missing = cited.filter((path) => !existsSync(join(ROOT, path)))
    expect(missing).toEqual([])
  })

  it('every path in README.md resolves', () => {
    const readme = readFileSync(join(ROOT, 'README.md'), 'utf8')
    const cited = citedPaths(readme)
    expect(cited.length).toBeGreaterThan(0)
    const missing = cited.filter((path) => !existsSync(join(ROOT, path)))
    expect(missing).toEqual([])
  })
})

describe('README.md is a usable entry point', () => {
  const readme = readFileSync(join(ROOT, 'README.md'), 'utf8')
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
    scripts: Record<string, string>
  }

  for (const script of Object.keys(pkg.scripts)) {
    it(`mentions npm run ${script}`, () => {
      expect(readme).toContain(script)
    })
  }

  for (const doc of ['docs/DESIGN.md', 'docs/WINDOWS.md', 'docs/api-discovery.md']) {
    it(`points at ${doc}`, () => {
      expect(readme).toContain(doc)
    })
  }

  it('says on the first screen that Windows is unverified', () => {
    // The one fact a reader must not miss. Anything below the fold does not count.
    expect(readme.slice(0, 1200)).toMatch(/Windows/)
    expect(readme).toMatch(/nie (auf Windows )?(ausgeführt|gelaufen)/)
  })
})
