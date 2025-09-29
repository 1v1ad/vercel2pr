#!/usr/bin/env node
import { initDB, query, tx } from '../src/db.js';
import { autoMergeAccounts } from '../src/merge.js';

async function ensureSelfPrimary() {
  return tx(async (client) => {
    const res = await client.query('UPDATE users SET primary_user_id = id WHERE primary_user_id IS NULL');
    return res.rowCount || 0;
  });
}

async function backfillFromPersonLinks() {
  const { rows } = await query(
    'SELECT person_id FROM person_links GROUP BY person_id HAVING COUNT(*) > 1 ORDER BY person_id ASC'
  );
  let processed = 0;
  let merged = 0;

  for (const row of rows) {
    const personId = row.person_id;
    const links = await query(
      `SELECT u.id
         FROM person_links pl
         JOIN users u ON u.provider = pl.provider AND u.provider_user_id = pl.provider_user_id
        WHERE pl.person_id = $1
        ORDER BY u.id ASC`,
      [personId]
    );
    const ids = Array.from(new Set((links.rows || []).map((r) => Number(r.id)).filter(Boolean)));
    if (ids.length < 2) continue;
    processed++;
    const result = await autoMergeAccounts({
      userIds: ids,
      reason: 'backfill',
      meta: { person_id: personId, source: 'backfill_cluster' },
    });
    if (result.merged) merged++;
  }

  return { processed, merged };
}

async function main() {
  await initDB();
  console.log('[backfill] starting');

  const selfPrimaries = await ensureSelfPrimary();
  if (selfPrimaries) {
    console.log(`[backfill] set primary_user_id=id for ${selfPrimaries} users`);
  }

  const { processed, merged } = await backfillFromPersonLinks();
  console.log(`[backfill] processed groups=${processed}, merged=${merged}`);
  console.log('[backfill] done');
}

main().catch((err) => {
  console.error('[backfill] fatal', err);
  process.exitCode = 1;
});
