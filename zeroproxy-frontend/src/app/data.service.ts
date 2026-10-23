import { computed, Injectable, signal } from '@angular/core';
import { api, ApiError, session } from './api';
import { AttendanceRecord, ClassCancellation, DayOff, Db, LogLevel, NewClass, NewUser, Role, SchoolClass, Status, User } from './models';
import { addMinutes, toMinutes, weekdayOf } from './utils';

/** What the server answers to a camera scan. */
export interface ScanReply {
  student: { name: string; id: string; class: string };
  date: string;
  /** Arrival time (HH:mm). */
  time: string;
  /** Arrivals after this time count as late. */
  lateAfter: string;
  minutesLate: number;
  status: Status;
  alreadyMarked: boolean;
  message: string;
}

/** One row of a submitted attendance sheet. */
export type SheetEntry = { studentId: string } & ({ status: Status } | { time: string });

/** Account IDs: students digits only, teachers t…, parents p…, admins a… (see nextLoginId). */
const ID_PREFIX: Record<Role, string> = { student: '', teacher: 't', parent: 'p', admin: 'a' };
const ID_START: Record<Role, number> = { student: 1, parent: 1, teacher: 1, admin: 1 };

const EMPTY: Db = { users: [], classes: [], records: [], notifications: [], logs: [], settings: { maxAbsences: 5 }, daysOff: [], cancellations: [] };

/**
 * Everything the signed-in user may see, loaded from zeroproxy-backend.
 * Changes are sent to the API, then the data is reloaded so all pages stay in sync.
 */
@Injectable({ providedIn: 'root' })
export class DataService {
  private readonly db = signal<Db>(EMPTY);

  readonly users = computed(() => this.db().users);
  readonly classes = computed(() => this.db().classes);
  readonly records = computed(() => this.db().records);
  readonly notifications = computed(() => this.db().notifications);
  readonly logs = computed(() => this.db().logs);
  readonly settings = computed(() => this.db().settings);
  readonly daysOff = computed(() => this.db().daysOff ?? []);
  readonly cancellations = computed(() => this.db().cancellations ?? []);
  readonly students = computed(() => this.users().filter((u) => u.role === 'student'));
  readonly teachers = computed(() => this.users().filter((u) => u.role === 'teacher'));
  readonly parents = computed(() => this.users().filter((u) => u.role === 'parent'));
  /** False when the last request could not reach the server. */
  readonly online = signal(true);

  constructor() {
    // Pick up camera scans and changes made by other users within a few seconds.
    setInterval(() => {
      if (session.token) this.load().catch(() => undefined);
    }, 5_000);
  }

  // ------------------------------------------------------------ loading

  async load(): Promise<void> {
    this.db.set(await this.request<Db>('GET', '/state'));
  }

  clear() {
    this.db.set(EMPTY);
  }

  // ------------------------------------------------------------ queries

  user(id: string | undefined): User | undefined {
    return this.users().find((u) => u.id === id);
  }

  schoolClass(id: string | undefined): SchoolClass | undefined {
    return this.classes().find((c) => c.id === id);
  }

  /** The classes a student is in, earliest start first. */
  classesOf(studentId: string): SchoolClass[] {
    const ids = this.user(studentId)?.classIds ?? [];
    return this.classes()
      .filter((c) => ids.includes(c.id))
      .sort((a, b) => a.startTime.localeCompare(b.startTime) || a.name.localeCompare(b.name));
  }

  /** "Grade 10 – A, Computer Science", or "" when the student is in no class. */
  classNamesOf(studentId: string): string {
    return this.classesOf(studentId)
      .map((c) => c.name)
      .join(', ');
  }

  /** Students linked to a parent. */
  childrenOf(parentId: string): User[] {
    const ids = this.user(parentId)?.childIds ?? [];
    return this.students().filter((s) => ids.includes(s.id));
  }

  /** Parents linked to a student (only known to the admin, who receives all users). */
  parentsOf(studentId: string): User[] {
    return this.parents().filter((p) => p.childIds?.includes(studentId));
  }

  studentsIn(classId: string): User[] {
    return this.students().filter((s) => s.classIds?.includes(classId));
  }

