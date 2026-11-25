import { Router } from 'express';
import { me, requireRole } from '../auth';
import { config } from '../config';
import { pool, rows } from '../db';
import { sendPendingEmails } from '../email';
import { addLog, getUser } from '../logic';
import { LogLevel } from '../types';
import { HttpError } from '../utils';

export const miscRoutes = Router();

/** POST /api/notifications/read-all  marks the signed-in user's notifications as read. */
miscRoutes.post('/notifications/read-all', async (req, res) => {
  await pool.query('UPDATE notifications SET read = true WHERE user_id = $1 AND NOT read', [me(req).id]);
  res.status(204).end();
});

/** DELETE /api/notifications  clears all of the signed-in user's notifications. */
miscRoutes.delete('/notifications', async (req, res) => {
  await pool.query('DELETE FROM notifications WHERE user_id = $1', [me(req).id]);
  res.status(204).end();
});

/** DELETE /api/notifications/:id  removes one of the signed-in user's notifications. */
miscRoutes.delete('/notifications/:id', async (req, res) => {
  await pool.query('DELETE FROM notifications WHERE id = $1 AND user_id = $2', [req.params.id, me(req).id]);
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

/**
 * POST /api/emails  (admin)  { recipientIds, subject, message }  emails the admin's own message to the chosen accounts.
 * Accounts without an email address are skipped and named in the reply: { queued, skipped }.
 */
miscRoutes.post('/emails', requireRole('admin'), async (req, res) => {
  const { recipientIds, subject, message } = req.body ?? {};
  if (!config.smtp.host) throw new HttpError(400, 'Email is not set up. Fill in the SMTP settings in zeroproxy-backend/.env.');
  if (!Array.isArray(recipientIds) || recipientIds.length === 0 || !recipientIds.every((id) => typeof id === 'string')) {
    throw new HttpError(400, 'Choose at least one person.');
  }
  if (typeof subject !== 'string' || !subject.trim()) throw new HttpError(400, 'Write a subject.');
  if (typeof message !== 'string' || !message.trim()) throw new HttpError(400, 'Write a message.');

  const recipients = await rows<{ id: string; name: string; email: string | null }>(
    pool,
    'SELECT id, name, email FROM users WHERE id = ANY($1::text[]) ORDER BY name',
    [recipientIds],
  );
  const withEmail = recipients.filter((r) => r.email?.trim());
  const skipped = recipients.filter((r) => !r.email?.trim()).map((r) => r.name);

  for (const r of withEmail) {
    await pool.query('INSERT INTO email_outbox (recipient_id, subject, body) VALUES ($1, $2, $3)', [
      r.id,
      subject.trim().slice(0, 200),
      `${message.trim().slice(0, 10_000)}\n\nZeroProxy`,
    ]);
  }
  const admin = await getUser(pool, me(req).id);
  await addLog(pool, 'info', `[${admin?.login_id}] queued email "${subject.trim()}" to ${withEmail.length} person(s)`);

  // Send straight away instead of waiting for the next 15-second round.
  sendPendingEmails().catch((err) => console.error('Sending emails failed:', err));
  res.json({ queued: withEmail.length, skipped });
});

