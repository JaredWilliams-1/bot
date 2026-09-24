/**
 * File-backed Slack InstallationStore (multi-tenant).
 *
 * When the bot runs in multi-tenant mode, each workspace installs the app itself
 * via "Add to Slack". Bolt's OAuth flow hands us an Installation object that
 * contains that workspace's bot token. We persist it here so the token survives
 * container restarts and so Bolt can resolve the right per-workspace token for
 * every incoming event.
 *
 * Implements the @slack/oauth InstallationStore interface:
 *   - storeInstallation(installation)
 *   - fetchInstallation(query)   (throws when not found, per the contract)
 *   - deleteInstallation(query)
 *
 * Persistence:
 *   Installations are written as JSON files on disk under a base directory that
 *   lives on the SAME mounted volume the calendar tokens use (~/.claudia), so
 *   they persist across restarts. Default base: ~/.claudia/installations/,
 *   overridable via SLACK_INSTALLATION_DIR.
 *
 *   Keying (mirrors Slack's own org-aware convention):
 *     - Org-wide install (installation.isEnterpriseInstall with an enterprise id):
 *       keyed on the enterprise id.
 *     - Otherwise: keyed on the team id.
 *   The key is sanitized for filesystem use with the SAME [^a-zA-Z0-9_-] rule
 *   used by calendar-client.js sanitizeUserId, then used as the JSON filename.
 *
 * Note: this is a deliberately simple single-file-per-workspace store. It does
 * not keep historical installation revisions; the latest install for a given
 * team/enterprise overwrites the previous one, which is the desired behavior for
 * a self-hosted single-tenant-per-workspace bot.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

/** Base directory for stored installations. Lives on the persistent volume. */
const INSTALLATION_DIR =
  process.env.SLACK_INSTALLATION_DIR || join(homedir(), '.claudia', 'installations');

/**
 * Sanitize an id for use as a filename.
 * Mirrors calendar-client.js sanitizeUserId and the memory daemon db_manager:
 * keep alphanumerics, '-' and '_'. Falls back to 'default' if empty.
 *
 * @param {string} id
 * @returns {string} A filesystem-safe id.
 */
function sanitizeId(id) {
  const safe = String(id || '').replace(/[^a-zA-Z0-9_-]/g, '');
  return safe || 'default';
}

/**
 * Resolve the storage key for an installation or a query.
 *
 * For org-wide installs (isEnterpriseInstall true and an enterprise id present),
 * the enterprise id is the identity. Otherwise the team id is used. This mirrors
 * how the value is later looked up in fetchInstallation/deleteInstallation.
 *
 * @param {object} opts
 * @param {string} [opts.enterpriseId]
 * @param {string} [opts.teamId]
 * @param {boolean} [opts.isEnterpriseInstall]
 * @returns {string} The sanitized storage key.
 */
function keyFor({ enterpriseId, teamId, isEnterpriseInstall }) {
  if (isEnterpriseInstall && enterpriseId) {
    return sanitizeId(enterpriseId);
  }
  if (teamId) {
    return sanitizeId(teamId);
  }
  // Org install where only the enterprise id is known, or any partial query.
  if (enterpriseId) {
    return sanitizeId(enterpriseId);
  }
  throw new Error('Cannot resolve an installation key: no teamId or enterpriseId provided.');
}

/** Absolute JSON path for a given storage key. */
function pathForKey(key) {
  return join(INSTALLATION_DIR, `${key}.json`);
}

/**
 * File-backed installation store implementing the @slack/oauth interface.
 */
export class FileInstallationStore {
  /**
   * @param {object} [opts]
   * @param {string} [opts.baseDir] - Override the base directory (defaults to
   *                                  SLACK_INSTALLATION_DIR or ~/.claudia/installations).
   */
  constructor({ baseDir } = {}) {
    this.baseDir = baseDir || INSTALLATION_DIR;
  }

  _pathForKey(key) {
    return join(this.baseDir, `${key}.json`);
  }

  /**
   * Persist an installation to disk, keyed by enterprise id (org install) or
   * team id. Called by Bolt at the end of a successful OAuth install.
   *
   * @param {import('@slack/oauth').Installation} installation
   * @returns {Promise<void>}
   */
  async storeInstallation(installation) {
    const enterpriseId = installation.enterprise?.id;
    const teamId = installation.team?.id;
    const isEnterpriseInstall = Boolean(installation.isEnterpriseInstall);

    const key = keyFor({ enterpriseId, teamId, isEnterpriseInstall });

    if (!existsSync(this.baseDir)) {
      mkdirSync(this.baseDir, { recursive: true });
    }
    writeFileSync(this._pathForKey(key), JSON.stringify(installation, null, 2));
  }

  /**
   * Load a previously stored installation. Bolt calls this on every event to
   * resolve the right per-workspace bot token.
   *
   * Per the @slack/oauth contract, this MUST throw when no installation is found
   * (Bolt treats a thrown error as "not installed").
   *
   * @param {import('@slack/oauth').InstallationQuery<boolean>} query
   * @returns {Promise<import('@slack/oauth').Installation>}
   */
  async fetchInstallation(query) {
    const { enterpriseId, teamId, isEnterpriseInstall } = query;
    const key = keyFor({ enterpriseId, teamId, isEnterpriseInstall });
    const filePath = this._pathForKey(key);

    if (!existsSync(filePath)) {
      throw new Error(
        `No installation found (enterpriseId=${enterpriseId}, teamId=${teamId}).`
      );
    }
    try {
      return JSON.parse(readFileSync(filePath, 'utf8'));
    } catch (err) {
      throw new Error(`Failed to read installation for key ${key}: ${err.message}`);
    }
  }

  /**
   * Delete a stored installation (e.g. on app uninstall).
   *
   * @param {import('@slack/oauth').InstallationQuery<boolean>} query
   * @returns {Promise<void>}
   */
  async deleteInstallation(query) {
    const { enterpriseId, teamId, isEnterpriseInstall } = query;
    const key = keyFor({ enterpriseId, teamId, isEnterpriseInstall });
    const filePath = this._pathForKey(key);
    if (existsSync(filePath)) {
      unlinkSync(filePath);
    }
  }
}

export default FileInstallationStore;
