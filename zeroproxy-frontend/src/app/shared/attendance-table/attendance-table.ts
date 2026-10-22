import { ChangeDetectionStrategy, Component, inject, input } from '@angular/core';
import { DatePipe } from '@angular/common';
import { DataService } from '../../data.service';
import { AttendanceRecord } from '../../models';
import { StatusBadge } from '../status-badge/status-badge';

const METHOD_LABELS: Record<AttendanceRecord['method'], string> = {
  face: 'Classroom camera',
  manual: 'Edited by teacher',
  auto: 'Not scanned',
};

@Component({
  selector: 'app-attendance-table',
  imports: [DatePipe, StatusBadge],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './attendance-table.html',
})
export class AttendanceTable {
  protected readonly data = inject(DataService);
  protected readonly methodLabels = METHOD_LABELS;

  readonly records = input.required<AttendanceRecord[]>();
  readonly showStudent = input(false);
  readonly showClass = input(false);
}
