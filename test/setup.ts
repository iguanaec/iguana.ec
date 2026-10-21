import { applyD1Migrations, env, type D1Migration } from 'cloudflare:test';

const e = env as unknown as { DB: D1Database; TEST_MIGRATIONS: D1Migration[] };
await applyD1Migrations(e.DB, e.TEST_MIGRATIONS);
