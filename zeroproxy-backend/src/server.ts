import cors from 'cors';
import express, { ErrorRequestHandler } from 'express';
import { requireAuth } from './auth';
import { config } from './config';
import { ensureDatabase, one, pool } from './db';
import { autoMarkAbsentToday, backfillLoginIds } from './logic';
import { attendanceRoutes } from './routes/attendance.routes';
import { authRoutes } from './routes/auth.routes';
import { classRoutes } from './routes/classes.routes';
import { miscRoutes } from './routes/misc.routes';
import { scanRoutes } from './routes/scan.routes';
import { stateRoutes } from './routes/state.routes';
import { userRoutes } from './routes/users.routes';
import { SCHEMA } from './schema';
import { seedDemoData } from './seed';
import { HttpError } from './utils';

const app = express();
app.use(cors());
app.use(express.json());

app.get('/api/health', async (_req, res) => {
  await pool.query('SELECT 1');
  res.json({ status: 'ok', database: config.db.database });
});

// Login is public, scans check the camera's device key; everything after requireAuth needs a login token.
app.use('/api', authRoutes, scanRoutes);
app.use('/api', requireAuth, stateRoutes, attendanceRoutes, classRoutes, userRoutes, miscRoutes);

app.use('/api', (_req, _res) => {
  throw new HttpError(404, 'Not found.');
});

const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  if (err?.type === 'entity.parse.failed') {
    res.status(400).json({ error: 'The request body is not valid JSON.' });
    return;
  }
  if (err?.code === '23505') {
    res.status(400).json({ error: 'That value is already in use.' });
    return;
  }
  console.error(err);
  res.status(500).json({ error: 'Something went wrong on the server.' });
};
app.use(errorHandler);

async function main() {
  if (!config.db.password) {
    console.warn('PGPASSWORD is empty. Set your PostgreSQL password in zeroproxy-backend/.env if the connection fails.');
  }
  await ensureDatabase();
  await pool.query(SCHEMA);

  const users = await one<{ count: number }>(pool, 'SELECT count(*)::int AS count FROM users');
  if (!users?.count) {
    console.log('Empty database: loading demo data…');
    await seedDemoData();
  }
  await backfillLoginIds();
  if (!config.deviceKey) console.warn('DEVICE_KEY is empty: the camera machine cannot send scans. Set it in zeroproxy-backend/.env.');

  // Students who haven't scanned in by their class's late cutoff are marked absent automatically.
  const runAutoAbsent = () => autoMarkAbsentToday().catch((err) => console.error('Auto-absent failed:', err));
  await runAutoAbsent();
  setInterval(runAutoAbsent, 60_000);

  app.listen(config.port, () => {
    console.log(`ZeroProxy API running on http://localhost:${config.port}  (database "${config.db.database}")`);
  });
}

main().catch((err) => {
  if (err?.code === '28P01') {
    console.error('PostgreSQL rejected the password. Set PGPASSWORD in zeroproxy-backend/.env.');
  } else if (err?.code === 'ECONNREFUSED') {
    console.error(`Cannot reach PostgreSQL at ${config.db.host}:${config.db.port}. Is the server running?`);
  } else {
    console.error('Failed to start:', err);
  }
  process.exit(1);
});
