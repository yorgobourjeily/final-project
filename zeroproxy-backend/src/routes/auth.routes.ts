import bcrypt from 'bcryptjs';
import { Router } from 'express';
import { me, requireAuth, signToken } from '../auth';
import { one, pool } from '../db';
import { getUser } from '../logic';
import { toUser, UserRow } from '../types';
import { HttpError } from '../utils';

export const authRoutes = Router();

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
