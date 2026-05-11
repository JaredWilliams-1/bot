/**
 * Claudia Memory HTTP Client
 *
 * Thin HTTP client that talks to the claudia-memory FastAPI server.
 * Handles authentication, per-user routing, and basic retry logic.
 *
 * All public methods are async and return plain objects.
 * Errors are thrown with descriptive messages so the caller can decide
 * whether to surface them or degrade gracefully.
 */

import { MEMORY_API_URL, MEMORY_API_KEY } from './config.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Perform an authenticated POST to the memory API.
 *
 * @param {string} path - Endpoint path (e.g. "/memory/recall")
 * @param {object} body - Request body (will be JSON-encoded)
 * @returns {Promise<object>} Parsed JSON response
 */
async function post(path, body) {
  const url = `${MEMORY_API_URL}${path}`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${MEMORY_API_KEY}`,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => response.statusText);
    throw new Error(`Memory API error ${response.status} at ${path}: ${text}`);
  }

  return response.json();
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Store a new memory for a specific Slack user.
 *
 * @param {object} opts
 * @param {string} opts.content    - Text of the memory to store
 * @param {string} opts.userId     - Slack user ID (routes to per-user DB)
 * @param {string} [opts.type]     - Memory type ('fact', 'commitment', 'preference')
 * @param {string[]} [opts.entities] - Entity names to associate
 * @param {number} [opts.importance] - Importance score 0-1
 * @returns {Promise<{success: boolean, memory_id: number}>}
 */
export async function remember({ content, userId, type = 'fact', entities = [], importance = 0.7 }) {
  return post('/memory/remember', {
    content,
    memory_type: type,
    entities,
    importance,
    source_channel: 'slack',
    user_id: userId,
  });
}

/**
 * Recall memories relevant to a query for a specific user.
 *
 * @param {object} opts
 * @param {string} opts.query      - Natural language search query
 * @param {string} opts.userId     - Slack user ID
 * @param {number} [opts.limit]    - Max results (default 8)
 * @param {string[]} [opts.types]  - Optional memory type filter
 * @returns {Promise<{results: Array}>}
 */
export async function recall({ query, userId, limit = 8, types = null }) {
  return post('/memory/recall', {
    query,
    limit,
    memory_types: types,
    user_id: userId,
  });
}

/**
 * Retrieve everything known about a named entity.
 *
 * @param {object} opts
 * @param {string} opts.entityName - Entity name to look up
 * @param {string} opts.userId     - Slack user ID
 * @returns {Promise<{entity: object|null, memories: Array, relationships: Array}>}
 */
export async function about({ entityName, userId }) {
  return post('/memory/about', {
    entity_name: entityName,
    user_id: userId,
  });
}

/**
 * Create or update a relationship between two entities.
 *
 * @param {object} opts
 * @param {string} opts.source       - Source entity name
 * @param {string} opts.target       - Target entity name
 * @param {string} opts.relationship - Relationship description
 * @param {string} opts.userId       - Slack user ID
 * @param {number} [opts.strength]   - Strength 0-1 (default 0.5)
 * @returns {Promise<{success: boolean, relationship_id: number}>}
 */
export async function relate({ source, target, relationship, userId, strength = 0.5 }) {
  return post('/memory/relate', {
    source,
    target,
    relationship,
    strength,
    user_id: userId,
  });
}

/**
 * Retrieve a compact session briefing for a user.
 *
 * Includes overdue commitments, cooling relationships, recent activity,
 * and pattern highlights.
 *
 * @param {object} opts
 * @param {string} opts.userId - Slack user ID
 * @returns {Promise<{briefing: string}>}
 */
export async function briefing({ userId }) {
  return post('/memory/briefing', { user_id: userId });
}

/**
 * Liveness check for the memory API.
 *
 * @returns {Promise<boolean>} true if the API is reachable
 */
export async function isHealthy() {
  try {
    const response = await fetch(`${MEMORY_API_URL}/health`);
    if (!response.ok) return false;
    const body = await response.json();
    return body.status === 'ok';
  } catch {
    return false;
  }
}
