import { Router } from 'express';
import { me, requireRole } from '../auth';
import { pool } from '../db';
import { addLog, getUser } from '../logic';
import { seedDemoData } from '../seed';
import { LogLevel } from '../types';
import { HttpError } from '../utils';

export const miscRoutes = Router();

/** POST /api/notifications/read-all  marks the signed-in user's notifications as read. */
miscRoutes.post('/notifications/read-all', async (req, res) => {
  await pool.query('UPDATE notifications SET read = true WHERE user_id = $1 AND NOT read', [me(req).id]);
  res.status(204).end();
});

/** POST /api/logs  { level, message }  lets the frontend report errors and warnings (e.g. camera problems). */
miscRoutes.post('/logs', async (req, res) => {
  const { level, message } = req.body ?? {};
  const levels: LogLevel[] = ['info', 'warning', 'error'];
  if (!levels.includes(level) || typeof message !== 'string' || !message.trim()) {
    throw new HttpError(400, 'Send a level (info, warning, error) and a message.');
  }
  const user = await getUser(pool, me(req).id);
  await addLog(pool, level, `[${user?.login_id}] ${message.trim().slice(0, 500)}`);
  res.status(204).end();
});

/** POST /api/admin/reset  (admin) deletes everything and reloads the demo data. */
miscRoutes.post('/admin/reset', requireRole('admin'), async (_req, res) => {
  await seedDemoData();
  res.status(204).end();
});
