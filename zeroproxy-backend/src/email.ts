import nodemailer from 'nodemailer';
import { config } from './config';
import { pool, rows } from './db';
import { addLog } from './logic';

/** Tries before giving up on an email: about 10 minutes of retries, enough for a short outage. */
const MAX_ATTEMPTS = 40;

interface PendingEmail {
  id: string;
  subject: string;
  body: string;
  attempts: number;
  recipient: string;
  email: string;
}

const transport = nodemailer.createTransport({
  host: config.smtp.host,
  port: config.smtp.port,
  secure: config.smtp.port === 465,
  auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.password } : undefined,
  connectionTimeout: 10_000,
  greetingTimeout: 10_000,
  socketTimeout: 20_000,
});

let sending = false;

/** Sends the queued emails, oldest first. On a mail server problem it stops and retries next time, so nothing is lost. */
export async function sendPendingEmails() {
  if (sending) return;
  sending = true;
  try {
    const pending = await rows<PendingEmail>(
      pool,
      `SELECT o.id, o.subject, o.body, o.attempts, u.name AS recipient, u.email
       FROM email_outbox o JOIN users u ON u.id = o.recipient_id
       ORDER BY o.id LIMIT 20`,
    );
    for (const email of pending) {
      try {
        await transport.sendMail({ from: config.smtp.from, to: email.email, subject: email.subject, text: email.body });
        await pool.query('DELETE FROM email_outbox WHERE id = $1', [email.id]);
        await addLog(pool, 'info', `Email sent to ${email.recipient} (${email.email}): ${email.subject}`);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        const addressRefused = !!(err as { rejected?: string[] }).rejected?.length;
        if (addressRefused || email.attempts + 1 >= MAX_ATTEMPTS) {
          await pool.query('DELETE FROM email_outbox WHERE id = $1', [email.id]);
          await addLog(pool, 'error', `Email to ${email.recipient} (${email.email}) failed and was dropped: ${reason}`);
          continue;
        }
        await pool.query('UPDATE email_outbox SET attempts = attempts + 1 WHERE id = $1', [email.id]);
        if (email.attempts === 0) await addLog(pool, 'warning', `Could not send email, retrying: ${reason}`);
        break;
      }
    }
  } finally {
    sending = false;
  }
}
