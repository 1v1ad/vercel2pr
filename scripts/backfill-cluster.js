import { initDB, closeDB } from '../src/db.js';

try {
  await initDB();
  console.log('[backfill] cluster_id migration completed');
} catch (e) {
  console.error('[backfill] failed:', e?.message || e);
  process.exitCode = 1;
} finally {
  await closeDB().catch(() => {});
}
