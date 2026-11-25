import bcrypt from 'bcryptjs';
import { Router } from 'express';
import { me, requireAuth, signToken } from '../auth';
import { one, pool, transaction } from '../db';
import { addLog, getUser, newLoginId } from '../logic';
import { toUser, UserRow } from '../types';
import { HttpError, newId } from '../utils';

export const authRoutes = Router();

/** GET /api/setup/status -> whether an initial administrator still needs to be created. */
authRoutes.get('/setup/status', async (_req, res) => {
  const result = await one<{ has_users: boolean }>(pool, 'SELECT EXISTS (SELECT 1 FROM users) AS has_users');
  res.json({ setupRequired: !result?.has_users });
});

/** POST /api/setup/admin creates the first administrator, only while the users table is empty. */
authRoutes.post('/setup/admin', async (req, res) => {
  const { name, password } = req.body ?? {};
  if (typeof name !== 'string' || !name.trim()) throw new HttpError(400, 'Enter the administrator name.');
  if (typeof password !== 'string' || password.length < 8) {
    throw new HttpError(400, 'Choose a password with at least 8 characters.');
  }

  const id = newId();
  const passwordHash = await bcrypt.hash(password, 10);
  await transaction(async (db) => {
    await db.query('LOCK TABLE users IN SHARE ROW EXCLUSIVE MODE');
    const existing = await one<{ has_users: boolean }>(db, 'SELECT EXISTS (SELECT 1 FROM users) AS has_users');
    if (existing?.has_users) throw new HttpError(409, 'Initial setup is already complete. Refresh and sign in.');

    const loginId = await newLoginId(db, 'admin');
    await db.query(
      'INSERT INTO users (id, name, login_id, password_hash, role) VALUES ($1, $2, $3, $4, $5)',
      [id, name.trim(), loginId, passwordHash, 'admin'],
    );
    await addLog(db, 'info', `Initial administrator created: ${name.trim()} (ID ${loginId})`);
  });

  const user = await getUser(pool, id);
  if (!user) throw new HttpError(500, 'The administrator account could not be loaded.');
  res.status(201).json({ user: toUser(user) });
});

/** POST /api/auth/login  { id, password } -> { token, user }   (id: "2", "t1", "p2", "a1") */
authRoutes.post('/auth/login', async (req, res) => {
  const { id, password } = req.body ?? {};
  if (typeof id !== 'string' || typeof password !== 'string' || !id.trim() || !password) {
    throw new HttpError(400, 'Enter your ID and password.');
  }

  const user = await one<UserRow>(pool, 'SELECT * FROM users WHERE login_id = $1', [id.trim().toLowerCase()]);
  if (!user || !(await bcrypt.compare(password, user.password_hash))) {
    throw new HttpError(401, 'Wrong ID or password.');
  }
  res.json({ token: signToken(user), user: toUser(user) });
});

/** GET /api/auth/me -> the signed-in user */
authRoutes.get('/auth/me', requireAuth, async (req, res) => {
  const user = await getUser(pool, me(req).id);
  if (!user) throw new HttpError(401, 'Your account no longer exists.');
  res.json(toUser(user));
});
