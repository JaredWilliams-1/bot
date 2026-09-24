/**
 * Storage identity helper for multi-tenant namespacing.
 *
 * Slack user IDs (e.g. "U012AB3CD") are unique only WITHIN a single workspace.
 * Once the bot is installed across multiple workspaces, two different people in
 * two different workspaces can share the same user ID. If we keyed per-user data
 * (memory DBs, calendar tokens) on the bare user ID, those two people would
 * collide and read each other's data.
 *
 * To prevent that, this module derives a COMPOSITE storage key that prefixes the
 * user ID with the team (or enterprise) ID.
 *
 * Why the enterprise ID wins whenever it is present (NOT just for org-wide
 * installs). This looks like it should mirror installation-store.js, which only
 * keys on the enterprise ID when isEnterpriseInstall is true, but the two are
 * answering different questions. That one asks "which bot token?", which really
 * is per-install. This one asks "whose data?", and inside an Enterprise Grid org
 * the answer is org-wide for three reasons:
 *
 *   1. Grid user IDs are already org-global: "Within an Enterprise org, all
 *      users have a single, global ID beginning with either the letter U or W."
 *      So E1__U123 in workspace A and in workspace B are the same human. Two
 *      different people can never collide under one enterprise ID.
 *   2. Slack recommends exactly this grouping: "If your app is installed on
 *      multiple workspaces within an Enterprise organization, you may want to
 *      [group] data by enterprise_id values and [use] those new values as your
 *      primary source of truth."
 *   3. Team ID is NOT reliably present in Grid. DM and Home tab events "may not
 *      always include the workspace's ID (team_id)", because those surfaces are
 *      reachable from any workspace in the org. Preferring teamId would key the
 *      same person's DMs and channel mentions to two different stores, and
 *      would do so nondeterministically. Since this bot is driven mostly by
 *      DMs and mentions, that would split memory in practice, not in theory.
 *
 * Outside a Grid org there is no enterprise ID, so the key falls back to the
 * team ID and separate customer workspaces stay fully isolated.
 *
 * Separator choice:
 *   We use a double underscore ("__") between the team/enterprise id and the
 *   user id. This is deliberate. Downstream consumers sanitize the key for
 *   filesystem/db use:
 *     - calendar-client.js sanitizeUserId(): /[^a-zA-Z0-9_-]/g  (keeps "_")
 *     - memory daemon db_manager._db_path_for(): c.isalnum() or c in "-_" (keeps "_")
 *   Both KEEP underscores, so "T123__U456" survives byte-for-byte identically on
 *   the JS side and the Python side, mapping to the SAME per-user store. A colon
 *   separator would NOT survive (both sanitizers strip ":"), which could make
 *   "T1:U23" and "T12:U3" collapse ambiguously, so we avoid it.
 *
 * Backward compatibility:
 *   Bolt always supplies teamId/enterpriseId on normal workspace events, so
 *   "is team context present?" is the wrong switch. Namespacing is gated on
 *   multi-tenant mode (SLACK_BOT_CLIENT_ID + SLACK_BOT_CLIENT_SECRET +
 *   SLACK_STATE_SECRET). Single-workspace deployments keep the legacy bare
 *   user ID, so existing memory DBs and calendar tokens keep working. Host CLI
 *   auth (no team context) also stays on the bare id.
 */

/** Separator between the team/enterprise id and the user id in a composite key. */
export const STORAGE_ID_SEPARATOR = '__';

/**
 * True when the bot is running in multi-tenant install mode.
 *
 * Source of truth for both install mode (config.js MULTI_TENANT) and storage
 * namespacing. Kept here so identity tests and calendar-client CLI usage can
 * call storageId without importing config.js (which throws on missing env).
 *
 * @returns {boolean}
 */
export function isMultiTenant() {
  return Boolean(
    process.env.SLACK_BOT_CLIENT_ID &&
    process.env.SLACK_BOT_CLIENT_SECRET &&
    process.env.SLACK_STATE_SECRET
  );
}

/**
 * Derive the storage identity for a user.
 *
 * Returns the bare userId in single-workspace mode (fully backward compatible,
 * even when Bolt supplies a teamId). In multi-tenant mode, returns
 * "<enterpriseId|teamId>__<userId>" when a team context is present, so per-user
 * data is namespaced by org (Grid) or by workspace (everyone else). Falls back
 * to the bare userId if multi-tenant is on but no team context is available
 * (host CLI auth).
 *
 * The returned string is later sanitized by the consumers (calendar-client.js
 * and the memory daemon), both of which keep underscores, so the same logical
 * user maps to the same on-disk store on both sides.
 *
 * @param {object} opts
 * @param {string} opts.userId          - The raw Slack user ID (required).
 * @param {string} [opts.teamId]        - The Slack team/workspace ID.
 * @param {string} [opts.enterpriseId]  - The Slack enterprise/org ID (org installs).
 * @param {boolean} [opts.multiTenant]  - Override multi-tenant detection (tests).
 * @returns {string} The composite storage key, or the bare userId if unnamespaced.
 */
export function storageId({ userId, teamId, enterpriseId, multiTenant } = {}) {
  if (!userId) {
    throw new Error('storageId requires a userId.');
  }
  const namespaced = multiTenant ?? isMultiTenant();
  if (!namespaced) {
    // Single-workspace: keep the legacy bare-id key even if Bolt sent a teamId.
    return userId;
  }
  // Enterprise first, deliberately: it is the only identifier Grid guarantees on
  // every surface, and Grid user ids are org-global. See the header comment.
  const namespace = enterpriseId || teamId;
  if (!namespace) {
    // Multi-tenant but no team context (host CLI auth). Preserve the bare id.
    return userId;
  }
  return `${namespace}${STORAGE_ID_SEPARATOR}${userId}`;
}
