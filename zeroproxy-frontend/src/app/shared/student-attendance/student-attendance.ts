import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { DataService } from '../../data.service';
import { dateKey, daysText } from '../../utils';
import { AttendanceTable } from '../attendance-table/attendance-table';
import { StatusBadge } from '../status-badge/status-badge';

/** One student's attendance, class by class: today, a summary per class, and the full history. */
@Component({
  selector: 'app-student-attendance',
  imports: [AttendanceTable, StatusBadge],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './student-attendance.html',
  styleUrl: './student-attendance.css',
})
export class StudentAttendance {
  private readonly data = inject(DataService);

  readonly studentId = input.required<string>();

  /** Each class the student is in, with today's record and the totals so far. */
  protected readonly classes = computed(() => {
    const today = dateKey();
    return this.data.classesOf(this.studentId()).map((schoolClass) => {
      const records = this.data.recordsOf(this.studentId(), schoolClass.id);
      const count = (status: string) => records.filter((r) => r.status === status).length;
      const absent = count('absent');
      return {
        schoolClass,
        days: daysText(schoolClass.days),
        meetsToday: this.data.hasClassOn(schoolClass, today),
        cancelledToday: !!this.data.cancellation(schoolClass.id, today),
        lateAfter: this.data.lateCutoff(schoolClass),
        today: this.data.recordOn(this.studentId(), schoolClass.id, today),
        present: count('present'),
        late: count('late'),
        absent,
        rate: records.length ? Math.round(((records.length - absent) / records.length) * 100) : 100,
      };
    });
  });

  protected readonly history = computed(() => this.data.recordsOf(this.studentId()));
  /** Today's school-wide day off, if any. */
  protected readonly dayOffToday = computed(() => this.data.dayOff(dateKey()));
}
