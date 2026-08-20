/**
 * Factorial's API never returns a usable absolute timestamp.
 *
 * `openShift.clockIn`        -> "2000-01-01T01:18:23Z"      (sentinel date, local time)
 * `shift.clockInWithSeconds` -> "2026-08-11T09:49:05+00:00" (UTC date + LOCAL time,
 *                                                            falsely labelled +00:00)
 *
 * Only the time-of-day is trustworthy. Three parts, all from the same API
 * response, rebuild the real instant:
 *
 *   date   <- shift.date / openShift.date   (the local calendar day)
 *   time   <- clockInWithSeconds / clockIn  (time component only)
 *   zone   <- clockInOffset                 ("+02:00")
 *
 * Verified against the one real UTC instant in the schema:
 *   clockInWithSeconds 2026-08-11T09:49:05+00:00, clockInOffset +02:00,
 *   date 2026-08-11  ->  2026-08-11T07:49:05Z  ==  createdAt.
 *
 * Because the offset arrives with the data, this function is total: it needs
 * neither the current time nor the machine's zone. The earlier "if the result
 * lies in the future, subtract a day" heuristic is gone — it guessed, and a
 * guess in a time-tracking app writes hours that never happened.
 */

/** Time component only; the date component of an API timestamp is never trusted. */
const TIME_OF_DAY = /T(\d{2}):(\d{2}):(\d{2})/
const CALENDAR_DATE = /^(\d{4})-(\d{2})-(\d{2})$/
/** `clockInOffset` is "+02:00"; the compact "+0200" spelling is accepted too. */
const ZONE_OFFSET = /^([+-])(\d{2}):?(\d{2})$/

/**
 * Turns a captured regex group into a number. A group can only be `undefined`
 * if the pattern made it optional — none of the patterns above do — so this is
 * a total conversion that fails loudly instead of producing NaN downstream.
 */
function toNumber(group: string | undefined, label: string, source: string): number {
  const value = Number(group)
  if (!Number.isInteger(value)) {
    throw new Error(`unparseable ${label} in: ${source}`)
  }
  return value
}

export function reconstructInstant(
  localDate: string,
  apiTimestamp: string,
  offset: string,
): Date {
  const date = CALENDAR_DATE.exec(localDate)
  if (!date) throw new Error(`unparseable local date: ${localDate}`)

  const time = TIME_OF_DAY.exec(apiTimestamp)
  if (!time) throw new Error(`unparseable API timestamp: ${apiTimestamp}`)

  const zone = ZONE_OFFSET.exec(offset)
  if (!zone) throw new Error(`unparseable zone offset: ${offset}`)

  const year = toNumber(date[1], 'year', localDate)
  const month = toNumber(date[2], 'month', localDate)
  const day = toNumber(date[3], 'day', localDate)

  const hours = toNumber(time[1], 'hours', apiTimestamp)
  const minutes = toNumber(time[2], 'minutes', apiTimestamp)
  const seconds = toNumber(time[3], 'seconds', apiTimestamp)

  const sign = zone[1] === '-' ? -1 : 1
  const offsetHours = toNumber(zone[2], 'offset hours', offset)
  const offsetMinutes = toNumber(zone[3], 'offset minutes', offset)
  if (offsetHours > 23 || offsetMinutes > 59) {
    throw new Error(`out-of-range zone offset: ${offset}`)
  }

  // Read the wall-clock parts as if they were UTC, then subtract the offset
  // they actually belong to. No local-zone arithmetic is involved.
  const asUtc = new Date(Date.UTC(year, month - 1, day, hours, minutes, seconds))

  // Date.UTC silently rolls impossible values over (month 13 -> next January,
  // 2026-02-30 -> 2026-03-02, hour 25 -> next day, and two-digit years into the
  // 1900s). Rolling over would hand back a plausible-looking wrong instant, so
  // every component is read back and compared instead.
  if (
    asUtc.getUTCFullYear() !== year ||
    asUtc.getUTCMonth() !== month - 1 ||
    asUtc.getUTCDate() !== day ||
    asUtc.getUTCHours() !== hours ||
    asUtc.getUTCMinutes() !== minutes ||
    asUtc.getUTCSeconds() !== seconds
  ) {
    throw new Error(`impossible date or time: ${localDate} ${apiTimestamp}`)
  }

  const totalOffsetMinutes = sign * (offsetHours * 60 + offsetMinutes)
  return new Date(asUtc.getTime() - totalOffsetMinutes * 60_000)
}

/** `"H:MM:SS"` — hours are not capped at 24 and never render as a minus. */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

/** `"HH:MM"` — used for the target time and the remaining-time line. */
export function formatHoursMinutes(minutes: number): string {
  const total = Math.max(0, Math.round(minutes))
  const h = Math.floor(total / 60)
  const m = total % 60
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

/**
 * `"+H:MM"` — how far the day has run past its goal.
 *
 * Hours are not zero-padded, unlike `formatHoursMinutes`: this reading is
 * prefixed and short-lived where the other sits in a fixed column, and "+2:23"
 * reads as a surplus where "+02:23" reads as a clock time.
 */
export function formatOvertime(minutes: number): string {
  const total = Math.max(0, Math.round(minutes))
  const h = Math.floor(total / 60)
  const m = total % 60
  return `+${h}:${String(m).padStart(2, '0')}`
}

/** The local calendar day, in the shape `shift.date` uses: "2026-08-12". */
export function toLocalDate(d: Date): string {
  return [
    d.getFullYear(),
    String(d.getMonth() + 1).padStart(2, '0'),
    String(d.getDate()).padStart(2, '0'),
  ].join('-')
}

/** The machine's current offset in the shape `clockInOffset` uses: "+02:00". */
export function toLocalOffset(d: Date): string {
  const offsetMinutes = -d.getTimezoneOffset()
  const sign = offsetMinutes >= 0 ? '+' : '-'
  const abs = Math.abs(offsetMinutes)
  return `${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`
}

/**
 * The `now` argument every attendance mutation requires: ISO8601 with the local
 * offset, e.g. "2026-08-12T00:11:12+02:00".
 */
export function toLocalIsoWithOffset(d: Date): string {
  const time = [d.getHours(), d.getMinutes(), d.getSeconds()]
    .map((n) => String(n).padStart(2, '0'))
    .join(':')
  return `${toLocalDate(d)}T${time}${toLocalOffset(d)}`
}
