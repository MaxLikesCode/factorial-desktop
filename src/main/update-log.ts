/**
 * A log file for the updater, because its failures are invisible otherwise.
 *
 * `console.error` in a packaged app writes to a stream nobody is attached to.
 * Every question worth asking about an update — did Squirrel ever fetch the
 * archive, what did it object to, how far did the download get — was therefore
 * unanswerable on the machine where it went wrong, which is the only machine
 * that matters.
 *
 * No `electron-log`: the whole need is "append a line with a timestamp", and a
 * dependency for that would be the same trade the i18n module already declined.
 * The shape below is deliberately the one electron-updater expects of a logger,
 * so it can be handed straight to `updater.logger` and record its own internals
 * — which is where the interesting half of the story is.
 *
 * Failures to log are swallowed. A full disk is a bad reason to take an app
 * down, and there is nowhere left to report it to anyway.
 */

import { appendFileSync } from 'node:fs'
import { join } from 'node:path'

/** Beyond this the file is started over, so it cannot grow without bound. */
const MAX_BYTES = 512 * 1024

export interface UpdateLogger {
  info(message: unknown): void
  warn(message: unknown): void
  error(message: unknown): void
  debug(message: unknown): void
}

export function createUpdateLog(userDataPath: string): UpdateLogger & { path: string } {
  const path = join(userDataPath, 'update.log')
  let written = 0

  function write(level: string, message: unknown): void {
    const text = message instanceof Error ? (message.stack ?? message.message) : String(message)
    const line = `${new Date().toISOString()} ${level} ${text}\n`
    try {
      // Truncating rather than rotating: the last half megabyte is the run that
      // is being debugged, and a second file would only ever be read by accident.
      if (written > MAX_BYTES) written = 0
      appendFileSync(path, line, { flag: written === 0 ? 'w' : 'a' })
      written += line.length
    } catch {
      // See the note at the top.
    }
  }

  return {
    path,
    info: (m) => write('INFO ', m),
    warn: (m) => write('WARN ', m),
    error: (m) => write('ERROR', m),
    debug: (m) => write('DEBUG', m),
  }
}
