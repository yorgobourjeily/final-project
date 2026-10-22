import { one, pool, Queryable, rows, transaction } from './db';
import { AttendanceRow, ClassRow, LogLevel, NotificationKind, Role, Status, UserRow } from './types';
import { addMinutes, clock, dateKey, newId, toMinutes } from './utils';

// Attendance rules: lateness, automatic absences, parent messages and absence-limit alerts.

export async function addLog(db: Queryable, level: LogLevel, message: string, at?: string) {
  await db.query('INSERT INTO logs (at, level, message) VALUES (COALESCE($1::timestamptz, now()), $2, $3)', [
    at ?? null,
    level,
    message,
  ]);
}

export async function notify(db: Queryable, userId: string, kind: NotificationKind, message: string, at?: string) {
  await db.query(
    'INSERT INTO notifications (id, user_id, kind, message, created_at) VALUES ($1, $2, $3, $4, COALESCE($5::timestamptz, now()))',
    [newId(), userId, kind, message, at ?? null],
  );
}

export const getUser = (db: Queryable, id: string) => one<UserRow>(db, 'SELECT * FROM users WHERE id = $1', [id]);

// ---------------------------------------------------------------- account IDs
// Every account signs in with its ID. Students: digits only (also sent by the camera machine);
// teachers "t…", parents "p…", admins "a…", each followed by digits.

export const ID_PREFIX: Record<Role, string> = { student: '', teacher: 't', parent: 'p', admin: 'a' };
/** Every role counts up from 1: students 1, 2, 3…, parents p1, p2…, teachers t1, t2…, admins a1, a2…. */
const ID_START: Record<Role, number> = { student: 1, parent: 1, teacher: 1, admin: 1 };

/** Whether `id` has the right format for the role (e.g. "t1" for a teacher). */
export const isLoginIdFor = (role: Role, id: string) => new RegExp(`^${ID_PREFIX[role]}\\d{1,12}$`).test(id);

/**
 * The next ID for the role: the lowest free number from the role's start. IDs of deleted
 * accounts are free again, so the next new account takes the smallest one of those first.
 */
export async function newLoginId(db: Queryable, role: Role): Promise<string> {
  const taken = await rows<{ login_id: string }>(db, 'SELECT login_id FROM users WHERE role = $1', [role]);
  const used = new Set(
    taken.map((t) => t.login_id).filter((id) => isLoginIdFor(role, id)).map((id) => Number(id.slice(ID_PREFIX[role].length))),
  );
  let n = ID_START[role];
  while (used.has(n)) n++;
  return `${ID_PREFIX[role]}${n}`;
}

/** Gives every account whose ID does not match its role's format a new one (e.g. old usernames). */
export async function backfillLoginIds() {
  const users = await rows<{ id: string; role: Role; login_id: string }>(pool, 'SELECT id, role, login_id FROM users');
  for (const u of users) {
    if (isLoginIdFor(u.role, u.login_id)) continue;
    const newId = await newLoginId(pool, u.role);
    await pool.query('UPDATE users SET login_id = $2 WHERE id = $1', [u.id, newId]);
    console.log(`Gave ${u.role} account "${u.login_id}" the ID ${newId}`);
  }
}

/** The students linked to a parent. */
export async function childIdsOf(db: Queryable, parentId: string): Promise<string[]> {
  const links = await rows<{ student_id: string }>(db, 'SELECT student_id FROM parent_children WHERE parent_id = $1', [parentId]);
  return links.map((l) => l.student_id);
}

export const getClass = (db: Queryable, id: string | null | undefined) =>
  id ? one<ClassRow>(db, 'SELECT * FROM classes WHERE id = $1', [id]) : Promise.resolve(undefined);

/** The classes a student is in, earliest start first. */
export const classesOfStudent = (db: Queryable, studentId: string) =>
  rows<ClassRow>(
    db,
    'SELECT c.* FROM classes c JOIN class_students cs ON cs.class_id = c.id WHERE cs.student_id = $1 ORDER BY c.start_time, c.name',
    [studentId],
  );

/** The ids of the classes a student is in. */
export async function classIdsOf(db: Queryable, studentId: string): Promise<string[]> {
  const links = await rows<{ class_id: string }>(db, 'SELECT class_id FROM class_students WHERE student_id = $1', [studentId]);
  return links.map((l) => l.class_id);
}

export const isInClass = async (db: Queryable, studentId: string, classId: string) =>
  !!(await one(db, 'SELECT 1 FROM class_students WHERE class_id = $1 AND student_id = $2', [classId, studentId]));

/**
 * Which class a camera scan at `time` belongs to: the student's earliest class today that has not
 * ended yet and that they are not marked for yet. `alreadyMarked` is set when every class still
 * running has a record; `classes` is empty when the student is in no class.
 */
export async function classForArrival(db: Queryable, studentId: string, date: string, time: string) {
  const classes = await classesOfStudent(db, studentId);
  const marked = await rows<AttendanceRow>(db, "SELECT * FROM attendance WHERE student_id = $1 AND date = $2 AND method <> 'auto'", [
    studentId,
    date,
  ]);
  const notEnded = classes.filter((c) => toMinutes(time) < toMinutes(c.end_time));
  const target = notEnded.find((c) => !marked.some((r) => r.class_id === c.id));
  const alreadyMarked = target ? undefined : marked.find((r) => notEnded.some((c) => c.id === r.class_id));
  return { classes, target, alreadyMarked };
}

