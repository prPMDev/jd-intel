/**
 * Uniform response envelope for all MCP tools.
 *
 * Shape: { status, data, metadata }
 * status: "success" | "partial" | "error"
 *
 * The envelope is serialized as JSON text inside an MCP content block.
 * Every tool uses this so the AI learns one response pattern that works
 * across success, partial-failure, and error paths.
 */

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
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(payload, null, 2),
      },
    ],
  };
}
