import { computed, effect, Injectable, signal } from '@angular/core';
import { addLog, alertFamily, checkAbsenceLimit, createSeedDb } from './db';
import { AttendanceRecord, Db, LogLevel, NewUser, Settings, Status, User } from './models';
import { clock, dateKey, toMinutes, uid } from './utils';

const STORAGE_KEY = 'zeroproxy-db-v1';

function loadDb(): Db {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as Db) : null;
    if (parsed && Array.isArray(parsed.users) && Array.isArray(parsed.records)) return parsed;
  } catch {
    // Storage blocked or corrupt: fall back to fresh demo data.
  }
  return createSeedDb();
}

/**
 * The whole "database" of the app. Everything lives in the browser (localStorage);
 * there is no server.
 */
@Injectable({ providedIn: 'root' })
export class DataService {
  private readonly db = signal<Db>(loadDb());

  readonly users = computed(() => this.db().users);
  readonly records = computed(() => this.db().records);
  readonly notifications = computed(() => this.db().notifications);
  readonly logs = computed(() => this.db().logs);
  readonly settings = computed(() => this.db().settings);
  readonly students = computed(() => this.users().filter((u) => u.role === 'student'));
  readonly enrolledStudents = computed(() => this.students().filter((s) => s.enrolled));
  readonly storageOk = signal(true);

