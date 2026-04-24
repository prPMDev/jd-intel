/**
 * Error code taxonomy for all MCP tools.
 *
 * Codes are short and stable. Messages are short and factual.
 * The tool description teaches the AI what each code means; errors
 * themselves do not need to be verbose.
 */

export const ERROR_CODES = {
  COMPANY_NOT_FOUND: 'company_not_found',  // Slug not in registry and not detected
  ATS_UNREACHABLE: 'ats_unreachable',      // Known ATS failed (500, timeout)
  PARTIAL_FAILURE: 'partial_failure',      // Discovery mode; some adapters failed
  INVALID_ARGS: 'invalid_args',            // Missing required, wrong type, bad pattern
  NO_RESULTS: 'no_results',                // Query succeeded, filters returned nothing
  RATE_LIMITED: 'rate_limited',            // Upstream returned 429
};
