import { config } from './config';
import { one, pool, Queryable, rows, transaction } from './db';
import { AttendanceRow, ClassRow, LogLevel, NotificationKind, Role, SessionRow, Status, UserRow } from './types';
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

/** Takes the next ID for the role from its counter, which only goes up: IDs of deleted accounts are never reused. */
export async function newLoginId(db: Queryable, role: Role): Promise<string> {
  const counter = await one<{ last_number: string }>(
    db,
    `INSERT INTO login_id_counters (role, last_number) VALUES ($1, $2)
     ON CONFLICT (role) DO UPDATE SET last_number = login_id_counters.last_number + 1
     RETURNING last_number`,
    [role, ID_START[role]],
  );
  return `${ID_PREFIX[role]}${counter!.last_number}`;
}

/** The ID the next new account of each role will get, without taking it (shown in the admin's account form). */
export async function nextLoginIds(db: Queryable): Promise<Record<Role, string>> {
  const counters = await rows<{ role: Role; last_number: string }>(db, 'SELECT role, last_number FROM login_id_counters');
  const next = (role: Role) => {
    const counter = counters.find((c) => c.role === role);
    return `${ID_PREFIX[role]}${counter ? Number(counter.last_number) + 1 : ID_START[role]}`;
  };
  return { student: next('student'), teacher: next('teacher'), parent: next('parent'), admin: next('admin') };
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

/** The class with its start moved to when the teacher really started it, if later, so nobody is late because of that. */
const asStarted = (c: ClassRow, startedAt: string): ClassRow =>
  toMinutes(startedAt) > toMinutes(c.start_time) ? { ...c, start_time: startedAt } : c;

/**
 * Which class a camera scan belongs to: the student's earliest class that a teacher has started
 * and not ended, and that they are not marked for yet. `alreadyMarked` is set when every class
 * running has a record; `classes` is empty when the student is in no class.
 */
export async function classForArrival(db: Queryable, studentId: string, date: string) {
  const classes = await classesOfStudent(db, studentId);
  const marked = await rows<AttendanceRow>(db, "SELECT * FROM attendance WHERE student_id = $1 AND date = $2 AND method <> 'auto'", [
    studentId,
    date,
  ]);
  // Only classes a teacher has started and not ended, and that are not cancelled.
  const cancelled = await rows<{ class_id: string }>(db, 'SELECT class_id FROM class_cancellations WHERE date = $1', [date]);
  const sessions = await rows<SessionRow>(db, 'SELECT * FROM class_sessions WHERE date = $1 AND ended_at IS NULL', [date]);
  const running = classes.flatMap((c) => {
    const session = sessions.find((s) => s.class_id === c.id);
    return session && !cancelled.some((x) => x.class_id === c.id) ? [asStarted(c, session.started_at)] : [];
  });
  const target = running.find((c) => !marked.some((r) => r.class_id === c.id));
  const alreadyMarked = target ? undefined : marked.find((r) => running.some((c) => c.id === r.class_id));
  return { classes, target, alreadyMarked };
}

/** Day of the week of a YYYY-MM-DD date: 0 = Sunday … 6 = Saturday. */
export const weekdayOf = (date: string) => new Date(`${date}T12:00:00`).getDay();

/** Whether the class's weekly schedule includes that date's weekday (days off are checked separately). */
export const meetsOn = (c: ClassRow, date: string) => c.days.includes(weekdayOf(date));

/** The school-wide day off on that date, if any. */
export const dayOff = (db: Queryable, date: string) =>
  one<{ date: string; reason: string | null }>(db, 'SELECT * FROM days_off WHERE date = $1', [date]);

/** Whether that class is cancelled on that date. */
export const isCancelled = async (db: Queryable, classId: string, date: string) =>
  !!(await one(db, 'SELECT 1 FROM class_cancellations WHERE class_id = $1 AND date = $2', [classId, date]));

/** "Independence Day" or "a day off", for messages. */
export const dayOffText = (d: { reason: string | null }) => d.reason || 'a day off';

const DAY_NAMES = ['Sundays', 'Mondays', 'Tuesdays', 'Wednesdays', 'Thursdays', 'Fridays', 'Saturdays'];
export const dayName = (date: string) => DAY_NAMES[weekdayOf(date)];

/** HH:mm after which arrivals in this class count as late. */
export const lateCutoff = (c: ClassRow) => addMinutes(c.start_time, c.late_after_minutes);

/** Present or late for an arrival time (HH:mm) in the given class. */
export function statusForTime(c: ClassRow | undefined, time: string): Exclude<Status, 'absent'> {
  if (!c) return 'present';
  return toMinutes(time) > toMinutes(lateCutoff(c)) ? 'late' : 'present';
}

const statusText = (status: Exclude<Status, 'present'>, className: string, date: string, time?: string | null) =>
  status === 'late' ? `late (arrived ${time}) in ${className} on ${date}` : `absent from ${className} on ${date}`;

const parentsOf = (db: Queryable, studentId: string) =>
  rows<UserRow>(db, 'SELECT u.* FROM users u JOIN parent_children pc ON pc.parent_id = u.id WHERE pc.student_id = $1 ORDER BY u.name', [
    studentId,
  ]);

/** Alerts the student and every linked parent in the app. Emails are sent when the class ends (see queueClassEmails). */
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

  const what = statusText(status, className, date, time);
  await notify(db, studentId, status, `You were marked ${what}.`, at);
  for (const parent of await parentsOf(db, studentId)) {
    await notify(db, parent.id, status, `${student.name} was marked ${what}.`, at);
    const contact = parent.phone || parent.email || 'no contact on file';
    await addLog(db, 'info', `Alert for ${parent.name} (${contact}): ${student.name} ${status}, ${className}, ${date}`, at);
  }
}

