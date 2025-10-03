Patch bundle for vercel2pr
==========================

This bundle contains:
- package.json (scripts.start = "node server.js", ESM enabled)
- src/server.js shim that loads dotenv/config and delegates to the root server.js

After applying:
1) Ensure the first line of the *root* server.js is:
   import 'dotenv/config';

2) On Render:
   - Settings → Start Command: `node server.js`
   - Manual Deploy → Clear build cache & deploy
