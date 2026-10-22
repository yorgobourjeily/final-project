import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { AttendanceRecord } from '../../models';

@Component({
  selector: 'app-attendance-summary',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './attendance-summary.html',
})
export class AttendanceSummary {
  readonly records = input.required<AttendanceRecord[]>();
  readonly maxAbsences = input.required<number>();

  protected readonly counts = computed(() => {
    const counts = { present: 0, late: 0, absent: 0 };
    for (const r of this.records()) counts[r.status]++;
    return counts;
  });

  /** Late still counts as attended. */
  protected readonly rate = computed(() => {
    const total = this.records().length;
    if (total === 0) return 100;
    return Math.round(((total - this.counts().absent) / total) * 100);
  });

  protected readonly nearLimit = computed(() => this.counts().absent >= this.maxAbsences() - 1);
}