  private readonly persist = effect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.db()));
      this.storageOk.set(true);
    } catch {
      this.storageOk.set(false);
    }
  });

  constructor() {
    // Students who haven't scanned in by the late cutoff are marked absent automatically.
    this.autoMarkAbsentToday();
    setInterval(() => this.autoMarkAbsentToday(), 60_000);
  }

  // ------------------------------------------------------------ queries

  user(id: string | undefined): User | undefined {
    return this.users().find((u) => u.id === id);
  }

  recordsOf(studentId: string): AttendanceRecord[] {
    return this.records()
      .filter((r) => r.studentId === studentId)
      .sort((a, b) => b.date.localeCompare(a.date));
  }

  recordOn(studentId: string, date: string): AttendanceRecord | undefined {
    return this.records().find((r) => r.studentId === studentId && r.date === date);
  }

  notificationsOf(userId: string) {
    return this.notifications().filter((n) => n.userId === userId);
  }

  /** Status a student arriving at `when` would get. */
  statusAt(when: Date): Exclude<Status, 'absent'> {
    return this.statusForTime(clock(when));
  }

  /** Status for an arrival time given as HH:mm. */
  statusForTime(time: string): Exclude<Status, 'absent'> {
    const { startTime, lateAfterMinutes } = this.settings();
    return toMinutes(time) > toMinutes(startTime) + lateAfterMinutes ? 'late' : 'present';
  }

  // ------------------------------------------------------------ attendance

  /**
   * Called after the camera recognises a student. Returns today's record.
   * A scan replaces an automatic absence (the student arrived after the cutoff).
   */
  markByFace(studentId: string): AttendanceRecord {
    const date = dateKey();
    const existing = this.recordOn(studentId, date);
    if (existing && existing.method !== 'auto') return existing;

    const now = new Date();
    const record: AttendanceRecord = {
      id: uid(),
      studentId,
      date,
      status: this.statusAt(now),
      time: clock(now),
      method: 'face',
    };

    this.change((db) => {
      db.records = db.records.filter((r) => !(r.studentId === studentId && r.date === date));
      db.records.push(record);
      addLog(db, 'info', `${this.user(studentId)?.name} recognised by camera, marked ${record.status}`);
      if (record.status === 'late') alertFamily(db, studentId, 'late', date, record.time);
    });
    return record;
  }

  /** After today's late cutoff, marks every unmarked student absent (weekdays only). */
  autoMarkAbsentToday() {
    const now = new Date();
    if (now.getDay() === 0 || now.getDay() === 6) return;
    if (this.statusAt(now) === 'late') this.markUnmarkedAbsent(dateKey(now));
  }

  /** Teacher edit. `null` clears the record for that day. */
  setStatus(studentId: string, date: string, status: Status | null) {
    const previous = this.recordOn(studentId, date);
    if (previous?.status === status || (!previous && status === null)) return;

    this.change((db) => {
      db.records = db.records.filter((r) => !(r.studentId === studentId && r.date === date));
      const name = this.user(studentId)?.name;

      if (status === null) {
        addLog(db, 'info', `Teacher cleared attendance of ${name} on ${date}`);
        return;
      }

      const time = status === 'absent' ? undefined : (previous?.time ?? clock());
      db.records.push({ id: uid(), studentId, date, status, time, method: 'manual' });
      addLog(db, 'info', `Teacher set ${name} to ${status} on ${date}`);

      if (status !== 'present') alertFamily(db, studentId, status, date, time);
      if (status === 'absent') checkAbsenceLimit(db, studentId);
    });
  }

  /**
   * Teacher enters the time a student arrived. Present or late is worked out from
   * the class start time. Returns the resulting status.
   */
  setArrivalTime(studentId: string, date: string, time: string): Status {
    const previous = this.recordOn(studentId, date);
    const status = this.statusForTime(time);
    if (previous?.time === time && previous.status === status) return status;

    this.change((db) => {
      db.records = db.records.filter((r) => !(r.studentId === studentId && r.date === date));
      db.records.push({ id: uid(), studentId, date, status, time, method: 'manual' });
      addLog(db, 'info', `Teacher set arrival of ${this.user(studentId)?.name} to ${time} on ${date} (${status})`);
      if (status === 'late' && previous?.status !== 'late') alertFamily(db, studentId, 'late', date, time);
    });
    return status;
  }

  /** Marks every enrolled student with no record on `date` as absent. Returns how many. */
  markUnmarkedAbsent(date: string): number {
    const missing = this.enrolledStudents().filter((s) => !this.recordOn(s.id, date));
    if (missing.length === 0) return 0;

    this.change((db) => {
      for (const s of missing) {
        db.records.push({ id: uid(), studentId: s.id, date, status: 'absent', method: 'auto' });
        alertFamily(db, s.id, 'absent', date);
        checkAbsenceLimit(db, s.id);
      }
      addLog(db, 'info', `Unmarked students on ${date} marked absent: ${missing.map((s) => s.name).join(', ')}`);
    });
    return missing.length;
  }

  setEnrolled(studentId: string, enrolled: boolean) {
    this.change((db) => {
      const student = db.users.find((u) => u.id === studentId);
      if (!student) return;
      student.enrolled = enrolled;
      addLog(db, 'info', `${student.name} ${enrolled ? 'added to' : 'removed from'} the class sheet`);
    });
  }

  // ------------------------------------------------------------ accounts

  /** Returns an error message, or null on success. */
  createUser(input: NewUser): string | null {
    const username = input.username.trim().toLowerCase();
    if (this.users().some((u) => u.username === username)) return `Username "${username}" is already taken.`;

    this.change((db) => {
      db.users.push({ ...input, username, id: uid(), enrolled: input.role === 'student' ? true : undefined });
      addLog(db, 'info', `Account created: ${input.name} (${input.role})`);
    });
    return null;
  }

  deleteUser(id: string) {
    this.change((db) => {
      const user = db.users.find((u) => u.id === id);
      if (!user) return;
      db.users = db.users.filter((u) => u.id !== id);
      db.records = db.records.filter((r) => r.studentId !== id);
      db.notifications = db.notifications.filter((n) => n.userId !== id);
      db.users.forEach((u) => {
        if (u.childId === id) delete u.childId;
      });
      addLog(db, 'warning', `Account deleted: ${user.name} (${user.role})`);
    });
  }

  // ------------------------------------------------------------ misc

  markAllRead(userId: string) {
    this.change((db) => db.notifications.forEach((n) => n.userId === userId && (n.read = true)));
  }

  updateSettings(settings: Settings) {
    this.change((db) => {
      db.settings = settings;
      addLog(db, 'info', `Settings updated: class starts ${settings.startTime}, late after ${settings.lateAfterMinutes} min, max ${settings.maxAbsences} absences`);
    });
  }

  log(level: LogLevel, message: string) {
    this.change((db) => addLog(db, level, message));
  }

  resetDemoData() {
    this.db.set(createSeedDb());
  }

  private change(fn: (draft: Db) => void) {
    this.db.update((current) => {
      const draft = structuredClone(current);
      fn(draft);
      return draft;
    });
  }
}
