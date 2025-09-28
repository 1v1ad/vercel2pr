import test from 'node:test';
import assert from 'node:assert/strict';
import { initDB, upsertUser, linkAccounts, getDb, closeDB } from '../src/db.js';
import { resolvePrimaryUserId } from '../src/merge.js';

async function withTestDb(fn) {
  process.env.DB_FILE = ':memory:';
  await initDB();
  try {
    await fn();
  } finally {
    await closeDB();
  }
}

test('resolvePrimaryUserId returns explicit primary user', async () => {
  await withTestDb(async () => {
    const vk = await upsertUser({ provider: 'vk', provider_user_id: '1', name: 'VK One' });
    const tg = await upsertUser({ provider: 'tg', provider_user_id: '10', name: 'TG Ten' });
    const personId = await linkAccounts({
      left: { provider: 'vk', provider_user_id: '1' },
      right: { provider: 'tg', provider_user_id: '10' },
    });
    const db = getDb();
    await db.run(`UPDATE persons SET primary_user_id = ? WHERE id = ?`, [tg.id, personId]);

    const resolved = await resolvePrimaryUserId(vk.id);
    assert.equal(resolved, tg.id);
  });
});

test('resolvePrimaryUserId prefers VK when no explicit primary', async () => {
  await withTestDb(async () => {
    const vk = await upsertUser({ provider: 'vk', provider_user_id: '2', name: 'VK Two' });
    const tg = await upsertUser({ provider: 'tg', provider_user_id: '20', name: 'TG Twenty' });
    const personId = await linkAccounts({
      left: { provider: 'vk', provider_user_id: '2' },
      right: { provider: 'tg', provider_user_id: '20' },
    });
    const db = getDb();
    await db.run(`UPDATE persons SET primary_user_id = NULL WHERE id = ?`, [personId]);

    const resolved = await resolvePrimaryUserId(tg.id);
    assert.equal(resolved, vk.id);
  });
});

test('resolvePrimaryUserId falls back to earliest account when no VK present', async () => {
  await withTestDb(async () => {
    const email = await upsertUser({ provider: 'email', provider_user_id: 'e1', name: 'Email User' });
    const tg = await upsertUser({ provider: 'tg', provider_user_id: 'tg42', name: 'TG 42' });
    const personId = await linkAccounts({
      left: { provider: 'email', provider_user_id: 'e1' },
      right: { provider: 'tg', provider_user_id: 'tg42' },
    });
    const db = getDb();
    await db.run(`UPDATE persons SET primary_user_id = NULL WHERE id = ?`, [personId]);
    await db.run(`UPDATE users SET created_at = ? WHERE id = ?`, ['2000-01-01T00:00:00Z', email.id]);
    await db.run(`UPDATE users SET created_at = ? WHERE id = ?`, ['2010-01-01T00:00:00Z', tg.id]);

    const resolved = await resolvePrimaryUserId(tg.id);
    assert.equal(resolved, email.id);
  });
});
