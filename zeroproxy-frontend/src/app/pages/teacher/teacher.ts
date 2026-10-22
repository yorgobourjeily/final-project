import { ChangeDetectionStrategy, Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { AuthService } from '../../auth.service';
import { DataService } from '../../data.service';
import { Status } from '../../models';
import { dateKey, toMinutes } from '../../utils';
import { AttendanceSummary } from '../../shared/attendance-summary/attendance-summary';
import { AttendanceTable } from '../../shared/attendance-table/attendance-table';
import { NotificationList } from '../../shared/notification-list/notification-list';
import { StatusBadge } from '../../shared/status-badge/status-badge';

type Tab = 'sheet' | 'history' | 'class' | 'alerts';

@Component({
  selector: 'app-teacher',
  imports: [AttendanceSummary, AttendanceTable, NotificationList, StatusBadge],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './teacher.html',
  styleUrl: './teacher.css',
})
export class Teacher {
  protected readonly data = inject(DataService);
  protected readonly user = inject(AuthService).user;
  protected readonly today = dateKey();

  protected readonly tab = signal<Tab>('sheet');
  protected readonly date = signal(this.today);
  protected readonly message = signal('');
  protected readonly historyOf = signal<string | null>(null);

  protected readonly maxAbsences = computed(() => this.data.settings().maxAbsences);
  protected readonly lateAfter = computed(() => {
    const { startTime, lateAfterMinutes } = this.data.settings();
    const total = toMinutes(startTime) + lateAfterMinutes;
    return `${String(Math.floor(total / 60) % 24).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
  });

  protected readonly sheet = computed(() => {
    const date = this.date();
    const records = this.data.records();
    return this.data.enrolledStudents().map((student) => ({
      student,
      record: records.find((r) => r.studentId === student.id && r.date === date),
    }));
  });

  protected readonly overview = computed(() => {
    const records = this.data.records();
    return this.data.enrolledStudents().map((student) => {
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
  protected readonly selectedHistory = computed(() => this.data.recordsOf(this.historyOf() ?? ''));
  protected readonly notEnrolled = computed(() => this.data.students().filter((s) => !s.enrolled));
  protected readonly notifications = computed(() => this.data.notificationsOf(this.user()?.id ?? ''));
  protected readonly unread = computed(() => this.notifications().filter((n) => !n.read).length);

  constructor() {
    // Unmarked students count as absent: right away for past days, after the late cutoff for today.
    effect(() => {
      const date = this.date();
      this.data.enrolledStudents();
      untracked(() => {
        if (date < this.today) this.data.markUnmarkedAbsent(date);
        else this.data.autoMarkAbsentToday();
      });
    });
  }

  protected onDate(event: Event) {
    const value = (event.target as HTMLInputElement).value;
    if (value) this.date.set(value);
    this.message.set('');
  }

  protected onStatus(studentId: string, event: Event) {
    const value = (event.target as HTMLSelectElement).value as Status;
    this.data.setStatus(studentId, this.date(), value);
    const name = this.data.user(studentId)?.name;
    this.message.set(
      value === 'late' || value === 'absent'
        ? `${name} marked ${value}. Their parent has been notified.`
        : `${name} updated.`,
    );
  }

  protected onTime(studentId: string, event: Event) {
    const time = (event.target as HTMLInputElement).value;
    if (!time) return;
    const status = this.data.setArrivalTime(studentId, this.date(), time);
    const name = this.data.user(studentId)?.name;
    this.message.set(
      status === 'late'
        ? `${name} arrived at ${time} and is marked late. Their parent has been notified.`
        : `${name} arrived at ${time} and is marked present.`,
    );
  }

  protected onStartTime(event: Event) {
    const startTime = (event.target as HTMLInputElement).value;
    if (!startTime) return;
    this.data.updateSettings({ ...this.data.settings(), startTime });
    this.message.set(`Class start time set to ${startTime}.`);
  }

  protected onLateMinutes(event: Event) {
    const minutes = Number((event.target as HTMLInputElement).value);
    if (!Number.isFinite(minutes) || minutes < 0) return;
    this.data.updateSettings({ ...this.data.settings(), lateAfterMinutes: Math.round(minutes) });
    this.message.set(`Students are now late after ${this.lateAfter()}.`);
  }
}
