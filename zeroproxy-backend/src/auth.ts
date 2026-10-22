import { RequestHandler } from 'express';
import jwt from 'jsonwebtoken';
import { config } from './config';
import { one, pool } from './db';
import { Role } from './types';
import { HttpError } from './utils';

export interface AuthInfo {
  id: string;
  role: Role;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** The signed-in user, set by requireAuth. */
      auth?: AuthInfo;
    }
  }
}

export function signToken(user: AuthInfo): string {
  return jwt.sign({ sub: user.id, role: user.role }, config.jwtSecret, { expiresIn: '12h' });
}

/** Rejects requests without a valid login token. */
export const requireAuth: RequestHandler = async (req, _res, next) => {
  const header = req.headers.authorization ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token) throw new HttpError(401, 'Please sign in.');

  let userId: string;
  try {
    userId = String((jwt.verify(token, config.jwtSecret) as jwt.JwtPayload).sub);
  } catch {
    throw new HttpError(401, 'Your session has expired. Please sign in again.');
  }

  // The account may have been deleted since the token was issued.
  const user = await one<AuthInfo>(pool, 'SELECT id, role FROM users WHERE id = $1', [userId]);
  if (!user) throw new HttpError(401, 'Your account no longer exists.');

  req.auth = user;
  next();
};

/** Only lets through users with one of the given roles. */
export const requireRole =
  (...roles: Role[]): RequestHandler =>
  (req, _res, next) => {
    if (!req.auth || !roles.includes(req.auth.role)) throw new HttpError(403, 'You are not allowed to do that.');
    next();
  };

/** The signed-in user (only call after requireAuth). */
export function me(req: { auth?: AuthInfo }): AuthInfo {
  if (!req.auth) throw new HttpError(401, 'Please sign in.');
  return req.auth;
}