  classesOfTeacher(teacherId: string): SchoolClass[] {
    return this.classes().filter((c) => c.teacherIds.includes(teacherId));
  }

  /** A student's records, newest first; only one class's when `classId` is given. */
  recordsOf(studentId: string, classId?: string): AttendanceRecord[] {
    return this.records()
      .filter((r) => r.studentId === studentId && (!classId || r.classId === classId))
      .sort((a, b) => b.date.localeCompare(a.date) || this.startOf(a.classId).localeCompare(this.startOf(b.classId)));
  }

  recordOn(studentId: string, classId: string, date: string): AttendanceRecord | undefined {
    return this.records().find((r) => r.studentId === studentId && r.classId === classId && r.date === date);
  }

  notificationsOf(userId: string) {
    return this.notifications().filter((n) => n.userId === userId);
  }

  /**
   * The ID the next new account of this role will get (same rule as the server): the lowest free number
   * from 1 for the role, so IDs of deleted accounts are reused. Students 1…, parents p1…,
   * teachers t1…, admins a1….
   */
  nextLoginId(role: Role): string {
    const prefix = ID_PREFIX[role];
    const used = new Set(
      this.users()
        .filter((u) => u.role === role && new RegExp(`^${prefix}\\d+$`).test(u.loginId))
        .map((u) => Number(u.loginId.slice(prefix.length))),
    );
    let n = ID_START[role];
    while (used.has(n)) n++;
    return `${prefix}${n}`;
  }

  private startOf(classId: string): string {
    return this.schoolClass(classId)?.startTime ?? '';
  }

  /**
   * Which class a camera scan at `time` today counts for (same rule as the server): the student's
   * earliest class that has not ended and that they are not marked for yet.
   */
  classForArrival(studentId: string, date: string, time: string): SchoolClass | undefined {
    const marked = this.records().filter((r) => r.studentId === studentId && r.date === date && r.method !== 'auto');
    return this.classesOf(studentId).find(
      (c) => this.hasClassOn(c, date) && toMinutes(time) < toMinutes(c.endTime) && !marked.some((r) => r.classId === c.id),
    );
  }

  /** Whether the class's weekly schedule includes that date's weekday (YYYY-MM-DD). */
  meetsOn(schoolClass: SchoolClass, date: string): boolean {
    return schoolClass.days.includes(weekdayOf(date));
  }

  /** The school-wide day off on that date, if any. */
  dayOff(date: string): DayOff | undefined {
    return this.daysOff().find((d) => d.date === date);
  }

  /** The cancellation of that class on that date, if it is cancelled. */
  cancellation(classId: string, date: string): ClassCancellation | undefined {
    return this.cancellations().find((c) => c.classId === classId && c.date === date);
  }

  /** Whether the class actually takes place that date: on its schedule, not a day off and not cancelled. */
  hasClassOn(schoolClass: SchoolClass, date: string): boolean {
    return this.meetsOn(schoolClass, date) && !this.dayOff(date) && !this.cancellation(schoolClass.id, date);
  }

  /** HH:mm after which arrivals in this class count as late. */
  lateCutoff(schoolClass: SchoolClass): string {
    return addMinutes(schoolClass.startTime, schoolClass.lateAfterMinutes);
  }

  /** Status for an arrival time (HH:mm) in the given class (same rule as the server). */
  statusForTime(schoolClass: SchoolClass | undefined, time: string): Exclude<Status, 'absent'> {
    if (!schoolClass) return 'present';
    return toMinutes(time) > toMinutes(this.lateCutoff(schoolClass)) ? 'late' : 'present';
  }

  // ------------------------------------------------------------ changes
  // Each returns an error message, or null on success.

  /**
   * Admin test: sends a scan exactly like the camera machine ({ id, time }).
   * Returns the server's reply, or throws with its error message.
   */
  async testScan(id: string, time: string): Promise<ScanReply> {
    const reply = await this.request<ScanReply>('POST', '/scans', { id, time });
    await this.load();
    return reply;
  }

  /**
   * Teacher submits a class's attendance sheet for one day. Each entry is a status, or an
   * arrival time (present or late is worked out from the class times). Saved all together.
   */
  submitAttendance(classId: string, date: string, entries: SheetEntry[]) {
    return this.mutate('PUT', `/classes/${classId}/attendance/${date}`, { entries });
  }

