import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';

process.env.DB_FILE = ':memory:';
process.env.ADMIN_PASSWORD = 'secret-admin';

const dbModule = await import('../src/db.js');
const { initDB, closeDB, upsertUser, db, linkAccounts } = dbModule;
const { resolvePrimaryUserId } = await import('../src/merge.js');
const adminRouter = (await import('../src/routes_admin.js')).default;

async function seedLinkedAccounts() {
  await initDB();
  const tg = await upsertUser({ provider: 'tg', provider_user_id: 'tg-1', name: 'TG', avatar: '' });
  const vk = await upsertUser({ provider: 'vk', provider_user_id: 'vk-1', name: 'VK', avatar: '' });
  await linkAccounts({
    left: { provider: 'vk', provider_user_id: 'vk-1' },
    right: { provider: 'tg', provider_user_id: 'tg-1' },
  });
  const row = await db.get(
    `SELECT person_id FROM person_links WHERE provider = 'vk' AND provider_user_id = ?`,
    ['vk-1']
  );
  return { tg, vk, personId: row.person_id };
}

test('resolvePrimaryUserId prefers explicit primary then VK', { concurrency: 1 }, async (t) => {
  await closeDB();
  const { tg, vk, personId } = await seedLinkedAccounts();

  await db.run(`UPDATE persons SET primary_user_id = ? WHERE id = ?`, [tg.id, personId]);
  assert.equal(await resolvePrimaryUserId(vk.id), tg.id);

  await db.run(`UPDATE persons SET primary_user_id = NULL WHERE id = ?`, [personId]);
  assert.equal(await resolvePrimaryUserId(tg.id), vk.id);

  const solo = await upsertUser({ provider: 'tg', provider_user_id: 'tg-2', name: 'Solo', avatar: '' });
  assert.equal(await resolvePrimaryUserId(solo.id), solo.id);

  await closeDB();
  t.pass();
});

test('POST /admin/topup writes balance to primary user', { concurrency: 1 }, async (t) => {
  await closeDB();
  await initDB();

  const tg = await upsertUser({ provider: 'tg', provider_user_id: 'tg-100', name: 'TG', avatar: '' });
  const vk = await upsertUser({ provider: 'vk', provider_user_id: 'vk-100', name: 'VK', avatar: '' });
  await linkAccounts({
    left: { provider: 'vk', provider_user_id: 'vk-100' },
    right: { provider: 'tg', provider_user_id: 'tg-100' },
  });

  const app = express();
  app.use(express.json());
  app.use(adminRouter);

  const res = await request(app)
    .post('/admin/topup')
    .set('Authorization', 'Bearer secret-admin')
    .send({ user_id: tg.id, amount: 50, reason: 'test topup' });

  assert.equal(res.status, 200);
  const primaryId = await resolvePrimaryUserId(tg.id);
  assert.equal(res.body.user_id, primaryId);
  assert.equal(res.body.balance, 50);

  const primaryRow = await db.get(`SELECT balance FROM users WHERE id = ?`, [primaryId]);
  const secondaryRow = await db.get(`SELECT balance FROM users WHERE id = ?`, [tg.id]);
  assert.equal(primaryRow.balance, 50);
  assert.equal(secondaryRow.balance, 0);

  const event = await db.get(
    `SELECT type, meta FROM events WHERE type = 'balance_update' ORDER BY id DESC LIMIT 1`
  );
  assert.equal(event?.type, 'balance_update');
  const meta = event?.meta ? JSON.parse(event.meta) : {};
  assert.equal(meta.primary_user_id, primaryId);
  assert.equal(meta.requested_user_id, tg.id);
  assert.equal(meta.amount, 50);

  await closeDB();
  t.pass();
});
