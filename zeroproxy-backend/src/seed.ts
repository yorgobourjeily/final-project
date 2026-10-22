import bcrypt from 'bcryptjs';
import { transaction } from './db';
import { addLog, alertFamily, checkAbsenceLimit, saveRecord } from './logic';
import { Status } from './types';
import { addMinutes, pastWeekdays } from './utils';

// Demo data: 3 classes, 3 teachers, 8 students with parents, and 10 school days of history.
// Karim, Lea and Elie are in two classes each (their grade + Computer Science).

const CLASSES = [
  { id: 'c-10a', name: 'Grade 10 – A', start: '08:00', end: '14:00', late: 10, max: 5, teachers: ['u-teacher'] },
  { id: 'c-10b', name: 'Grade 10 – B', start: '08:00', end: '13:30', late: 15, max: 6, teachers: ['u-teacher', 'u-teacher2'] },
  { id: 'c-cs', name: 'Computer Science', start: '14:30', end: '16:00', late: 10, max: 4, teachers: ['u-teacher3'] },
];

// Everyone signs in with their ID, counting up from 1 per role: admin a1, teachers t1–t3, students 1–8, parents p1–p8.
const STAFF = [
  { id: 'u-admin', name: 'System Admin', loginId: 'a1', password: 'admin123', role: 'admin', email: 'admin@zeroproxy.school' },
  { id: 'u-teacher', name: 'Ms. Rana Haddad', loginId: 't1', password: 'teacher123', role: 'teacher', email: 'r.haddad@zeroproxy.school' },
  { id: 'u-teacher2', name: 'Mr. Tony Rizk', loginId: 't2', password: 'teacher123', role: 'teacher', email: 't.rizk@zeroproxy.school' },
  { id: 'u-teacher3', name: 'Ms. Carla Daher', loginId: 't3', password: 'teacher123', role: 'teacher', email: 'c.daher@zeroproxy.school' },
];

// For each class the student is in: one letter per past school day. P = present, L = late, A = absent.
const STUDENTS: { name: string; parent: string; classes: Record<string, string> }[] = [
  { name: 'Karim Saad', parent: 'Nadim Saad', classes: { 'c-10a': 'PPPPPPPPLP', 'c-cs': 'PPLPPPPPPP' } },
  { name: 'Lea Khoury', parent: 'Hala Khoury', classes: { 'c-10a': 'PLPPPLPPPP', 'c-cs': 'PPPPAPPPPP' } },
  { name: 'Jad Mansour', parent: 'Fadi Mansour', classes: { 'c-10a': 'APAPPAPAPP' } },
  { name: 'Maria Nassar', parent: 'Rita Nassar', classes: { 'c-10b': 'PPPPPPPPPP' } },
  { name: 'Elie Aoun', parent: 'Georges Aoun', classes: { 'c-10b': 'PPLPAPPPPP', 'c-cs': 'LPPPPPPPPP' } },
  { name: 'Nour Fares', parent: 'Mona Fares', classes: { 'c-10b': 'PPPPPPAPPL' } },
  // Has an account but no class yet.
  { name: 'Rami Ghanem', parent: 'Samir Ghanem', classes: {} },
  // Karim's sister, so the Saad family shows two parents with two children.
  { name: 'Sara Saad', parent: 'Layla Saad', classes: { 'c-10b': 'PPPLPPPPAP' } },
];

// Besides each student's own parent (parentN -> studentN): both Saad parents are linked to both Saad children.
const EXTRA_LINKS: [parentId: string, studentId: string][] = [
  ['u-parent1', 'u-student8'],
  ['u-parent8', 'u-student1'],
];

/** Deletes everything and loads the demo data. */
export async function seedDemoData() {
  const hashes = new Map<string, string>();
  const hash = (password: string) => {
    if (!hashes.has(password)) hashes.set(password, bcrypt.hashSync(password, 10));
    return hashes.get(password)!;
  };

  await transaction(async (db) => {
    await db.query(
      'TRUNCATE logs, notifications, attendance, class_teachers, class_students, parent_children, users, classes, settings RESTART IDENTITY CASCADE',
    );
    await db.query('INSERT INTO settings (id, max_absences) VALUES (1, 5)');

    for (const c of CLASSES) {
      await db.query(
        'INSERT INTO classes (id, name, start_time, end_time, late_after_minutes, max_absences) VALUES ($1, $2, $3, $4, $5, $6)',
        [c.id, c.name, c.start, c.end, c.late, c.max],
      );
    }

    const insertUser =
      'INSERT INTO users (id, name, login_id, password_hash, role, email, phone) VALUES ($1, $2, $3, $4, $5, $6, $7)';
    const link = 'INSERT INTO parent_children (parent_id, student_id) VALUES ($1, $2)';
    for (const s of STAFF) {
      await db.query(insertUser, [s.id, s.name, s.loginId, hash(s.password), s.role, s.email, null]);
    }
    for (const [i, s] of STUDENTS.entries()) {
      const n = i + 1;
      // Student IDs 1 … 8 (what the camera machine sends); each student's parent is pN.
      await db.query(insertUser, [`u-student${n}`, s.name, String(n), hash('student123'), 'student', `student${n}@zeroproxy.school`, null]);
      await db.query(insertUser, [`u-parent${n}`, s.parent, `p${n}`, hash('parent123'), 'parent', null, `+961 70 100 10${n}`]);
      await db.query(link, [`u-parent${n}`, `u-student${n}`]);
      for (const classId of Object.keys(s.classes)) {
        await db.query('INSERT INTO class_students (class_id, student_id) VALUES ($1, $2)', [classId, `u-student${n}`]);
      }
    }
    for (const [parentId, studentId] of EXTRA_LINKS) await db.query(link, [parentId, studentId]);

    for (const c of CLASSES) {
      for (const t of c.teachers) await db.query('INSERT INTO class_teachers (class_id, teacher_id) VALUES ($1, $2)', [c.id, t]);
    }

    const days = pastWeekdays(10);
    for (const [d, date] of days.entries()) {
      for (const [i, s] of STUDENTS.entries()) {
        for (const [classId, pattern] of Object.entries(s.classes)) {
          const code = pattern[d];
          if (!code) continue;
          const c = CLASSES.find((x) => x.id === classId)!;
          const studentId = `u-student${i + 1}`;
          const status: Status = code === 'P' ? 'present' : code === 'L' ? 'late' : 'absent';
          // Present: a few minutes before the start. Late: 5–30 minutes after the late cutoff.
          const time =
            status === 'present'
              ? addMinutes(c.start, -20 + ((i * 7 + d * 3) % 19))
              : status === 'late'
                ? addMinutes(c.start, c.late + 5 + ((i * 5 + d) % 25))
                : undefined;
          const at = new Date(`${date}T${time ?? c.end}:00`).toISOString();

          await saveRecord(db, { studentId, classId, date, status, time, method: status === 'absent' ? 'auto' : 'face' });
          if (status !== 'present') await alertFamily(db, studentId, classId, status, date, time, at);
          if (status === 'absent') await checkAbsenceLimit(db, studentId, classId, at);
        }
      }
    }

    // Only the last two days' alerts start unread.
    await db.query('UPDATE notifications SET read = created_at < $1::date', [days[days.length - 2]]);
    await addLog(db, 'info', 'Demo data created');
  });
}
