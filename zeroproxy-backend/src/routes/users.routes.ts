import bcrypt from 'bcryptjs';
import { Router } from 'express';
import { me, requireRole } from '../auth';
import { one, pool, transaction } from '../db';
import { normalizedEmbedding } from '../faces';
import {
  addLog,
  childIdsOf,
  classIdsOf,
  getClass,
  getUser,
  newLoginId,
} from '../logic';
import { Role, toUser, UserRow } from '../types';
import { HttpError, newId, param } from '../utils';

export const userRoutes = Router();

const ROLES: Role[] = ['admin', 'teacher', 'parent', 'student'];
const optional = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);

/**
 * POST /api/users  (admin) creates an account. Its ID is generated: each role counts up from 1
 * (students 1…, parents p1…, teachers t1…, admins a1…) and IDs of deleted accounts are never reused.
 */
userRoutes.post('/users', requireRole('admin'), async (req, res) => {
  const { name, password, role, email, phone, childIds, classIds, faceEmbedding: rawFaceEmbedding } = req.body ?? {};
  if (typeof name !== 'string' || !name.trim()) throw new HttpError(400, 'Enter the full name.');
  if (typeof password !== 'string' || password.length < 6) throw new HttpError(400, 'The password needs at least 6 characters.');
  if (!ROLES.includes(role)) throw new HttpError(400, 'Choose a valid role.');
  if (rawFaceEmbedding !== undefined && role !== 'student') {
    throw new HttpError(400, 'Face templates can only be attached to student accounts.');
  }
  const faceEmbedding = rawFaceEmbedding === undefined ? undefined : normalizedEmbedding(rawFaceEmbedding);

  const children: UserRow[] = [];
  if (role === 'parent') {
    const ids: unknown[] = Array.isArray(childIds) ? childIds : [];
    for (const childId of new Set(ids)) {
      const child = typeof childId === 'string' ? await getUser(pool, childId) : undefined;
      if (!child || child.role !== 'student') throw new HttpError(400, 'One of the chosen children is not a student.');
      children.push(child);
    }
    if (children.length === 0) throw new HttpError(400, 'Choose at least one child for this parent account.');
  }
  const classes: string[] = [];
  if (role === 'student' && Array.isArray(classIds)) {
    for (const classId of new Set(classIds as unknown[])) {
      const schoolClass = typeof classId === 'string' ? await getClass(pool, classId) : undefined;
      if (!schoolClass) throw new HttpError(400, 'One of the chosen classes does not exist.');
      classes.push(schoolClass.id);
    }
  }

  const id = newId();
  const passwordHash = await bcrypt.hash(password, 10);
  await transaction(async (db) => {
    // Lock the accounts table briefly so two accounts created at the same moment can't get the same ID.
    await db.query('LOCK TABLE users IN SHARE ROW EXCLUSIVE MODE');
    const login = await newLoginId(db, role);
    await db.query(
      'INSERT INTO users (id, name, login_id, password_hash, role, email, phone) VALUES ($1, $2, $3, $4, $5, $6, $7)',
      [id, name.trim(), login, passwordHash, role, optional(email), optional(phone)],
    );
    if (faceEmbedding) {
      await db.query(
        `INSERT INTO face_embeddings (student_id, embedding, model)
         VALUES ($1, $2::jsonb, 'buffalo_l')`,
        [id, JSON.stringify(faceEmbedding)],
      );
    }
    for (const child of children) {
      await db.query('INSERT INTO parent_children (parent_id, student_id) VALUES ($1, $2)', [id, child.id]);
    }
    for (const classId of classes) {
      await db.query('INSERT INTO class_students (class_id, student_id) VALUES ($1, $2)', [classId, id]);
    }
    await addLog(db, 'info', `Account created: ${name.trim()} (${role}, ID ${login})`);
  });
  res.status(201).json(toUser((await getUser(pool, id))!, role === 'parent' ? children.map((c) => c.id) : classes));
});

/** PostgreSQL pattern matching `text` as a whole word, so removing "Ali" leaves "Alia" alone. */
const wholeWord = (text: string) => `(?<!\\w)${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?!\\w)`;

/**
 * DELETE /api/users/:id  (admin) deletes an account and everything about it. The database removes its
 * class places, attendance, face template, parent links and notifications (ON DELETE CASCADE). Text that
 * only names the person is cleaned here: alerts sent to parents and teachers are removed, and the logs
 * keep their entries with the person's details replaced.
 */
