import { Router } from 'express';
import { AuthInfo, me, requireRole } from '../auth';
import { one, pool, Queryable, transaction } from '../db';
import {
  addLog,
  alertFamily,
  checkAbsenceLimit,
  getClass,
  getUser,
  isInClass,
  markUnmarkedAbsent,
  saveRecord,
  statusForTime,
} from '../logic';
import { AttendanceRow, ClassRow, Status, UserRow } from '../types';
import { clock, dateKey, HttpError, isDate, isTime, param } from '../utils';

export const attendanceRoutes = Router();

/** Throws unless the user is an admin or teaches this class. */
export async function assertTeaches(auth: AuthInfo, classId: string) {
  if (auth.role === 'admin') return;
  const teaches = await one(pool, 'SELECT 1 FROM class_teachers WHERE class_id = $1 AND teacher_id = $2', [classId, auth.id]);
  if (auth.role !== 'teacher' || !teaches) throw new HttpError(403, 'You do not teach this class.');
}

function validDay(date: unknown): string {
  if (!isDate(date) || date > dateKey()) throw new HttpError(400, 'Choose a valid date that is not in the future.');
  return date;
}

/** One teacher change: an arrival time (present/late is worked out) or a status. */
interface Entry {
  status?: unknown;
  time?: unknown;
}

/**
 * Applies one change for one student, in one class, on one day (call inside a transaction).
 * Parents are messaged for late/absent, and teachers warned near the class's absence limit.
 */
async function applyEntry(db: Queryable, student: UserRow, schoolClass: ClassRow, date: string, entry: Entry): Promise<Status> {
  const previous = await one<AttendanceRow>(db, 'SELECT * FROM attendance WHERE student_id = $1 AND class_id = $2 AND date = $3', [
    student.id,
    schoolClass.id,
    date,
  ]);
  const record = { studentId: student.id, classId: schoolClass.id, date, method: 'manual' as const };

  if (entry.time !== undefined && entry.time !== null && entry.time !== '') {
    if (!isTime(entry.time)) throw new HttpError(400, `Enter ${student.name}'s arrival time as HH:mm.`);
    const time = entry.time;
    const status = statusForTime(schoolClass, time);
    if (previous?.time !== time || previous.status !== status) {
      await saveRecord(db, { ...record, status, time });
      await addLog(db, 'info', `Teacher set arrival of ${student.name} in ${schoolClass.name} to ${time} on ${date} (${status})`);
      if (status === 'late' && previous?.status !== 'late') await alertFamily(db, student.id, schoolClass.id, 'late', date, time);
    }
    return status;
  }

  if (!['present', 'late', 'absent'].includes(entry.status as string)) {
    throw new HttpError(400, `Status for ${student.name} must be present, late or absent.`);
  }
  const status = entry.status as Status;
  if (previous?.status !== status) {
    const arrival = status === 'absent' ? null : (previous?.time ?? clock());
    await saveRecord(db, { ...record, status, time: arrival });
    await addLog(db, 'info', `Teacher set ${student.name} to ${status} in ${schoolClass.name} on ${date}`);
    if (status !== 'present') await alertFamily(db, student.id, schoolClass.id, status, date, arrival);
    if (status === 'absent') await checkAbsenceLimit(db, student.id, schoolClass.id);
  }
  return status;
}

/**
 * PUT /api/classes/:id/attendance/:date  { entries: [{ studentId, status } | { studentId, time }] }
 * Teacher submits the attendance sheet of one class for one day. All changes are saved together, or none.
 */
attendanceRoutes.put('/classes/:id/attendance/:date', requireRole('teacher', 'admin'), async (req, res) => {
  const classId = param(req.params.id);
  const date = validDay(param(req.params.date));
  const schoolClass = await getClass(pool, classId);
  if (!schoolClass) throw new HttpError(404, 'Class not found.');
  await assertTeaches(me(req), classId);

  const entries: (Entry & { studentId?: unknown })[] = req.body?.entries;
  if (!Array.isArray(entries) || entries.length === 0) throw new HttpError(400, 'There is nothing to submit.');

  const results = await transaction(async (db) => {
    const out: { studentId: string; status: Status }[] = [];
    for (const entry of entries) {
      const student = typeof entry?.studentId === 'string' ? await getUser(db, entry.studentId) : undefined;
      if (!student || student.role !== 'student' || !(await isInClass(db, student.id, classId))) {
        throw new HttpError(400, `A student on this sheet is not in ${schoolClass.name}. Refresh the page and try again.`);
      }
      out.push({ studentId: student.id, status: await applyEntry(db, student, schoolClass, date, entry) });
    }
    await addLog(db, 'info', `${schoolClass.name}: attendance for ${date} submitted (${out.length} student(s))`);
    return out;
  });
  res.json({ results });
});

/** POST /api/classes/:id/mark-absent  { date } -> { count }  Marks unmarked students of the class absent. */
attendanceRoutes.post('/classes/:id/mark-absent', requireRole('teacher', 'admin'), async (req, res) => {
  const date = validDay(req.body?.date);
  if (!(await getClass(pool, param(req.params.id)))) throw new HttpError(404, 'Class not found.');
  await assertTeaches(me(req), param(req.params.id));
  const count = await transaction((db) => markUnmarkedAbsent(db, param(req.params.id), date));
  res.json({ count });
});
