/**
 * Tests for the composite storage identity helper.
 *
 * These lock in the invariants documented in identity.js: bare-id keys in
 * single-workspace mode (even when Bolt supplies a teamId), namespacing only
 * when multi-tenant is on, enterprise-over-team precedence, and a separator
 * that survives both downstream sanitizers (calendar-client.js and the memory
 * daemon) byte-for-byte.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { storageId, STORAGE_ID_SEPARATOR, isMultiTenant } from '../identity.js';

const MULTI_TENANT_ENV = [
  'SLACK_BOT_CLIENT_ID',
  'SLACK_BOT_CLIENT_SECRET',
  'SLACK_STATE_SECRET',
];

function withEnv(vars, fn) {
  const prev = Object.fromEntries(MULTI_TENANT_ENV.map((k) => [k, process.env[k]]));
  try {
    for (const key of MULTI_TENANT_ENV) {
      if (vars[key] === undefined) delete process.env[key];
      else process.env[key] = vars[key];
    }
    return fn();
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test('returns the bare userId when no team context exists (legacy stores)', () => {
  assert.equal(storageId({ userId: 'U012AB3CD', multiTenant: true }), 'U012AB3CD');
});

test('keeps the bare userId in single-workspace mode even when Bolt sends a teamId', () => {
  assert.equal(
    storageId({ userId: 'U012AB3CD', teamId: 'T0AAAA1', enterpriseId: 'E0ZZZZ9', multiTenant: false }),
    'U012AB3CD'
  );
});

test('namespaces by teamId when multi-tenant is on', () => {
  assert.equal(
    storageId({ userId: 'U012AB3CD', teamId: 'T0AAAA1', multiTenant: true }),
    `T0AAAA1${STORAGE_ID_SEPARATOR}U012AB3CD`
  );
});

test('enterpriseId takes precedence over teamId (org installs)', () => {
  assert.equal(
    storageId({ userId: 'U012AB3CD', teamId: 'T0AAAA1', enterpriseId: 'E0ZZZZ9', multiTenant: true }),
    `E0ZZZZ9${STORAGE_ID_SEPARATOR}U012AB3CD`
  );
});

test('Grid keys stay stable when an event omits the teamId', () => {
  // DM and Home tab events in an Enterprise Grid org may arrive without a
  // team_id, because those surfaces are reachable from any workspace in the
  // org. Keying on the team id first would send the same person's DMs and
  // channel mentions to two different stores.
  const fromDm = storageId({ userId: 'W012AB3CD', enterpriseId: 'E0ORG1', multiTenant: true });
  const fromChannel = storageId({
    userId: 'W012AB3CD',
    teamId: 'T0AAAA1',
    enterpriseId: 'E0ORG1',
    multiTenant: true,
  });

  assert.equal(fromDm, fromChannel);
});

test('the same Grid user is one store across workspaces in the org', () => {
  // Grid user ids are org-global, so these are the same human in two
  // workspaces of one org, not two people who could collide.
  const inWorkspaceA = storageId({
    userId: 'W012AB3CD',
    teamId: 'T0AAAA1',
    enterpriseId: 'E0ORG1',
    multiTenant: true,
  });
  const inWorkspaceB = storageId({
    userId: 'W012AB3CD',
    teamId: 'T0BBBB2',
    enterpriseId: 'E0ORG1',
    multiTenant: true,
  });

  assert.equal(inWorkspaceA, inWorkspaceB);
});

test('unrelated workspaces stay isolated when there is no enterprise', () => {
  const a = storageId({ userId: 'U012AB3CD', teamId: 'T0AAAA1', multiTenant: true });
  const b = storageId({ userId: 'U012AB3CD', teamId: 'T0BBBB2', multiTenant: true });

  assert.notEqual(a, b);
});

test('separate Grid orgs never share a key', () => {
  const orgA = storageId({ userId: 'W012AB3CD', enterpriseId: 'E0ORG1', multiTenant: true });
  const orgB = storageId({ userId: 'W012AB3CD', enterpriseId: 'E0ORG2', multiTenant: true });

  assert.notEqual(orgA, orgB);
});

test('throws without a userId', () => {
  assert.throws(() => storageId({}), /requires a userId/);
  assert.throws(() => storageId(), /requires a userId/);
});

test('separator survives both downstream sanitizers unchanged', () => {
  const key = storageId({ userId: 'U012AB3CD', teamId: 'T0AAAA1', multiTenant: true });

  // calendar-client.js sanitizeUserId(): keep [a-zA-Z0-9_-]
  const jsSanitized = key.replace(/[^a-zA-Z0-9_-]/g, '');
  assert.equal(jsSanitized, key);

  // memory daemon db_manager: keep c.isalnum() or c in "-_"
  const pySanitized = [...key]
    .filter((c) => /[a-zA-Z0-9]/.test(c) || c === '-' || c === '_')
    .join('');
  assert.equal(pySanitized, key);
});

test('distinct team/user pairs never collapse to the same key', () => {
  // The double-underscore separator keeps "T1__U23" and "T12__U3" distinct
  // (a stripped separator like ":" would collapse them to "T1U23" / "T12U3"...
  // which are still distinct, but "T1" + "2U3" vs "T12" + "U3" would not be).
  const a = storageId({ userId: '2U3', teamId: 'T1', multiTenant: true });
  const b = storageId({ userId: 'U3', teamId: 'T12', multiTenant: true });
  assert.notEqual(a, b);
});

test('isMultiTenant requires all three OAuth env vars', () => {
  withEnv({}, () => {
    assert.equal(isMultiTenant(), false);
  });
  withEnv(
    {
      SLACK_BOT_CLIENT_ID: 'id',
      SLACK_BOT_CLIENT_SECRET: 'secret',
      SLACK_STATE_SECRET: 'state',
    },
    () => {
      assert.equal(isMultiTenant(), true);
    }
  );
  withEnv({ SLACK_BOT_CLIENT_ID: 'id', SLACK_BOT_CLIENT_SECRET: 'secret' }, () => {
    assert.equal(isMultiTenant(), false);
  });
});

test('storageId follows env-detected multi-tenant mode when override is omitted', () => {
  withEnv({}, () => {
    assert.equal(
      storageId({ userId: 'U012AB3CD', teamId: 'T0AAAA1' }),
      'U012AB3CD'
    );
  });
  withEnv(
    {
      SLACK_BOT_CLIENT_ID: 'id',
      SLACK_BOT_CLIENT_SECRET: 'secret',
      SLACK_STATE_SECRET: 'state',
    },
    () => {
      assert.equal(
        storageId({ userId: 'U012AB3CD', teamId: 'T0AAAA1' }),
        `T0AAAA1${STORAGE_ID_SEPARATOR}U012AB3CD`
      );
    }
  );
});