userRoutes.delete('/users/:id', requireRole('admin'), async (req, res) => {
  if (param(req.params.id) === me(req).id) throw new HttpError(400, 'You cannot delete your own account.');
  await transaction(async (db) => {
    const user = await one<UserRow>(db, 'DELETE FROM users WHERE id = $1 RETURNING *', [param(req.params.id)]);
    if (!user) throw new HttpError(404, 'Account not found.');
    if (user.role === 'student') {
      await db.query(
        `DELETE FROM notifications
         WHERE (kind IN ('late', 'absent') AND starts_with(message, $1)) OR (kind = 'limit' AND starts_with(message, $2))`,
        [`${user.name} was marked `, `${user.name} has `],
      );
    }
    for (const detail of [user.name, user.email, user.phone]) {
      if (!detail) continue;
      await db.query(`UPDATE logs SET message = regexp_replace(message, $1, '[deleted user]', 'g') WHERE message ~ $1`, [wholeWord(detail)]);
    }
    await addLog(db, 'warning', `Account deleted: [deleted user] (${user.role})`);
  });
  res.status(204).end();
});

/** The class and student named in /classes/:id/students/:studentId, checked. */
async function classAndStudent(classId: string, studentId: string) {
  const schoolClass = await getClass(pool, classId);
  if (!schoolClass) throw new HttpError(404, 'Class not found.');
  const student = await getUser(pool, studentId);
  if (!student || student.role !== 'student') throw new HttpError(404, 'Student not found.');
  return { schoolClass, student };
}

/** PUT /api/classes/:id/students/:studentId  (admin) adds a student to a class (a student can be in several). */
userRoutes.put('/classes/:id/students/:studentId', requireRole('admin'), async (req, res) => {
  const { schoolClass, student } = await classAndStudent(param(req.params.id), param(req.params.studentId));
  await pool.query('INSERT INTO class_students (class_id, student_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [
    schoolClass.id,
    student.id,
  ]);
  await addLog(pool, 'info', `Student ${student.name} added to ${schoolClass.name}`);
  res.json(toUser(student, await classIdsOf(pool, student.id)));
});

/** DELETE /api/classes/:id/students/:studentId  (admin) removes a student from a class. */
userRoutes.delete('/classes/:id/students/:studentId', requireRole('admin'), async (req, res) => {
  const { schoolClass, student } = await classAndStudent(param(req.params.id), param(req.params.studentId));
  await pool.query('DELETE FROM class_students WHERE class_id = $1 AND student_id = $2', [schoolClass.id, student.id]);
  await addLog(pool, 'info', `Student ${student.name} removed from ${schoolClass.name}`);
  res.json(toUser(student, await classIdsOf(pool, student.id)));
});

/** The parent and student named in /users/:id/children/:studentId, checked. */
async function parentAndChild(parentId: string, studentId: string) {
  const parent = await getUser(pool, parentId);
  if (!parent || parent.role !== 'parent') throw new HttpError(404, 'Parent not found.');
  const student = await getUser(pool, studentId);
  if (!student || student.role !== 'student') throw new HttpError(404, 'Student not found.');
  return { parent, student };
}

/** PUT /api/users/:id/children/:studentId  (admin) links a parent to one more student. */
userRoutes.put('/users/:id/children/:studentId', requireRole('admin'), async (req, res) => {
  const { parent, student } = await parentAndChild(param(req.params.id), param(req.params.studentId));
  await pool.query('INSERT INTO parent_children (parent_id, student_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [
    parent.id,
    student.id,
  ]);
  await addLog(pool, 'info', `${parent.name} linked to ${student.name}`);
  res.json(toUser(parent, await childIdsOf(pool, parent.id)));
});

/** DELETE /api/users/:id/children/:studentId  (admin) unlinks a parent from a student. */
userRoutes.delete('/users/:id/children/:studentId', requireRole('admin'), async (req, res) => {
  const { parent, student } = await parentAndChild(param(req.params.id), param(req.params.studentId));
  await pool.query('DELETE FROM parent_children WHERE parent_id = $1 AND student_id = $2', [parent.id, student.id]);
  await addLog(pool, 'info', `${parent.name} unlinked from ${student.name}`);
  res.json(toUser(parent, await childIdsOf(pool, parent.id)));
});
