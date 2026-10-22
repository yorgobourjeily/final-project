// npm run reset-db  -> recreates the tables' contents with the demo data.
import { ensureDatabase, pool } from './db';
import { SCHEMA } from './schema';
import { seedDemoData } from './seed';

(async () => {
  await ensureDatabase();
  await pool.query(SCHEMA);
  await seedDemoData();
  console.log('Database reset with demo data.');
  await pool.end();
})().catch((err) => {
  console.error('Reset failed:', err.message ?? err);
  process.exit(1);
});
