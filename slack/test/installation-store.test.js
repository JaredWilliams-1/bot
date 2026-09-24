/**
 * Tests for the file-backed Slack InstallationStore.
 *
 * Locks in the @slack/oauth contract (fetchInstallation throws when nothing is
 * stored) and the keying rules: team installs key on team id, org-wide
 * installs key on enterprise id, and keys are sanitized for filesystem use.
 */

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { FileInstallationStore } from '../installation-store.js';

let baseDir;
let store;

beforeEach(() => {
  baseDir = mkdtempSync(join(tmpdir(), 'claudia-install-test-'));
  store = new FileInstallationStore({ baseDir });
});

afterEach(() => {
  rmSync(baseDir, { recursive: true, force: true });
});

function teamInstallation(teamId, token = 'xoxb-test-token') {
  return {
    team: { id: teamId, name: 'Test Team' },
    enterprise: undefined,
    isEnterpriseInstall: false,
    bot: { token, id: 'B01', userId: 'U0BOT' },
  };
}

test('stores and fetches a team installation round-trip', async () => {
  await store.storeInstallation(teamInstallation('T0AAAA1'));

  const fetched = await store.fetchInstallation({
    teamId: 'T0AAAA1',
    enterpriseId: undefined,
    isEnterpriseInstall: false,
  });
  assert.equal(fetched.bot.token, 'xoxb-test-token');
  assert.equal(fetched.team.id, 'T0AAAA1');
});

test('fetchInstallation throws when nothing is stored (Bolt contract)', async () => {
  await assert.rejects(
    store.fetchInstallation({ teamId: 'T0MISSING', isEnterpriseInstall: false }),
    /No installation found/
  );
});

test('org-wide installs key on the enterprise id, not the team id', async () => {
  await store.storeInstallation({
    team: undefined,
    enterprise: { id: 'E0ORG1', name: 'Test Org' },
    isEnterpriseInstall: true,
    bot: { token: 'xoxb-org-token', id: 'B02', userId: 'U0BOT' },
  });

  const fetched = await store.fetchInstallation({
    teamId: undefined,
    enterpriseId: 'E0ORG1',
    isEnterpriseInstall: true,
  });
  assert.equal(fetched.bot.token, 'xoxb-org-token');
  assert.ok(existsSync(join(baseDir, 'E0ORG1.json')));
});

test('org-wide installs resolve even when the caller also has a teamId', async () => {
  await store.storeInstallation({
    team: undefined,
    enterprise: { id: 'E0ORG1', name: 'Test Org' },
    isEnterpriseInstall: true,
    bot: { token: 'xoxb-org-token', id: 'B02', userId: 'U0BOT' },
  });

  // Events inside a Grid org report the team the message came from alongside
  // the enterprise id, so callers cannot infer the install kind from the ids.
  // Slack's isEnterpriseInstall flag is what must pick the key.
  const fetched = await store.fetchInstallation({
    teamId: 'T0INSIDEORG',
    enterpriseId: 'E0ORG1',
    isEnterpriseInstall: true,
  });
  assert.equal(fetched.bot.token, 'xoxb-org-token');
});

test('a re-install overwrites the previous installation for that workspace', async () => {
  await store.storeInstallation(teamInstallation('T0AAAA1', 'xoxb-old'));
  await store.storeInstallation(teamInstallation('T0AAAA1', 'xoxb-new'));

  const fetched = await store.fetchInstallation({
    teamId: 'T0AAAA1',
    isEnterpriseInstall: false,
  });
  assert.equal(fetched.bot.token, 'xoxb-new');
  assert.equal(readdirSync(baseDir).length, 1);
});

test('deleteInstallation removes the stored file and is idempotent', async () => {
  await store.storeInstallation(teamInstallation('T0AAAA1'));
  await store.deleteInstallation({ teamId: 'T0AAAA1', isEnterpriseInstall: false });

  await assert.rejects(
    store.fetchInstallation({ teamId: 'T0AAAA1', isEnterpriseInstall: false }),
    /No installation found/
  );
  // Second delete of a missing installation must not throw.
  await store.deleteInstallation({ teamId: 'T0AAAA1', isEnterpriseInstall: false });
});

test('keys are sanitized for filesystem use', async () => {
  await store.storeInstallation(teamInstallation('T0/..\\evil'));

  const files = readdirSync(baseDir);
  assert.equal(files.length, 1);
  // Path separators and dots are stripped; the file stays inside baseDir.
  assert.match(files[0], /^[a-zA-Z0-9_-]+\.json$/);

  const fetched = await store.fetchInstallation({
    teamId: 'T0/..\\evil',
    isEnterpriseInstall: false,
  });
  assert.equal(fetched.bot.token, 'xoxb-test-token');
});
