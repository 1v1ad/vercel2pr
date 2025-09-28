import crypto from 'crypto';
import process from 'process';
import { initDB, isPostgres, query, tx } from '../src/db.js';

async function ensureSingles() {
  const { rows } = await query(
    'SELECT id, cluster_id, primary_user_id FROM users WHERE cluster_id IS NULL OR primary_user_id IS NULL ORDER BY id ASC'
  );
  let updated = 0;
  for (const row of rows) {
    const clusterId = row.cluster_id || crypto.randomUUID();
    const primaryId = row.primary_user_id || row.id;
    await query('UPDATE users SET cluster_id = $1, primary_user_id = $2 WHERE id = $3', [clusterId, primaryId, row.id]);
    updated++;
  }
  return updated;
}

async function backfillPersons() {
  const persons = await query(`
    SELECT pl.person_id,
           array_remove(array_agg(u.id), NULL) AS user_ids
    FROM person_links pl
    JOIN users u ON u.provider = pl.provider AND u.provider_user_id = pl.provider_user_id
    GROUP BY pl.person_id
    ORDER BY pl.person_id
  `);

  let processed = 0;
  let updated = 0;

  for (const row of persons.rows) {
    const ids = Array.isArray(row.user_ids) ? row.user_ids.filter(Boolean) : [];
    if (!ids.length) continue;
    processed++;

    await tx(async ({ query }) => {
      const { rows } = await query(
        'SELECT id, cluster_id, primary_user_id FROM users WHERE id = ANY($1::bigint[]) ORDER BY id ASC',
        [ids]
      );
      if (!rows.length) return;

      let clusterId = rows.find((r) => r.cluster_id)?.cluster_id || crypto.randomUUID();
      const primaryId = rows.find((r) => r.primary_user_id)?.primary_user_id || rows[0].id;

      const needsUpdate = rows.some(
        (r) => r.cluster_id !== clusterId || Number(r.primary_user_id || 0) !== Number(primaryId)
      );
      if (!needsUpdate) return;

      await query('UPDATE users SET cluster_id = $1, primary_user_id = $2 WHERE id = ANY($3::bigint[])', [
        clusterId,
        primaryId,
        ids,
      ]);

      await query('INSERT INTO events (user_id, type, meta) VALUES ($1, $2, $3)', [
        primaryId,
        'merge_auto',
        JSON.stringify({ cluster_id: clusterId, user_ids: ids }),
      ]);
      updated++;
    });
  }

  return { processed, updated };
}

async function main() {
  await initDB();

  if (!isPostgres()) {
    console.log('Postgres not configured, skipping backfill');
    return;
  }

  const singles = await ensureSingles();
  const { processed, updated } = await backfillPersons();

  console.log(
    `[backfill] singles updated=${singles}, person_clusters=${processed}, person_updates=${updated}`
  );
}

main().catch((err) => {
  console.error('[backfill] failed', err?.message || err);
  process.exit(1);
});