  markUnmarkedAbsent(classId: string, date: string) {
    return this.mutate('POST', `/classes/${classId}/mark-absent`, { date });
  }

  createClass(input: NewClass) {
    return this.mutate('POST', '/classes', input);
  }

  updateClass(classId: string, changes: Partial<NewClass>) {
    return this.mutate('PATCH', `/classes/${classId}`, changes);
  }

  deleteClass(classId: string) {
    return this.mutate('DELETE', `/classes/${classId}`);
  }

  setTeacherInClass(classId: string, teacherId: string, inClass: boolean) {
    return this.mutate(inClass ? 'PUT' : 'DELETE', `/classes/${classId}/teachers/${teacherId}`);
  }

  /** Adds a student to a class, or removes them. A student can be in several classes. */
  setStudentInClass(classId: string, studentId: string, inClass: boolean) {
    return this.mutate(inClass ? 'PUT' : 'DELETE', `/classes/${classId}/students/${studentId}`);
  }

  /** Links a parent to a student, or removes that link. A parent can have several children and vice versa. */
  setParentChild(parentId: string, studentId: string, linked: boolean) {
    return this.mutate(linked ? 'PUT' : 'DELETE', `/users/${parentId}/children/${studentId}`);
  }

  /** Creates an account; returns the new account (with its ID) or an error message. */
  async createUser(input: NewUser): Promise<{ error?: string; user?: User }> {
    try {
      const user = await this.request<User>('POST', '/users', input);
      await this.load();
      return { user };
    } catch (err) {
      return { error: err instanceof Error ? err.message : 'Something went wrong.' };
    }
  }

  deleteUser(id: string) {
    return this.mutate('DELETE', `/users/${id}`);
  }

  markAllRead(userId: string) {
    // Update the screen straight away; the server catches up.
    this.db.update((db) => ({
      ...db,
      notifications: db.notifications.map((n) => (n.userId === userId ? { ...n, read: true } : n)),
    }));
    return this.mutate('POST', '/notifications/read-all');
  }

  /** Deletes all of a user's notifications. */
  clearNotifications(userId: string) {
    this.db.update((db) => ({ ...db, notifications: db.notifications.filter((n) => n.userId !== userId) }));
    return this.mutate('DELETE', '/notifications');
  }

  /** Deletes one notification. */
  deleteNotification(id: string) {
    this.db.update((db) => ({ ...db, notifications: db.notifications.filter((n) => n.id !== id) }));
    return this.mutate('DELETE', `/notifications/${id}`);
  }

  /** Marks a date as a school-wide day off (or changes its reason). */
  setDayOff(date: string, reason: string) {
    return this.mutate('PUT', `/days-off/${date}`, { reason });
  }

  /** Cancels one class on one date (no attendance taken), or restores it. */
  setClassCancelled(classId: string, date: string, cancelled: boolean) {
    return this.mutate(cancelled ? 'PUT' : 'DELETE', `/classes/${classId}/cancellations/${date}`, cancelled ? {} : undefined);
  }

  /** Makes a day off a normal school day again. */
  removeDayOff(date: string) {
    return this.mutate('DELETE', `/days-off/${date}`);
  }

  resetDemoData() {
    return this.mutate('POST', '/admin/reset');
  }

  /** Reports a warning or error to the admin's log. Never throws. */
  log(level: LogLevel, message: string) {
    if (!session.token) return;
    api('POST', '/logs', { level, message }).catch(() => undefined);
  }

  // ------------------------------------------------------------ helpers

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    try {
      const result = await api<T>(method, path, body);
      this.online.set(true);
      return result;
    } catch (err) {
      if (err instanceof ApiError && err.status === 0) this.online.set(false);
      if (err instanceof ApiError && err.status === 401) {
        // Session expired or account deleted: drop everything so the app returns to the login page.
        session.clear();
        this.clear();
      }
      throw err;
    }
  }

  private async mutate(method: string, path: string, body?: unknown): Promise<string | null> {
    try {
      await this.request(method, path, body);
      await this.load();
      return null;
    } catch (err) {
      return err instanceof Error ? err.message : 'Something went wrong.';
    }
  }
}
