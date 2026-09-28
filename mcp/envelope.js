/**
 * Uniform response envelope for all MCP tools.
 *
 * Shape: { status, data, metadata }
 * status: "success" | "partial" | "error"
 *
 * Returned twice per response: as JSON text in a content block (for clients
 * that only render text) and as structuredContent (validated against each
 * tool's outputSchema, for clients that render typed results). Every tool
 * uses this so the AI learns one response pattern that works across success,
 * partial-failure, and error paths.
 *
 * Only status "error" sets the protocol-level isError flag. "partial" still
 * carries a usable answer (a board answered while another adapter's check
 * failed; metadata.failed says which), so flagging it as a failure would make
 * clients hide or retry a valid result.
 */

import { z } from 'zod';

export function success(data, metadata = {}) {
  return wrap({ status: 'success', data, metadata });
}

export function partial(data, metadata = {}) {
  return wrap({ status: 'partial', data, metadata });
}

export function error(code, message, metadata = {}) {
  return wrap({
    status: 'error',
    data: null,
    error: { code, message: messageText(message) },
    metadata,
  });
}

// envelopeSchema declares error.message as a string and the SDK Client rejects
// the whole envelope when it is not one. Handlers forward err.message from
// whatever was thrown, which for a non-Error value can be anything.
function messageText(message) {
  if (typeof message === 'string' && message) return message;
  return String(message ?? '') || 'Unknown error';
}

function wrap(payload) {
  const result = {
    content: [
      {
        type: 'text',
        text: JSON.stringify(payload, null, 2),
      },
    ],
    structuredContent: payload,
  };
  if (payload.status === 'error') result.isError = true;
  return result;
}

/**
 * Build a tool's outputSchema from the schema of its `data` field.
 *
 * Two validators read this schema. The server skips isError results, but the
 * SDK Client validates any structuredContent against the JSON Schema it cached
 * from tools/list, error envelopes included. So `dataSchema` must accept null
 * (every error envelope carries data: null) and the error object must match.
 *
 * Extension rule: new response information goes in `metadata` (an open
 * record) or on the job items, never at the top level or on `error`. Those
 * two are .passthrough() only so a client still holding an older tools/list
 * keeps working if a field ever lands there.
 */
export function envelopeSchema(dataSchema) {
  return z
    .object({
      status: z.enum(['success', 'partial', 'error']),
      data: dataSchema,
      error: z.object({ code: z.string(), message: z.string() }).passthrough().optional(),
      metadata: z.record(z.unknown()),
    })
    .passthrough();
}
