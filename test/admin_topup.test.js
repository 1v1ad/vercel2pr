import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import adminRouter from '../src/routes_admin.js';
import { initDB, upsertUser, linkAccounts, getDb, closeDB } from '../src/db.js';

async function withTestDb(fn) {
  process.env.DB_FILE = ':memory:';
  await initDB();
  try {
    await fn();
  } finally {
    await closeDB();
  }
}

test('POST /admin/topup applies balance updates to primary user', async () => {
  await withTestDb(async () => {
    const app = express();
    app.use(express.json());
    app.use(adminRouter);

    const vk = await upsertUser({ provider: 'vk', provider_user_id: '42', name: 'VK Forty Two' });
    const tg = await upsertUser({ provider: 'tg', provider_user_id: '99', name: 'TG Ninety Nine' });
    const personId = await linkAccounts({
      left: { provider: 'vk', provider_user_id: '42' },
      right: { provider: 'tg', provider_user_id: '99' },
    });

    const db = getDb();
    await db.run(`UPDATE persons SET primary_user_id = NULL WHERE id = ?`, [personId]);

    const response = await request(app)
      .post('/admin/topup')
      .send({ user_id: tg.id, amount: 150, reason: 'promo' })
      .expect(200);

    assert.equal(response.body.ok, true);
    assert.equal(response.body.user_id, vk.id);
    assert.equal(response.body.balance, 150);

    const vkRow = await db.get(`SELECT balance FROM users WHERE id = ?`, [vk.id]);
    const tgRow = await db.get(`SELECT balance FROM users WHERE id = ?`, [tg.id]);
    assert.equal(vkRow.balance, 150);
    assert.equal(tgRow.balance, 0);

    const event = await db.get(`SELECT * FROM events ORDER BY id DESC LIMIT 1`);
    assert.equal(event.type, 'balance_update');
    assert.equal(event.user_id, vk.id);
    const meta = JSON.parse(event.meta || '{}');
    assert.equal(meta.requested_user_id, tg.id);
    assert.equal(meta.resolved_user_id, vk.id);
    assert.equal(meta.amount, 150);

    const person = await db.get(`SELECT cluster_id FROM persons WHERE id = ?`, [personId]);
    assert.ok(person.cluster_id);
  });
});
