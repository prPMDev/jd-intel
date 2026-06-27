/**
 * Error taxonomy + typed error for the jd-intel toolkit.
 *
 * Codes are short and stable; the MCP tool descriptions teach the AI what each
 * one means. Adapters throw AtsError with a code so callers map failures by
 * `err.code` instead of parsing the message.
 */

export const ERROR_CODES = {
  COMPANY_NOT_FOUND: 'company_not_found',  // Slug not in registry and not detected
  ATS_UNREACHABLE: 'ats_unreachable',      // Known ATS failed (500, timeout)
  PARTIAL_FAILURE: 'partial_failure',      // Discovery mode; some adapters failed
  INVALID_ARGS: 'invalid_args',            // Missing required, wrong type, bad pattern
  NO_RESULTS: 'no_results',                // Query succeeded, filters returned nothing
  RATE_LIMITED: 'rate_limited',            // Upstream returned 429
};

/**
 * Thrown by adapters on an upstream HTTP failure. Carries a stable `code`
 * (ats_unreachable / rate_limited) so the MCP layer maps it without parsing
 * the message. Extends Error, so the message, stack, and `instanceof Error`
 * all keep working for existing library consumers.
 */
export class AtsError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'AtsError';
    this.code = code;
  }
}

/**
 * Helper for adapters: build an AtsError from an HTTP status (429 => rate
 * limited, anything else => unreachable) with the given message.
 */
export function atsErrorFromStatus(status, message) {
  return new AtsError(status === 429 ? ERROR_CODES.RATE_LIMITED : ERROR_CODES.ATS_UNREACHABLE, message);
}
