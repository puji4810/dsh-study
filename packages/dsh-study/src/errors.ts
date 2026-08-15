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
 * Build an ok envelope.
 * @param data - the operation payload.
 * @param warnings - optional non-fatal observations.
 * @returns the ok envelope.
 */
export function ok(data: Record<string, unknown>, warnings: string[] = []): StudyOkEnvelope {
  return { ok: true, data, warnings }
}

/**
 * Build a not-ok envelope from a {@link StudyOSError}.
 * @param error - the domain failure.
 * @returns the not-ok envelope.
 */
export function errFrom(error: StudyOSError): StudyErrEnvelope {
  const value: StudyErrorValue = { code: error.code, message: error.message }
  if (error.details !== undefined) value.details = error.details
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
