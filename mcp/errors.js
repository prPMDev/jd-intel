/**
 * Error code taxonomy for all MCP tools.
 *
 * The library (src/errors.js) owns the codes its adapters throw as AtsError,
 * and the MCP layer re-exports them so both sides read one source of truth.
 * The MCP layer adds one code of its own: internal_error, for an exception
 * that escapes a tool handler. Only the MCP layer has that boundary, so the
 * code lives here rather than in the library.
 */

import { ERROR_CODES as LIBRARY_ERROR_CODES } from 'jd-intel';

export const ERROR_CODES = {
  ...LIBRARY_ERROR_CODES,
  INTERNAL_ERROR: 'internal_error', // Unexpected exception escaped a handler
};
