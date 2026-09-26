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
 * carries a usable answer (e.g. detect_ats found several boards), so flagging
 * it as a failure would make clients hide or retry a valid result.
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
    error: { code, message },
    metadata,
  });
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
 * Error responses skip SDK output validation (isError), so `data` schemas
 * only need to describe success/partial payloads.
 */
export function envelopeSchema(dataSchema) {
  return z.object({
    status: z.enum(['success', 'partial', 'error']),
    data: dataSchema,
    error: z.object({ code: z.string(), message: z.string() }).optional(),
    metadata: z.record(z.unknown()),
  });
}
