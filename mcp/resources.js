/**
 * Register Resources on the MCP server.
 *
 * The registry is exposed as a Resource for broad catalog surveys.
 * Tools (search_registry) handle directed queries; the Resource
 * covers the "tell me about the whole index" intent without needing
 * repeated tool calls.
 *
 * Resources are lazy-loaded — the AI only fetches when it decides
 * it needs the full catalog. One fetch per session for broad reasoning.
 */

import { loadRegistry } from '../src/registry.js';
import { REGISTRY_RESOURCE } from './descriptions.js';

export function registerResources(server) {
  server.registerResource(
    'registry',
    'registry://ats-index/all',
    {
      title: 'ats-index company registry',
      description: REGISTRY_RESOURCE,
      mimeType: 'application/json',
    },
    async (uri) => {
      const all = await loadRegistry();
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: 'application/json',
            text: JSON.stringify(all, null, 2),
          },
        ],
      };
    }
  );
}
