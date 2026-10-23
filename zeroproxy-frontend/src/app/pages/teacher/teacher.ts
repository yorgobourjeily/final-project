import { ChangeDetectionStrategy, Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { AuthService } from '../../auth.service';
import { DataService, SheetEntry } from '../../data.service';
import { NewClass, Status } from '../../models';
import { dateKey, dayPlural, daysText } from '../../utils';
import { AttendanceSummary } from '../../shared/attendance-summary/attendance-summary';
import { AttendanceTable } from '../../shared/attendance-table/attendance-table';
import { NotificationList } from '../../shared/notification-list/notification-list';
import { StatusBadge } from '../../shared/status-badge/status-badge';
import { TeacherCalendar } from './teacher-calendar/teacher-calendar';
import { tabInUrl } from '../../tab-state';

const TABS = ['sheet', 'history', 'calendar', 'alerts'] as const;

/** An unsaved change on the sheet: an arrival time, or a chosen status. */
type Draft = { time: string } | { status: Status };

type ClassTimes = Partial<Pick<NewClass, 'startTime' | 'endTime' | 'lateAfterMinutes'>>;

@Component({
  selector: 'app-teacher',
  imports: [AttendanceSummary, AttendanceTable, NotificationList, StatusBadge, TeacherCalendar],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './teacher.html',
  styleUrl: './teacher.css',
})
export class Teacher {
  protected readonly data = inject(DataService);
  protected readonly user = inject(AuthService).user;
  protected readonly today = dateKey();
  protected readonly daysText = daysText;
  protected readonly dayPlural = dayPlural;

  protected readonly tab = tabInUrl(TABS, 'sheet');
  protected readonly date = signal(this.today);
  protected readonly message = signal('');
  protected readonly error = signal('');
  protected readonly saving = signal(false);
  protected readonly historyOf = signal<string | null>(null);
  private readonly chosenClassId = signal<string | null>(null);

  /** Unsaved sheet changes by student id, and unsaved class time changes. Sent on Submit. */
  private readonly drafts = signal<Record<string, Draft>>({});
  private readonly timesDraft = signal<ClassTimes>({});

  /** Classes this teacher teaches. */
  protected readonly myClasses = computed(() => this.data.classesOfTeacher(this.user()?.id ?? ''));
  /** The class shown on the page: the one picked, or the first one. */
  protected readonly currentClass = computed(() => {
    const classes = this.myClasses();
    return classes.find((c) => c.id === this.chosenClassId()) ?? classes[0];
  });
  /** The current class with unsaved time changes applied, to preview present/late. */
  protected readonly editedClass = computed(() => {
    const c = this.currentClass();
    return c ? { ...c, ...this.timesDraft() } : undefined;
  });
  protected readonly classStudents = computed(() => {
    const c = this.currentClass();
    return c ? this.data.studentsIn(c.id) : [];
  });

  protected readonly maxAbsences = computed(() => this.currentClass()?.maxAbsences ?? this.data.settings().maxAbsences);
  protected readonly lateAfter = computed(() => {
    const c = this.editedClass();
    return c ? this.data.lateCutoff(c) : '';
  });

  /** The school-wide day off on the chosen date, if any. */
  protected readonly dayOff = computed(() => this.data.dayOff(this.date()));
  /** Whether the admin cancelled the current class on the chosen date. */
  protected readonly cancelled = computed(() => {
    const cls = this.currentClass();
    return !!cls && !!this.data.cancellation(cls.id, this.date());
  });

  /** Whether the current class takes place on the chosen date (on its schedule and not a day off). */
  protected readonly meetsOnDate = computed(() => {
    const cls = this.currentClass();
    return !!cls && this.data.hasClassOn(cls, this.date());
  });

  /** Sheet rows: what is saved, overlaid with what the teacher has changed but not submitted yet. */
  protected readonly sheet = computed(() => {
    const date = this.date();
    const drafts = this.drafts();
    const cls = this.editedClass();
    if (!this.meetsOnDate()) return []; // no class that day, so nobody to mark
    const records = this.data.records().filter((r) => r.classId === cls?.id && r.date === date);
    return this.classStudents().map((student) => {
      const record = records.find((r) => r.studentId === student.id);
      const draft = drafts[student.id];
      let status: Status | undefined = record?.status;
      let time = record?.time ?? '';
      if (draft && 'time' in draft) {
        time = draft.time;
        status = this.data.statusForTime(cls, draft.time);
      } else if (draft) {
        status = draft.status;
        if (status === 'absent') time = '';
      }
      return { student, record, status, time, changed: !!draft };
    });
  });

  protected readonly unmarkedCount = computed(() => this.sheet().filter((r) => !r.status).length);
  protected readonly changeCount = computed(
    () => Object.keys(this.drafts()).length + (Object.keys(this.timesDraft()).length ? 1 : 0),
  );
  protected readonly canSubmit = computed(() => this.changeCount() > 0 || this.unmarkedCount() > 0);

  /** Totals per student, in this class only. */
  protected readonly overview = computed(() => {
    const classId = this.currentClass()?.id;
    const records = this.data.records().filter((r) => r.classId === classId);
    return this.classStudents().map((student) => {
      const mine = records.filter((r) => r.studentId === student.id);
      return {
        student,
        present: mine.filter((r) => r.status === 'present').length,
        late: mine.filter((r) => r.status === 'late').length,
        absent: mine.filter((r) => r.status === 'absent').length,
      };
    });
  });

  protected readonly selectedStudent = computed(() => this.data.user(this.historyOf() ?? undefined));
  protected readonly selectedHistory = computed(() => this.data.recordsOf(this.historyOf() ?? '', this.currentClass()?.id ?? ''));
  protected readonly notifications = computed(() => this.data.notificationsOf(this.user()?.id ?? ''));
  protected readonly unread = computed(() => this.notifications().filter((n) => !n.read).length);

  private readonly currentClassId = computed(() => this.currentClass()?.id);
  /** "classId|date" pairs already closed, so a past day is only sent once. */
  private readonly closedDays = new Set<string>();

  constructor() {
    // Unmarked students on past days count as absent. (For today, the server does it after the late cutoff.)
    effect(() => {
      const date = this.date();
      const classId = this.currentClassId();
      if (!classId || date >= this.today) return;
      const key = `${classId}|${date}`;
      if (this.closedDays.has(key)) return;
      this.closedDays.add(key);
      untracked(() => this.data.markUnmarkedAbsent(classId, date));
    });
  }

  // ------------------------------------------------------------ picking class and day

  protected onClass(event: Event) {
    this.chosenClassId.set((event.target as HTMLSelectElement).value);
    this.historyOf.set(null);
    this.clearFeedback();
  }

  protected onDate(event: Event) {
    const value = (event.target as HTMLInputElement).value;
    if (value) this.date.set(value);
    this.clearFeedback();
  }

  // ------------------------------------------------------------ editing (kept until Submit)

  protected onStatus(studentId: string, event: Event) {
    const status = (event.target as HTMLSelectElement).value as Status;
    const saved = this.savedRecord(studentId)?.status;
    this.setDraft(studentId, status === saved ? null : { status });
  }

  protected onTime(studentId: string, event: Event) {
    const time = (event.target as HTMLInputElement).value;
    if (!time) return;
    const saved = this.savedRecord(studentId);
    const unchanged = saved?.time === time && saved.status === this.data.statusForTime(this.editedClass(), time);
    this.setDraft(studentId, unchanged ? null : { time });
  }

  protected onClassTime(field: 'startTime' | 'endTime', event: Event) {
    const value = (event.target as HTMLInputElement).value;
    if (value) this.setTimesDraft(field, value);
  }

  protected onLateMinutes(event: Event) {
    const minutes = Number((event.target as HTMLInputElement).value);
    if (Number.isFinite(minutes) && minutes >= 0) this.setTimesDraft('lateAfterMinutes', Math.round(minutes));
  }

  /** The saved record of a student in this class on the selected day. */
  private savedRecord(studentId: string) {
    const classId = this.currentClass()?.id;
    return classId ? this.data.recordOn(studentId, classId, this.date()) : undefined;
  }

  private setDraft(studentId: string, draft: Draft | null) {
    this.drafts.update((all) => {
      const next = { ...all };
      if (draft) next[studentId] = draft;
      else delete next[studentId];
      return next;
    });
    this.clearFeedback();
  }

  private setTimesDraft<K extends keyof ClassTimes>(field: K, value: NonNullable<ClassTimes[K]>) {
    const saved = this.currentClass()?.[field];
    this.timesDraft.update((t) => {
      const next = { ...t };
      if (value === saved) delete next[field];
      else next[field] = value;
      return next;
    });
    this.clearFeedback();
  }

  // ------------------------------------------------------------ submit

  /** Saves the class times and the whole sheet. Students still not marked are saved as absent. */
  protected async submit() {
    const c = this.currentClass();
    if (!c || !this.canSubmit() || this.saving()) return;
    this.saving.set(true);
    this.clearFeedback();

    const times = this.timesDraft();
    if (Object.keys(times).length) {
      const error = await this.data.updateClass(c.id, times);
      if (error) return this.failSubmit(error);
      this.timesDraft.set({});
    }

    const entries: SheetEntry[] = this.sheet()
      .filter((row) => row.changed || !row.status)
      .map((row) => {
        const draft = this.drafts()[row.student.id];
        return draft ? { studentId: row.student.id, ...draft } : { studentId: row.student.id, status: 'absent' as const };
      });
    const flagged = this.sheet().filter((row) => (row.changed || !row.status) && row.status !== 'present').length;

    if (entries.length) {
      const error = await this.data.submitAttendance(c.id, this.date(), entries);
      if (error) return this.failSubmit(error);
    }

    this.drafts.set({});
    this.saving.set(false);
    this.message.set(
      `Attendance for ${c.name} on ${this.date()} submitted.` +
        (flagged ? ` Parents of ${flagged} late or absent student(s) have been notified.` : ''),
    );
  }

  protected discard() {
    this.drafts.set({});
    this.timesDraft.set({});
    this.clearFeedback();
    this.message.set('Changes discarded.');
  }

  private failSubmit(error: string) {
    this.error.set(error);
    this.saving.set(false);
  }

  private clearFeedback() {
    this.message.set('');
    this.error.set('');
  }
}