/** HH:mm after which arrivals in this class count as late. */
export const lateCutoff = (c: ClassRow) => addMinutes(c.start_time, c.late_after_minutes);

/** Present or late for an arrival time (HH:mm) in the given class. */
export function statusForTime(c: ClassRow | undefined, time: string): Exclude<Status, 'absent'> {
  if (!c) return 'present';
  return toMinutes(time) > toMinutes(lateCutoff(c)) ? 'late' : 'present';
}

/** Notifies the student and sends a message to every linked parent. */
export async function alertFamily(
  db: Queryable,
  studentId: string,
  classId: string,
  status: Exclude<Status, 'present'>,
  date: string,
  time?: string | null,
  at?: string,
) {
  const student = await getUser(db, studentId);
  if (!student) return;
  const className = (await getClass(db, classId))?.name ?? 'class';

  const what = status === 'late' ? `late (arrived ${time}) in ${className} on ${date}` : `absent from ${className} on ${date}`;
  await notify(db, studentId, status, `You were marked ${what}.`, at);

  const parents = await rows<UserRow>(
    db,
    'SELECT u.* FROM users u JOIN parent_children pc ON pc.parent_id = u.id WHERE pc.student_id = $1 ORDER BY u.name',
    [studentId],
  );
  for (const parent of parents) {
    await notify(db, parent.id, status, `${student.name} was marked ${what}.`, at);
    const contact = parent.phone || parent.email || 'no contact on file';
    await addLog(db, 'info', `Message sent to ${parent.name} (${contact}): ${student.name} ${status}, ${className}, ${date}`, at);
  }
}

/** Warns the class's teachers when a student is one absence away from, or past, that class's limit. */
export async function checkAbsenceLimit(db: Queryable, studentId: string, classId: string, at?: string) {
  const student = await getUser(db, studentId);
  const schoolClass = await getClass(db, classId);
  if (!student || !schoolClass) return;

  const max = schoolClass.max_absences;
  const counted = await one<{ count: number }>(
    db,
    "SELECT count(*)::int AS count FROM attendance WHERE student_id = $1 AND class_id = $2 AND status = 'absent'",
    [studentId, classId],
  );
  const count = counted?.count ?? 0;
  if (count < max - 1) return;

  const message =
    count >= max
      ? `${student.name} has ${count} absences in ${schoolClass.name} and reached the limit of ${max}.`
      : `${student.name} has ${count} absences in ${schoolClass.name} — one more reaches the limit of ${max}.`;

  const teachers = await rows<{ teacher_id: string }>(db, 'SELECT teacher_id FROM class_teachers WHERE class_id = $1', [classId]);
  for (const t of teachers) await notify(db, t.teacher_id, 'limit', message, at);
}

/** Replaces a student's record for one class on one day. */
export async function saveRecord(
  db: Queryable,
  record: { studentId: string; classId: string; date: string; status: Status; time?: string | null; method: 'face' | 'manual' | 'auto' },
) {
  await db.query('DELETE FROM attendance WHERE student_id = $1 AND class_id = $2 AND date = $3', [
    record.studentId,
    record.classId,
    record.date,
  ]);
  await db.query(
    'INSERT INTO attendance (id, student_id, class_id, date, status, time, method) VALUES ($1, $2, $3, $4, $5, $6, $7)',
    [newId(), record.studentId, record.classId, record.date, record.status, record.time ?? null, record.method],
  );
}

/** Marks every student of the class with no record for that class on `date` as absent. Returns how many. */
export async function markUnmarkedAbsent(db: Queryable, classId: string, date: string): Promise<number> {
  const missing = await rows<UserRow>(
    db,
    `SELECT u.* FROM users u
     JOIN class_students cs ON cs.student_id = u.id AND cs.class_id = $1
     WHERE NOT EXISTS (SELECT 1 FROM attendance a WHERE a.student_id = u.id AND a.class_id = $1 AND a.date = $2)
     ORDER BY u.name`,
    [classId, date],
  );
  if (missing.length === 0) return 0;

  for (const s of missing) {
    await saveRecord(db, { studentId: s.id, classId, date, status: 'absent', method: 'auto' });
    await alertFamily(db, s.id, classId, 'absent', date);
    await checkAbsenceLimit(db, s.id, classId);
  }
  const schoolClass = await getClass(db, classId);
  await addLog(db, 'info', `${schoolClass?.name}: unmarked students on ${date} marked absent: ${missing.map((s) => s.name).join(', ')}`);
  return missing.length;
}

/** For every class whose late cutoff has passed today, marks unmarked students absent (weekdays only). */
export async function autoMarkAbsentToday() {
  const now = new Date();
  if (now.getDay() === 0 || now.getDay() === 6) return;
  const classes = await rows<ClassRow>(pool, 'SELECT * FROM classes');
  for (const c of classes) {
    if (toMinutes(clock(now)) > toMinutes(lateCutoff(c))) {
      await transaction((client) => markUnmarkedAbsent(client, c.id, dateKey(now)));
    }
  }
}
