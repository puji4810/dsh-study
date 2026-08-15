/**
 * Timezone-disciplined date helpers. StudyOS rejects naive timestamps and compares
 * "local dates" in the project's IANA timezone, so every parse here requires an offset
 * and every zone conversion goes through Intl.
 * @module @puji4810/dsh-study/datetime
 */

import { DATE_PATTERN, DATETIME_WITH_OFFSET_PATTERN } from './constants.ts'

/** Timezone-aware wall-clock parts of a Date in a named IANA timezone. */
export interface ZoneParts {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  second: number
}

const DATE_RE = new RegExp(DATE_PATTERN)
const DATETIME_RE = new RegExp(DATETIME_WITH_OFFSET_PATTERN)

/**
 * Parse an ISO date string (YYYY-MM-DD).
 * @param value - the candidate string.
 * @returns a UTC-midnight Date, or null when the value is not a valid ISO date.
 */
export function parseDate(value: unknown): Date | null {
  if (typeof value !== 'string' || !DATE_RE.test(value)) return null
  const parsed = new Date(`${value}T00:00:00Z`)
  if (Number.isNaN(parsed.getTime())) return null
  return parsed
}

/**
 * Parse an ISO datetime that must carry an explicit timezone offset.
 * @param value - the candidate string; `Z` is accepted.
 * @returns the instant, or null when missing, malformed, or naive.
 */
export function parseOffsetDateTime(value: unknown): Date | null {
  if (typeof value !== 'string' || !DATETIME_RE.test(value)) return null
  const parsed = new Date(value.replace(/Z$/, '+00:00'))
  if (Number.isNaN(parsed.getTime())) return null
  return parsed
}

/**
 * Render an instant as ISO seconds with its offset in a named IANA timezone.
 * @param date - the instant.
 * @param timeZone - a valid IANA timezone name.
 * @returns e.g. `2026-07-01T20:00:00+08:00`.
 * @throws `StudyOSError`-style message is left to callers; invalid zones return null parts.
 */
export function toZonedIso(date: Date, timeZone: string): string | null {
  const parts = zoneParts(date, timeZone)
  if (parts === null) return null
  const offset = zoneOffsetMinutes(date, timeZone)
  if (offset === null) return null
  const sign = offset < 0 ? '-' : '+'
  const abs = Math.abs(offset)
  const hours = String(Math.floor(abs / 60)).padStart(2, '0')
  const minutes = String(abs % 60).padStart(2, '0')
  const pad = (value: number): string => String(value).padStart(2, '0')
  return (
    `${parts.year}-${pad(parts.month)}-${pad(parts.day)}T${pad(parts.hour)}:${pad(parts.minute)}:${pad(parts.second)}`
    + `${sign}${hours}:${minutes}`
  )
}

/**
 * Wall-clock parts of a Date in a named IANA timezone.
 * @param date - the instant.
 * @param timeZone - a valid IANA timezone name.
 * @returns the parts, or null when the zone name is invalid.
 */
export function zoneParts(date: Date, timeZone: string): ZoneParts | null {
  let parts: Intl.DateTimeFormatPart[]
  try {
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(date)
  } catch {
    return null
  }
  const value = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find(part => part.type === type)?.value ?? '0'
  return {
    year: Number(value('year')),
    month: Number(value('month')),
    day: Number(value('day')),
    hour: Number(value('hour')),
    minute: Number(value('minute')),
    second: Number(value('second')),
  }
}

/**
 * Offset minutes east of UTC for a Date in a named IANA timezone.
 * @param date - the instant.
 * @param timeZone - a valid IANA timezone name.
 * @returns offset minutes, or null when the zone name is invalid.
 */
export function zoneOffsetMinutes(date: Date, timeZone: string): number | null {
  let short: string | undefined
  try {
    short = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'shortOffset' })
      .formatToParts(date)
      .find(part => part.type === 'timeZoneName')?.value
  } catch {
    return null
  }
  if (short === undefined) return null
  // "GMT+08:00" or "GMT" (UTC offset zero may render as "GMT").
  const match = /^GMT([+-])(\d{1,2})(?::(\d{2}))?$/.exec(short)
  if (match === null) return 0
  const [, sign, hours, minutes = '0'] = match
  if (sign === undefined || hours === undefined) return 0
  const total = Number(hours) * 60 + Number(minutes)
  return sign === '-' ? -total : total
}

/**
 * A Date for local midnight of a date in a named IANA timezone.
 * @param year - local year.
 * @param month - local month (1-12).
 * @param day - local day (1-31).
 * @param timeZone - a valid IANA timezone name.
 * @returns the instant, or null when the zone name is invalid.
 */
export function zonedDayStart(year: number, month: number, day: number, timeZone: string): Date | null {
  const probe = new Date(Date.UTC(year, month - 1, day, 12, 0, 0))
  const offset = zoneOffsetMinutes(probe, timeZone)
  if (offset === null) return null
  // Construct local midnight by removing the zone offset from a UTC guess,
  // then correct for DST drift with one re-check.
  let instant = new Date(Date.UTC(year, month - 1, day, 0, 0, 0) - offset * 60_000)
  const drifted = zoneOffsetMinutes(instant, timeZone)
  if (drifted === null) return null
  if (drifted !== offset) instant = new Date(Date.UTC(year, month - 1, day, 0, 0, 0) - drifted * 60_000)
  return instant
}

/**
 * Advance a Date by a whole number of minutes.
 * @param date - the base instant.
 * @param minutes - minutes to add.
 * @returns the advanced instant.
 */
export function addMinutes(date: Date, minutes: number): Date {
  return new Date(date.getTime() + minutes * 60_000)
}

/**
 * Advance a Date by a whole number of days.
 * @param date - the base instant.
 * @param days - days to add.
 * @returns the advanced instant.
 */
export function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 86_400_000)
}

/**
 * ISO date string (YYYY-MM-DD) for a Date in a named IANA timezone.
 * @param date - the instant.
 * @param timeZone - a valid IANA timezone name.
 * @returns the local date string, or null when the zone name is invalid.
 */
export function localDateString(date: Date, timeZone: string): string | null {
  const parts = zoneParts(date, timeZone)
  if (parts === null) return null
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}`
}

/**
 * Validate an IANA timezone name for the StudyOS error message.
 * @param name - the declared zone.
 * @returns true when Intl accepts the zone.
 */
export function isValidTimeZone(name: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: name }).format()
    return true
  } catch {
    return false
  }
}

/**
 * Render an instant as UTC ISO with whole-second precision, the shape StudyOS
 * timestamps use everywhere.
 * @param date - the instant.
 * @returns e.g. `2026-07-01T12:34:56Z`.
 */
export function toIsoSeconds(date: Date): string {
  return new Date(Math.floor(date.getTime() / 1000) * 1000).toISOString().replace('.000Z', 'Z')
}
