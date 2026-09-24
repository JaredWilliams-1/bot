/**
 * Tests for the Google integration config.
 *
 * Validates that the .mcp.json.example files carry a correct workspace-mcp
 * entry AND keep the standalone gmail/google-calendar servers alongside it.
 *
 * Note on history: an earlier revision of this file asserted that every trace
 * of the standalone @gongrzhe servers had been removed, because at the time
 * workspace-mcp was meant to replace them. Release 1.55.13 reversed that:
 * "the standalone gmail and google-calendar servers are now first-class
 * options alongside workspace-mcp ... Both can coexist." Those removal
 * assertions are therefore inverted here, so the suite guards the two-path
 * setup that actually shipped instead of a migration that was abandoned.
 *
 * Run: npm test
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = join(__dirname, '..');

// ─── Helper ──────────────────────────────────────────────────────────────────

function readJson(relPath) {
  const full = join(ROOT, relPath);
  return JSON.parse(readFileSync(full, 'utf-8'));
}

// ─── Root .mcp.json.example ──────────────────────────────────────────────────

describe('.mcp.json.example (root)', () => {
  const config = readJson('.mcp.json.example');

  it('has a google_workspace entry', () => {
    assert.ok(config.mcpServers.google_workspace,
      'Expected mcpServers.google_workspace to exist');
  });

  it('uses uvx command', () => {
    const gw = config.mcpServers.google_workspace;
    assert.equal(gw.command, 'uvx',
      'Expected command to be "uvx"');
  });

  it('includes workspace-mcp in args', () => {
    const gw = config.mcpServers.google_workspace;
    assert.ok(gw.args.includes('workspace-mcp'),
      'Expected args to include "workspace-mcp"');
  });

  it('defaults to --tool-tier core', () => {
    const gw = config.mcpServers.google_workspace;
    const tierIdx = gw.args.indexOf('--tool-tier');
    assert.ok(tierIdx >= 0, 'Expected --tool-tier flag in args');
    assert.equal(gw.args[tierIdx + 1], 'core',
      'Expected default tier to be "core"');
  });

  it('has GOOGLE_OAUTH_CLIENT_ID env var', () => {
    const gw = config.mcpServers.google_workspace;
    assert.ok(gw.env, 'Expected env object');
    assert.ok('GOOGLE_OAUTH_CLIENT_ID' in gw.env,
      'Expected GOOGLE_OAUTH_CLIENT_ID in env');
  });

  it('has GOOGLE_OAUTH_CLIENT_SECRET env var', () => {
    const gw = config.mcpServers.google_workspace;
    assert.ok('GOOGLE_OAUTH_CLIENT_SECRET' in gw.env,
      'Expected GOOGLE_OAUTH_CLIENT_SECRET in env');
  });

  it('keeps the standalone gmail entry (Option A)', () => {
    assert.ok(config.mcpServers.gmail,
      'Standalone gmail server should remain offered alongside workspace-mcp');
  });

  it('keeps the standalone google-calendar entry (Option A)', () => {
    assert.ok(config.mcpServers['google-calendar'],
      'Standalone google-calendar server should remain offered alongside workspace-mcp');
  });

  it('still has rube entry', () => {
    assert.ok(config.mcpServers.rube,
      'Rube entry should be preserved');
  });
});

// ─── template-v2/.mcp.json.example ──────────────────────────────────────────

describe('template-v2/.mcp.json.example', () => {
  const config = readJson('template-v2/.mcp.json.example');

  it('has a google_workspace entry', () => {
    assert.ok(config.mcpServers.google_workspace,
      'Expected mcpServers.google_workspace to exist');
  });

  it('uses uvx command', () => {
    const gw = config.mcpServers.google_workspace;
    assert.equal(gw.command, 'uvx');
  });

  it('defaults to --tool-tier core', () => {
    const gw = config.mcpServers.google_workspace;
    const tierIdx = gw.args.indexOf('--tool-tier');
    assert.ok(tierIdx >= 0);
    assert.equal(gw.args[tierIdx + 1], 'core');
  });

  it('has OAuth env vars', () => {
    const gw = config.mcpServers.google_workspace;
    assert.ok(gw.env);
    assert.ok('GOOGLE_OAUTH_CLIENT_ID' in gw.env);
    assert.ok('GOOGLE_OAUTH_CLIENT_SECRET' in gw.env);
  });

  it('keeps the standalone gmail entry (Option A)', () => {
    assert.ok(config.mcpServers.gmail);
  });

  it('keeps the standalone google-calendar entry (Option A)', () => {
    assert.ok(config.mcpServers['google-calendar']);
  });

  it('still has claudia-memory entry', () => {
    assert.ok(config.mcpServers['claudia-memory'],
      'claudia-memory should be preserved');
  });

  it('still has rube entry', () => {
    assert.ok(config.mcpServers.rube,
      'Rube entry should be preserved');
  });
});

// ─── Installer migration detection ──────────────────────────────────────────

describe('installer migration logic', () => {
  // The restoreMcpServers function should NOT restore old gmail/google-calendar
  // entries from _disabled_mcpServers. It should only restore claudia-memory.
  // We test this by checking the function definition in bin/index.js.

  it('restoreMcpServers does not list gmail in toRestore', () => {
    const src = readFileSync(join(ROOT, 'bin', 'index.js'), 'utf-8');
    // Find the toRestore array and verify gmail is not in it
    const match = src.match(/const toRestore = \[([^\]]+)\]/);
    assert.ok(match, 'Expected to find toRestore array in bin/index.js');
    assert.ok(!match[1].includes("'gmail'"),
      'gmail should not be in toRestore list');
  });

  it('restoreMcpServers does not list google-calendar in toRestore', () => {
    const src = readFileSync(join(ROOT, 'bin', 'index.js'), 'utf-8');
    const match = src.match(/const toRestore = \[([^\]]+)\]/);
    assert.ok(match);
    assert.ok(!match[1].includes("'google-calendar'"),
      'google-calendar should not be in toRestore list');
  });
});

// ─── Documentation ──────────────────────────────────────────────────────────

describe('CLAUDE.md documentation', () => {
  const rootMd = readFileSync(join(ROOT, 'CLAUDE.md'), 'utf-8');

  it('documents the standalone Gmail/Calendar path (Option A)', () => {
    assert.ok(rootMd.includes('@gongrzhe'),
      'CLAUDE.md should still document the standalone gmail/calendar MCPs');
  });

  it('references workspace-mcp or google_workspace', () => {
    assert.ok(
      rootMd.includes('workspace-mcp') || rootMd.includes('google_workspace'),
      'CLAUDE.md should reference the new workspace-mcp server'
    );
  });

  it('documents --tool-tier flag', () => {
    assert.ok(rootMd.includes('--tool-tier'),
      'CLAUDE.md should document the --tool-tier option');
  });

  it('mentions Drive as a capability', () => {
    assert.ok(rootMd.includes('Drive'),
      'CLAUDE.md should mention Google Drive as a capability');
  });
});

describe('template-v2/CLAUDE.md documentation', () => {
  const templateMd = readFileSync(join(ROOT, 'template-v2', 'CLAUDE.md'), 'utf-8');

  it('documents the standalone Gmail/Calendar path (Option A)', () => {
    assert.ok(templateMd.includes('@gongrzhe'),
      'template-v2/CLAUDE.md should still document the standalone gmail/calendar MCPs');
  });

  it('references workspace-mcp or google_workspace', () => {
    assert.ok(
      templateMd.includes('workspace-mcp') || templateMd.includes('google_workspace'),
      'template-v2/CLAUDE.md should reference the new workspace-mcp server'
    );
  });
});

// ─── Skills ─────────────────────────────────────────────────────────────────

// These read from template-v2/, which is the copy that actually ships to users.
// The repo root has its own partial .claude/ used for developing Claudia itself;
// asserting against that one tested a file no user ever receives.

describe('connector-discovery skill', () => {
  const skill = readFileSync(
    join(ROOT, 'template-v2', '.claude', 'skills', 'connector-discovery.md'), 'utf-8'
  );

  it('recommends a supported Gmail connector', () => {
    assert.ok(skill.includes('@gongrzhe/server-gmail-autoauth-mcp'),
      'connector-discovery should point at the Gmail MCP documented in CLAUDE.md');
  });
});

describe('inbox-check skill', () => {
  const skill = readFileSync(
    join(ROOT, 'template-v2', '.claude', 'skills', 'inbox-check', 'SKILL.md'), 'utf-8'
  );

  // inbox-check detects gmail.* tools generically, so it works with either
  // integration path rather than naming a specific server.
  it('detects gmail tools generically', () => {
    assert.ok(/gmail/i.test(skill),
      'inbox-check should reference gmail tools');
  });
});
