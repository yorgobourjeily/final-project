import type { Db, LogLevel, NotificationKind, Status, User } from './models';
import { pastWeekdays, uid } from './utils';

// Pure helpers that mutate a Db draft. Shared by DataService and the demo seed.

const nowIso = () => new Date().toISOString();

export function addLog(db: Db, level: LogLevel, message: string, at = nowIso()) {
  db.logs.unshift({ id: uid(), at, level, message });
  db.logs.length = Math.min(db.logs.length, 200);
}

export function notify(db: Db, userId: string, kind: NotificationKind, message: string, at = nowIso()) {
  db.notifications.unshift({ id: uid(), userId, kind, message, createdAt: at, read: false });
}

/** Notifies the student and sends a message to every linked parent. */
export function alertFamily(
  db: Db,
  studentId: string,
  status: Exclude<Status, 'present'>,
  date: string,
  time?: string,
  at = nowIso(),
) {
  const student = db.users.find((u) => u.id === studentId);
  if (!student) return;

  const what = status === 'late' ? `late (arrived ${time}) on ${date}` : `absent on ${date}`;
  notify(db, studentId, status, `You were marked ${what}.`, at);

  for (const parent of db.users.filter((u) => u.role === 'parent' && u.childId === studentId)) {
    notify(db, parent.id, status, `${student.name} was marked ${what}.`, at);
    const contact = parent.phone || parent.email || 'no contact on file';
    addLog(db, 'info', `Message sent to ${parent.name} (${contact}): ${student.name} ${status} on ${date}`, at);
  }
}

/** Warns teachers when a student is one absence away from, or past, the limit. */
export function checkAbsenceLimit(db: Db, studentId: string, at = nowIso()) {
  const student = db.users.find((u) => u.id === studentId);
  if (!student) return;

  const count = db.records.filter((r) => r.studentId === studentId && r.status === 'absent').length;
  const max = db.settings.maxAbsences;
  if (count < max - 1) return;

  const message =
    count >= max
      ? `${student.name} has ${count} absences and reached the limit of ${max}.`
      : `${student.name} has ${count} absences — one more reaches the limit of ${max}.`;

  for (const teacher of db.users.filter((u) => u.role === 'teacher')) {
    notify(db, teacher.id, 'limit', message, at);
  }
}

// ---------------------------------------------------------------- demo data

const STUDENTS: { name: string; parent: string; pattern: string }[] = [
  // One letter per past school day: P = present, L = late, A = absent.
  { name: 'Karim Saad', parent: 'Nadim Saad', pattern: 'PPPPPPPPLP' },
  { name: 'Lea Khoury', parent: 'Hala Khoury', pattern: 'PLPPPLPPPP' },
  { name: 'Jad Mansour', parent: 'Fadi Mansour', pattern: 'APAPPAPAPP' },
  { name: 'Maria Nassar', parent: 'Rita Nassar', pattern: 'PPPPPPPPPP' },
  { name: 'Elie Aoun', parent: 'Georges Aoun', pattern: 'PPLPAPPPPP' },
  { name: 'Nour Fares', parent: 'Mona Fares', pattern: 'PPPPPPAPPL' },
  // Has an account but is not on the class sheet yet, so the teacher can add them.
  { name: 'Rami Ghanem', parent: 'Samir Ghanem', pattern: '' },
];

export function createSeedDb(): Db {
  const db: Db = {
    users: [
      { id: 'u-admin', name: 'System Admin', username: 'admin', password: 'admin123', role: 'admin', email: 'admin@zeroproxy.school' },
      { id: 'u-teacher', name: 'Ms. Rana Haddad', username: 'teacher', password: 'teacher123', role: 'teacher', email: 'r.haddad@zeroproxy.school' },
    ],
    records: [],
    notifications: [],
    logs: [],
    settings: { startTime: '08:00', lateAfterMinutes: 10, maxAbsences: 5 },
  };

  STUDENTS.forEach((s, i) => {
    const n = i + 1;
    const student: User = {
      id: `u-student${n}`,
      name: s.name,
      username: `student${n}`,
      password: 'student123',
      role: 'student',
      email: `student${n}@zeroproxy.school`,
      enrolled: s.pattern !== '',
    };
    const parent: User = {
      id: `u-parent${n}`,
      name: s.parent,
      username: `parent${n}`,
      password: 'parent123',
      role: 'parent',
      phone: `+961 70 100 10${n}`,
      childId: student.id,
    };
    db.users.push(student, parent);
  });

  const days = pastWeekdays(10);
  days.forEach((date, d) => {
    STUDENTS.forEach((s, i) => {
      const code = s.pattern[d];
      if (!code) return;
      const studentId = `u-student${i + 1}`;
      const status: Status = code === 'P' ? 'present' : code === 'L' ? 'late' : 'absent';
      const time =
        status === 'present'
          ? `07:${40 + ((i * 7 + d * 3) % 19)}`
          : status === 'late'
            ? `08:${15 + ((i * 5 + d) % 30)}`
            : undefined;
      const at = new Date(`${date}T${time ?? '15:00'}:00`).toISOString();

      db.records.push({ id: uid(), studentId, date, status, time, method: status === 'absent' ? 'auto' : 'face' });
      if (status !== 'present') alertFamily(db, studentId, status, date, time, at);
      if (status === 'absent') checkAbsenceLimit(db, studentId, at);
    });
  });

  // Only the last two days' alerts start unread.
  const recent = new Date(`${days[days.length - 2]}T00:00:00`).toISOString();
  db.notifications.forEach((n) => (n.read = n.createdAt < recent));

  addLog(db, 'info', 'Demo data created');
  return db;
}
