import { Router } from 'express';
import { me } from '../auth';
import { one, pool, rows } from '../db';
import {
  AttendanceRow,
  ClassRow,
  LogRow,
  NotificationRow,
  toClass,
  toLog,
  toNotification,
  toRecord,
  toUser,
  UserRow,
} from '../types';

export const stateRoutes = Router();

/**
 * GET /api/state -> everything the signed-in user is allowed to see.
 *  admin:   all users, classes, attendance and the system log
 *  teacher: their classes, all students (to add them to a class), attendance of their students
 *  parent:  themselves, their child, the child's class and attendance
 *  student: themselves, their class and attendance
 * Everyone gets their own notifications.
 */
stateRoutes.get('/state', async (req, res) => {
  const auth = me(req);
  let users: UserRow[] = [];
  let classes: ClassRow[] = [];
  let records: AttendanceRow[] = [];
  let logs: LogRow[] = [];

  switch (auth.role) {
    case 'admin':
      users = await rows(pool, 'SELECT * FROM users ORDER BY role, name');
      classes = await rows(pool, 'SELECT * FROM classes ORDER BY name');
      records = await rows(pool, 'SELECT * FROM attendance');
      logs = await rows(pool, 'SELECT * FROM logs ORDER BY at DESC, id DESC LIMIT 200');
      break;

    case 'teacher':
      classes = await rows(
        pool,
        'SELECT c.* FROM classes c JOIN class_teachers ct ON ct.class_id = c.id WHERE ct.teacher_id = $1 ORDER BY c.name',
        [auth.id],
      );
      // Students of the teacher's classes, and their attendance in those classes only.
      users = await rows(
        pool,
        `SELECT * FROM users WHERE id = $1 OR id IN (
           SELECT cs.student_id FROM class_students cs JOIN class_teachers ct ON ct.class_id = cs.class_id WHERE ct.teacher_id = $1
         ) ORDER BY name`,
        [auth.id],
      );
      records = await rows(
        pool,
        'SELECT a.* FROM attendance a JOIN class_teachers ct ON ct.class_id = a.class_id WHERE ct.teacher_id = $1',
        [auth.id],
      );
      break;

    case 'parent': {
      users = await rows(
        pool,
        'SELECT * FROM users WHERE id = $1 OR id IN (SELECT student_id FROM parent_children WHERE parent_id = $1) ORDER BY name',
        [auth.id],
      );
      const childIds = users.filter((u) => u.role === 'student').map((u) => u.id);
      if (childIds.length) {
        classes = await rows(
          pool,
          'SELECT DISTINCT c.* FROM classes c JOIN class_students cs ON cs.class_id = c.id WHERE cs.student_id = ANY($1) ORDER BY c.name',
          [childIds],
        );
        records = await rows(pool, 'SELECT * FROM attendance WHERE student_id = ANY($1)', [childIds]);
      }
      break;
    }

    case 'student':
      users = await rows(pool, 'SELECT * FROM users WHERE id = $1', [auth.id]);
      classes = await rows(
        pool,
        'SELECT c.* FROM classes c JOIN class_students cs ON cs.class_id = c.id WHERE cs.student_id = $1 ORDER BY c.start_time',
        [auth.id],
      );
      records = await rows(pool, 'SELECT * FROM attendance WHERE student_id = $1', [auth.id]);
      break;
  }

  const links = classes.length
    ? await rows<{ class_id: string; teacher_id: string }>(pool, 'SELECT * FROM class_teachers WHERE class_id = ANY($1)', [
        classes.map((c) => c.id),
      ])
    : [];
  const notifications = await rows<NotificationRow>(
    pool,
    'SELECT * FROM notifications WHERE user_id = $1 ORDER BY created_at DESC LIMIT 200',
    [auth.id],
  );
  const settings = await one<{ max_absences: number }>(pool, 'SELECT max_absences FROM settings WHERE id = 1');
  const daysOff = await rows<{ date: string; reason: string | null }>(pool, 'SELECT * FROM days_off ORDER BY date');
  // Cancellations of the classes this user can see.
  const cancellations = classes.length
    ? await rows<{ class_id: string; date: string; reason: string | null }>(
        pool,
        'SELECT * FROM class_cancellations WHERE class_id = ANY($1) ORDER BY date',
        [classes.map((c) => c.id)],
      )
    : [];

  // Children of the parents in this response.
  const parentIds = users.filter((u) => u.role === 'parent').map((u) => u.id);
  const family = parentIds.length
    ? await rows<{ parent_id: string; student_id: string }>(pool, 'SELECT * FROM parent_children WHERE parent_id = ANY($1)', [
        parentIds,
      ])
    : [];
  // Classes of the students in this response (only the classes this user may see).
  const studentIds = users.filter((u) => u.role === 'student').map((u) => u.id);
  const visibleClassIds = classes.map((c) => c.id);
  const memberships = studentIds.length
    ? await rows<{ class_id: string; student_id: string }>(
        pool,
        'SELECT * FROM class_students WHERE student_id = ANY($1) AND class_id = ANY($2)',
        [studentIds, visibleClassIds],
      )
    : [];

  const linksOf = (u: UserRow) =>
    u.role === 'parent'
      ? family.filter((f) => f.parent_id === u.id).map((f) => f.student_id)
      : memberships.filter((m) => m.student_id === u.id).map((m) => m.class_id);

  res.json({
    users: users.map((u) => toUser(u, linksOf(u))),
    classes: classes.map((c) =>
      toClass(
        c,
        links.filter((l) => l.class_id === c.id).map((l) => l.teacher_id),
      ),
    ),
    records: records.map(toRecord),
    notifications: notifications.map(toNotification),
    logs: logs.map(toLog),
    settings: { maxAbsences: settings?.max_absences ?? 5 },
    daysOff: daysOff.map((d) => ({ date: d.date, reason: d.reason ?? undefined })),
    cancellations: cancellations.map((c) => ({ classId: c.class_id, date: c.date, reason: c.reason ?? undefined })),
  });
});
