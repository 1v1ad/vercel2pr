// src/server.js — shim for backward compatibility
// If something still launches src/server.js, delegate to the root server.
// Ensures dotenv is loaded without the legacy '.js' suffix.

import 'dotenv/config';

// Delegate to the root server.js (ESM dynamic import to avoid path resolution issues)
import('../server.js').catch((err) => {
  console.error('[src/server.js] Failed to import root server.js:', err && err.message || err);
  process.exit(1);
});
