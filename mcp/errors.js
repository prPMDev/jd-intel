/**
 * Error code taxonomy for all MCP tools.
 *
 * The canonical codes now live in the jd-intel library (src/errors.js), so the
 * library (which throws AtsError with a .code) and the MCP layer share one
 * source of truth. Re-exported here to keep the existing import path stable.
 */

export { ERROR_CODES } from 'jd-intel';
