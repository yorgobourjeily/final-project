// Database rows (snake_case) and the API shapes sent to the frontend (camelCase).

export type Role = 'admin' | 'teacher' | 'parent' | 'student';
export type Status = 'present' | 'late' | 'absent';
export type LogLevel = 'info' | 'warning' | 'error';
export type NotificationKind = 'late' | 'absent' | 'limit' | 'info';

export interface UserRow {
  id: string;
  name: string;
  /** The account's ID, used to sign in (students: digits; teachers t…, parents p…, admins a…). */
  login_id: string;
  password_hash: string;
  role: Role;
  email: string | null;
  phone: string | null;
}

export interface ClassRow {
  id: string;
  name: string;
  start_time: string;
  end_time: string;
  late_after_minutes: number;
  max_absences: number;
  /** Days of the week the class meets: 0 = Sunday … 6 = Saturday. */
  days: number[];
}

export interface AttendanceRow {
  id: string;
  student_id: string;
  class_id: string;
  date: string;
  status: Status;
  time: string | null;
  method: 'face' | 'manual' | 'auto';
}

export interface NotificationRow {
  id: string;
  user_id: string;
  kind: NotificationKind;
  message: string;
  created_at: Date;
  read: boolean;
}

export interface LogRow {
  id: string;
  at: Date;
  level: LogLevel;
  message: string;
}

// ------------------------------------------------------------ API mappers

/** `links` are the user's children (parents) or classes (students). */
export const toUser = (u: UserRow, links: string[] = []) => ({
  id: u.id,
  name: u.name,
  /** The ID the account signs in with. */
  loginId: u.login_id,
  role: u.role,
  email: u.email ?? undefined,
  phone: u.phone ?? undefined,
  childIds: u.role === 'parent' ? links : undefined,
  classIds: u.role === 'student' ? links : undefined,
  studentNumber: u.role === 'student' ? u.login_id : undefined,
  teacherNumber: u.role === 'teacher' ? u.login_id : undefined,
});

export const toClass = (c: ClassRow, teacherIds: string[]) => ({
  id: c.id,
  name: c.name,
  startTime: c.start_time,
  endTime: c.end_time,
  lateAfterMinutes: c.late_after_minutes,
  maxAbsences: c.max_absences,
  days: [...c.days].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7)),
  teacherIds,
});

export const toRecord = (r: AttendanceRow) => ({
  id: r.id,
  studentId: r.student_id,
  classId: r.class_id,
  date: r.date,
  status: r.status,
  time: r.time ?? undefined,
  method: r.method,
});

export const toNotification = (n: NotificationRow) => ({
  id: n.id,
  userId: n.user_id,
  kind: n.kind,
  message: n.message,
  createdAt: n.created_at.toISOString(),
  read: n.read,
});

export const toLog = (l: LogRow) => ({ id: l.id, at: l.at.toISOString(), level: l.level, message: l.message });
