import { readFileSync } from 'node:fs';
import { config } from './config.js';
import { postgres, Store } from './store.js';
import { approveRollout } from './rollout.js';
const c = config(), file = process.argv[2];
if (!file || !c.databaseUrl) throw new Error('Usage: npm run approve-rollout -- path/to/review.json (DATABASE_URL required)');
const store = new Store(postgres(c.databaseUrl));
try { console.log(await approveRollout(store, c, JSON.parse(readFileSync(file, 'utf8')))); }
finally { await store.db.close(); }
