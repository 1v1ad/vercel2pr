#!/usr/bin/env node
import crypto from 'crypto';
import { initDB, closeDB, isPostgres, query } from '../src/db.js';
import { autoMergeAccounts } from '../src/merge.js';

function pickPrimary(members) {
  const ids = members.map((m) => Number(m.user_id));
  const explicit = members.find((m) => m.primary_user_id && ids.includes(Number(m.primary_user_id)));
  if (explicit) return Number(explicit.primary_user_id);
  const vk = members.find((m) => m.provider === 'vk');
  if (vk) return Number(vk.user_id);
  try {
    return members
      .slice()
      .sort((a, b) => {
        const ta = a.created_at ? new Date(a.created_at).getTime() : 0;
        const tb = b.created_at ? new Date(b.created_at).getTime() : 0;
        if (ta && tb && ta !== tb) return ta - tb;
        return Number(a.user_id) - Number(b.user_id);
      })[0].user_id;
  } catch {
    return Number(members[0].user_id);
  }
}

async function main() {
  await initDB();
  if (!isPostgres()) {
    console.log('Postgres not configured, skipping backfill');
    return;
  }

  const { rows } = await query(`
    SELECT
      pl.person_id,
      u.id AS user_id,
      u.provider,
      u.provider_user_id,
      u.cluster_id,
      u.primary_user_id,
      u.created_at
    FROM person_links pl
    JOIN users u
      ON u.provider = pl.provider AND u.provider_user_id = pl.provider_user_id
    ORDER BY pl.person_id, u.id
  `);

  const groups = new Map();
  for (const row of rows) {
    const key = row.person_id;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }

  let processed = 0;
  for (const [personId, members] of groups.entries()) {
    if (!members.length) continue;
    const clusterValues = Array.from(new Set(members.map((m) => m.cluster_id).filter(Boolean)));
    const targetCluster = clusterValues.length === 1 ? clusterValues[0] : null;
    const primary = pickPrimary(members);

    const allClusterMatch = targetCluster
      ? members.every((m) => m.cluster_id === targetCluster)
      : members.every((m) => !m.cluster_id);
    const allPrimaryMatch = members.every((m) => Number(m.primary_user_id || 0) === Number(primary));

    if (allClusterMatch && allPrimaryMatch) {
      continue;
    }

    const desiredCluster = targetCluster || crypto.randomUUID();
    const ids = members.map((m) => Number(m.user_id));
    await autoMergeAccounts({
      userIds: ids,
      clusterId: desiredCluster,
      preferredPrimaryId: primary,
      meta: { person_id: personId },
    });
    processed += 1;
    console.log(`[backfill] person ${personId} → cluster ${desiredCluster} primary ${primary}`);
  }

  console.log(`Backfill complete, processed ${processed} group(s)`);
}

main()
  .catch((err) => {
    console.error('Backfill failed:', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDB();
  });
