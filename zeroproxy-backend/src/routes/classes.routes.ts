import { Router } from 'express';
import { me, requireRole } from '../auth';
import { one, pool, rows } from '../db';
import { addLog, getClass, getUser } from '../logic';
import { ClassRow, toClass } from '../types';
import { HttpError, isTime, newId, toMinutes, param } from '../utils';
import { assertTeaches } from './attendance.routes';

export const classRoutes = Router();

interface ClassInput {
  name: string;
  startTime: string;
  endTime: string;
  lateAfterMinutes: number;
  maxAbsences: number;
  /** Days of the week: 0 = Sunday … 6 = Saturday. */
  days: number[];
}

const DAYS_TEXT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const daysText = (days: number[]) => [...days].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7)).map((d) => DAYS_TEXT[d]).join(', ');

/** Returns an error message, or null when the class details are valid. */
function validateClass(c: ClassInput): string | null {
  if (typeof c.name !== 'string' || !c.name.trim()) return 'Give the class a name.';
  if (!isTime(c.startTime) || !isTime(c.endTime)) return 'Enter the start and end times as HH:mm.';
  if (toMinutes(c.endTime) <= toMinutes(c.startTime)) return 'The end time must be after the start time.';
  if (!Number.isInteger(c.lateAfterMinutes) || c.lateAfterMinutes < 0) return 'Late after must be 0 minutes or more.';
  if (!Number.isInteger(c.maxAbsences) || c.maxAbsences < 1) return 'Maximum absences must be at least 1.';
  if (!Array.isArray(c.days) || c.days.length === 0) return 'Choose at least one day of the week.';
  if (!c.days.every((d) => Number.isInteger(d) && d >= 0 && d <= 6)) return 'Days must be 0 (Sunday) to 6 (Saturday).';
  return null;
}

async function nameTaken(name: string, exceptId?: string) {
  return !!(await one(pool, 'SELECT 1 FROM classes WHERE lower(name) = lower($1) AND id <> $2', [name.trim(), exceptId ?? '']));
}

async function classResponse(id: string) {
  const c = (await getClass(pool, id))!;
  const teachers = await rows<{ teacher_id: string }>(pool, 'SELECT teacher_id FROM class_teachers WHERE class_id = $1', [id]);
  return toClass(c, teachers.map((t) => t.teacher_id));
}

/** POST /api/classes  (admin) */
classRoutes.post('/classes', requireRole('admin'), async (req, res) => {
  const input = { days: [1, 2, 3, 4, 5], ...(req.body ?? {}) } as ClassInput;
  const error = validateClass(input);
  if (error) throw new HttpError(400, error);
  const name = input.name.trim();
  if (await nameTaken(name)) throw new HttpError(400, `A class called "${name}" already exists.`);

  const id = newId();
  const days = [...new Set(input.days)];
  await pool.query(
    'INSERT INTO classes (id, name, start_time, end_time, late_after_minutes, max_absences, days) VALUES ($1, $2, $3, $4, $5, $6, $7)',
    [id, name, input.startTime, input.endTime, input.lateAfterMinutes, input.maxAbsences, days],
  );
  await addLog(
    pool,
    'info',
    `Class created: ${name} (${daysText(days)}, ${input.startTime}–${input.endTime}, late after ${input.lateAfterMinutes} min, max ${input.maxAbsences} absences)`,
  );
  res.status(201).json(await classResponse(id));
});

/**
 * PATCH /api/classes/:id  (admin: everything; teacher of the class: start/end time and late minutes)
 */
classRoutes.patch('/classes/:id', requireRole('admin', 'teacher'), async (req, res) => {
  const auth = me(req);
  const current = await getClass(pool, param(req.params.id));
  if (!current) throw new HttpError(404, 'Class not found.');
  await assertTeaches(auth, current.id);

  const changes = (req.body ?? {}) as Partial<ClassInput>;
  if (auth.role === 'teacher' && (changes.name !== undefined || changes.maxAbsences !== undefined || changes.days !== undefined)) {
    throw new HttpError(403, 'Only the admin can rename a class or change its days or maximum absences.');
  }

  const next: ClassInput = {
    name: changes.name ?? current.name,
    startTime: changes.startTime ?? current.start_time,
    endTime: changes.endTime ?? current.end_time,
    lateAfterMinutes: changes.lateAfterMinutes ?? current.late_after_minutes,
    maxAbsences: changes.maxAbsences ?? current.max_absences,
    days: changes.days ?? current.days,
  };
  const error = validateClass(next);
  if (error) throw new HttpError(400, error);
  if (await nameTaken(next.name, current.id)) throw new HttpError(400, `A class called "${next.name.trim()}" already exists.`);

  const days = [...new Set(next.days)];
  await pool.query(
    'UPDATE classes SET name = $2, start_time = $3, end_time = $4, late_after_minutes = $5, max_absences = $6, days = $7 WHERE id = $1',
    [current.id, next.name.trim(), next.startTime, next.endTime, next.lateAfterMinutes, next.maxAbsences, days],
  );
  await addLog(
    pool,
    'info',
    `Class ${next.name.trim()} updated: ${daysText(days)}, ${next.startTime}–${next.endTime}, late after ${next.lateAfterMinutes} min, max ${next.maxAbsences} absences`,
  );
  res.json(await classResponse(current.id));
});

/** DELETE /api/classes/:id  (admin). Its students are left without a class. */
classRoutes.delete('/classes/:id', requireRole('admin'), async (req, res) => {
  const c = await one<ClassRow>(pool, 'DELETE FROM classes WHERE id = $1 RETURNING *', [param(req.params.id)]);
  if (!c) throw new HttpError(404, 'Class not found.');
  await addLog(pool, 'warning', `Class deleted: ${c.name}`);
  res.status(204).end();
});

/** PUT /api/classes/:id/teachers/:teacherId  (admin) adds a teacher to the class. */
classRoutes.put('/classes/:id/teachers/:teacherId', requireRole('admin'), async (req, res) => {
  const c = await getClass(pool, param(req.params.id));
  const teacher = await getUser(pool, param(req.params.teacherId));
  if (!c) throw new HttpError(404, 'Class not found.');
  if (!teacher || teacher.role !== 'teacher') throw new HttpError(404, 'Teacher not found.');

  await pool.query('INSERT INTO class_teachers (class_id, teacher_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [c.id, teacher.id]);
  await addLog(pool, 'info', `Teacher ${teacher.name} added to ${c.name}`);
  res.json(await classResponse(c.id));
});

/** DELETE /api/classes/:id/teachers/:teacherId  (admin) removes a teacher from the class. */
classRoutes.delete('/classes/:id/teachers/:teacherId', requireRole('admin'), async (req, res) => {
  const c = await getClass(pool, param(req.params.id));
  const teacher = await getUser(pool, param(req.params.teacherId));
  if (!c || !teacher) throw new HttpError(404, 'Class or teacher not found.');

  await pool.query('DELETE FROM class_teachers WHERE class_id = $1 AND teacher_id = $2', [c.id, teacher.id]);
  await addLog(pool, 'info', `Teacher ${teacher.name} removed from ${c.name}`);
  res.json(await classResponse(c.id));
});
