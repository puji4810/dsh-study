/**
 * StudyOS error and envelope types: the model-facing result contract shared by both tools.
 * Domain failures are values inside a {@link StudyEnvelope}, never thrown exceptions; only
 * infrastructure failures (unreadable vault state, escaped paths) throw.
 * @module @puji4810/dsh-study/errors
 */

/** A stable, model-facing StudyOS failure. Codes mirror the Python plugin verbatim. */
export class StudyOSError extends Error {
  readonly code: string
  readonly details: Record<string, unknown> | undefined

  /**
   * @param code - stable error code, e.g. `VALIDATION_FAILED` or `SESSION_NOT_FOUND`.
   * @param message - human-readable explanation returned to the model.
   * @param details - optional structured detail, such as `{ errors: string[] }`.
   */
  constructor(code: string, message: string, details?: Record<string, unknown>) {
    super(message)
    this.name = 'StudyOSError'
    this.code = code
    this.details = details
  }
}

/** The serialized failure carried by a not-ok envelope. */
export interface StudyErrorValue {
  code: string
  message: string
  details?: Record<string, unknown>
}

/** Ok envelope: a successful domain outcome plus warnings. */
export interface StudyOkEnvelope {
  ok: true
  data: Record<string, unknown>
  warnings: string[]
}

/** Not-ok envelope: a stable domain failure plus warnings. */
export interface StudyErrEnvelope {
  ok: false
  error: StudyErrorValue
  warnings: string[]
}

/**
 * The uniform result every StudyOS handler returns. `ok: false` is a successful tool
 * execution whose domain outcome failed; the model reads the envelope, not an exception.
 */
export type StudyEnvelope = StudyOkEnvelope | StudyErrEnvelope

/**
 * Recursively normalize a handler payload into lossless JSON. `undefined`
 * becomes `null` (JSON.stringify silently drops it, and the tool layer rejects
 * the round trip as `value is not lossless JSON`); anything else a JSON round
 * trip cannot preserve — NaN/±Infinity, `-0`, BigInt, Symbol, Function, deep
 * class instances (`Date`/`Map`/`Set`/`RegExp`...), cycles, and sparse arrays —
 * raises a {@link StudyOSError} naming the failing path. Every handler output
 * passes through this normalization before it can cross the tool boundary.
 * @param value - the raw payload value.
 * @param path - the dotted diagnostic path (for example `$.data.due[0].difficulty`).
 * @param ancestors - the object identity stack used to detect cycles.
 * @returns the lossless-equivalent value.
 */
export function toLosslessJson(value: unknown, path = '$', ancestors: Set<object> = new Set()): unknown {
  if (value === undefined) return null
  if (value === null) return null
  const type = typeof value
  if (type === 'boolean' || type === 'string') return value
  if (type === 'number') {
    if (Number.isFinite(value) && !Object.is(value, -0)) return value
    throw new StudyOSError('INVALID_TOOL_OUTPUT', `Envelope value at ${path} is not lossless JSON: ${String(value)}`)
  }
  if (type === 'bigint' || type === 'symbol' || type === 'function') {
    throw new StudyOSError('INVALID_TOOL_OUTPUT', `Envelope value at ${path} is not lossless JSON: ${type}`)
  }
  // From here on value is an object.
  if (ancestors.has(value)) {
    throw new StudyOSError('INVALID_TOOL_OUTPUT', `Envelope value at ${path} is not lossless JSON: circular reference`)
  }
  if (Array.isArray(value)) {
    // Dense arrays own exactly the indices plus the non-enumerable `length`.
    if (Reflect.ownKeys(value).length !== value.length + 1) {
      throw new StudyOSError('INVALID_TOOL_OUTPUT', `Envelope value at ${path} is not lossless JSON: sparse array`)
    }
    ancestors.add(value)
    try {
      return value.map((item, index) => toLosslessJson(item, `${path}[${index}]`, ancestors))
    } finally {
      ancestors.delete(value)
    }
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    throw new StudyOSError(
      'INVALID_TOOL_OUTPUT',
      `Envelope value at ${path} is not a plain object: ${(prototype as { constructor?: { name?: string } }).constructor?.name ?? 'unknown prototype'}`,
    )
  }
  ancestors.add(value)
  try {
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(value)) {
      out[key] = toLosslessJson((value as Record<string, unknown>)[key], `${path}.${key}`, ancestors)
    }
    return out
  } finally {
    ancestors.delete(value)
  }
}

/**
 * Build an ok envelope. The payload is normalized to lossless JSON so every
 * envelope this package emits — through the model tools, dashboard bridges, or
 * remote services — is guaranteed to survive the tool-layer round trip.
 * @param data - the operation payload.
 * @param warnings - optional non-fatal observations.
 * @returns the ok envelope.
 */
export function ok(data: Record<string, unknown>, warnings: string[] = []): StudyOkEnvelope {
  return { ok: true, data: toLosslessJson(data) as Record<string, unknown>, warnings }
}

/**
 * Build a not-ok envelope from a {@link StudyOSError}.
 * @param error - the domain failure.
 * @returns the not-ok envelope.
 */
export function errFrom(error: StudyOSError): StudyErrEnvelope {
  const value: StudyErrorValue = { code: error.code, message: error.message }
  if (error.details !== undefined) value.details = toLosslessJson(error.details) as Record<string, unknown>
  return { ok: false, error: value, warnings: [] }
}

/**
 * Build a not-ok envelope from a code and message.
 * @param code - stable error code.
 * @param message - human-readable explanation.
 * @param details - optional structured detail.
 * @returns the not-ok envelope.
 */
export function err(code: string, message: string, details?: Record<string, unknown>): StudyErrEnvelope {
  return errFrom(new StudyOSError(code, message, details))
}
