export type Role = 'admin' | 'teacher' | 'parent' | 'student';
export type Status = 'present' | 'late' | 'absent';

export interface User {
  id: string;
  name: string;
  username: string;
  password: string;
  role: Role;
  email?: string;
  phone?: string;
  /** Parents only: the student this parent is linked to. */
  childId?: string;
  /** Students only: whether they are on the class attendance sheet. */
  enrolled?: boolean;
}

export type NewUser = Omit<User, 'id'>;

export interface AttendanceRecord {
  id: string;
  studentId: string;
  /** YYYY-MM-DD */
  date: string;
  status: Status;
  /** HH:mm, when the student arrived. */
  time?: string;
  /** face = camera scan, manual = edited by teacher, auto = marked absent at end of day. */
  method: 'face' | 'manual' | 'auto';
}

export type NotificationKind = 'late' | 'absent' | 'limit' | 'info';

export interface AppNotification {
  id: string;
  userId: string;
  kind: NotificationKind;
  message: string;
  createdAt: string;
  read: boolean;
}

export type LogLevel = 'info' | 'warning' | 'error';

export interface LogEntry {
  id: string;
  at: string;
  level: LogLevel;
  message: string;
}

export interface Settings {
  /** HH:mm when class starts. */
  startTime: string;
  /** Minutes after the start time before an arrival counts as late. */
  lateAfterMinutes: number;
  /** Maximum allowed absences per student. */
  maxAbsences: number;
}

export interface Db {
  users: User[];
  records: AttendanceRecord[];
  notifications: AppNotification[];
  logs: LogEntry[];
  settings: Settings;
}

export const ROLE_LABELS: Record<Role, string> = {
  admin: 'Admin',
  teacher: 'Teacher',
  parent: 'Parent',
  student: 'Student',
};
