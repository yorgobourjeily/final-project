import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { DatePipe } from '@angular/common';
import { AuthService } from '../../auth.service';
import { DataService } from '../../data.service';
import { dateKey } from '../../utils';
import { AttendanceSummary } from '../../shared/attendance-summary/attendance-summary';
import { AttendanceTable } from '../../shared/attendance-table/attendance-table';
import { CameraScan } from '../../shared/camera-scan/camera-scan';
import { NotificationList } from '../../shared/notification-list/notification-list';
import { StatusBadge } from '../../shared/status-badge/status-badge';

@Component({
  selector: 'app-student',
  imports: [DatePipe, AttendanceSummary, AttendanceTable, CameraScan, NotificationList, StatusBadge],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './student.html',
  styleUrl: './student.css',
})
export class Student {
  protected readonly data = inject(DataService);
  protected readonly user = inject(AuthService).user;
  protected readonly settings = this.data.settings;
  protected readonly today = new Date();

  protected readonly history = computed(() => this.data.recordsOf(this.user()?.id ?? ''));
  protected readonly todayRecord = computed(() => this.history().find((r) => r.date === dateKey()));
  protected readonly notifications = computed(() => this.data.notificationsOf(this.user()?.id ?? ''));
  protected readonly lateAfter = computed(() => {
    const { startTime, lateAfterMinutes } = this.settings();
    const [h, m] = startTime.split(':').map(Number);
    const total = h * 60 + m + lateAfterMinutes;
    return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
  });

  protected markAttendance(studentId: string) {
    this.data.markByFace(studentId);
  }
}