/**
 * Queues an email to each late or absent student of the class and to their parents. Run when the class ends,
 * inside the same transaction, so they are only sent if it is saved. A status already emailed is not repeated.
 */
export async function queueClassEmails(db: Queryable, classId: string, date: string) {
  const className = (await getClass(db, classId))?.name ?? 'class';
  const records = await rows<AttendanceRow & { status: Exclude<Status, 'present'>; name: string; email: string | null }>(
    db,
    `SELECT a.*, u.name, u.email FROM attendance a JOIN users u ON u.id = a.student_id
     WHERE a.class_id = $1 AND a.date = $2 AND a.status <> 'present' AND a.emailed_status IS DISTINCT FROM a.status
     ORDER BY u.name`,
    [classId, date],
  );
  if (records.length === 0) return;
  if (!config.smtp.host) {
    await addLog(db, 'warning', `${className} on ${date}: no emails sent because email is not set up`);
    return;
  }

  for (const record of records) {
    const what = statusText(record.status, className, date, record.time);
    const parents = await parentsOf(db, record.student_id);
    const recipients = [
      { id: record.student_id, name: record.name, email: record.email, message: `You were marked ${what}.` },
      ...parents.map((p) => ({ id: p.id, name: p.name, email: p.email, message: `${record.name} was marked ${what}.` })),
    ];
    for (const recipient of recipients) {
      if (!recipient.email) {
        await addLog(db, 'warning', `No email to ${recipient.name} about ${record.name} in ${className} on ${date}: no email address on file`);
        continue;
      }
      await db.query('INSERT INTO email_outbox (recipient_id, student_id, subject, body) VALUES ($1, $2, $3, $4)', [
        recipient.id,
        record.student_id,
        `ZeroProxy: ${record.name} was ${record.status} on ${date}`,
        `Hello ${recipient.name},\n\n${recipient.message}\n\nZeroProxy attendance`,
      ]);
    }
    await db.query('UPDATE attendance SET emailed_status = status WHERE id = $1', [record.id]);
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
  const schoolClass = await getClass(db, classId);
  // No class that day (not on its schedule, or a day off), so nobody is absent.
  if (!schoolClass || !meetsOn(schoolClass, date) || (await dayOff(db, date)) || (await isCancelled(db, classId, date))) return 0;

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
  await addLog(db, 'info', `${schoolClass.name}: unmarked students on ${date} marked absent: ${missing.map((s) => s.name).join(', ')}`);
  return missing.length;
}

/** Ends a running class: the cameras stop counting it, students not seen are marked absent, and families are emailed. */
export async function endSession(db: Queryable, classId: string, date: string, time: string) {
  await db.query('UPDATE class_sessions SET ended_at = $3 WHERE class_id = $1 AND date = $2', [classId, date, time]);
  await markUnmarkedAbsent(db, classId, date);
  await queueClassEmails(db, classId, date);
}

/** Ends classes left running from an earlier day, for teachers who forgot to press End. A class runs until End on its own day. */
export async function closeForgottenSessions() {
  const open = await rows<SessionRow & { name: string; end_time: string }>(
    pool,
    `SELECT s.*, c.name, c.end_time FROM class_sessions s JOIN classes c ON c.id = s.class_id
     WHERE s.ended_at IS NULL AND s.date < $1`,
    [dateKey()],
  );
  for (const s of open) {
    await transaction((client) => endSession(client, s.class_id, s.date, s.end_time));
    await addLog(pool, 'info', `${s.name} of ${s.date} was never ended, so it was closed automatically`);
  }
}
