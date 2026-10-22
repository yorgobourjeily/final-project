import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { AuthService } from '../../auth.service';
import { DataService } from '../../data.service';
import { dateKey } from '../../utils';
import { AttendanceSummary } from '../../shared/attendance-summary/attendance-summary';
import { AttendanceTable } from '../../shared/attendance-table/attendance-table';
import { NotificationList } from '../../shared/notification-list/notification-list';
import { StatusBadge } from '../../shared/status-badge/status-badge';

@Component({
  selector: 'app-parent',
  imports: [AttendanceSummary, AttendanceTable, NotificationList, StatusBadge],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './parent.html',
  styleUrl: './parent.css',
})
export class Parent {
  protected readonly data = inject(DataService);
  protected readonly user = inject(AuthService).user;

  protected readonly child = computed(() => this.data.user(this.user()?.childId));
  protected readonly history = computed(() => this.data.recordsOf(this.child()?.id ?? ''));
  protected readonly todayRecord = computed(() => this.history().find((r) => r.date === dateKey()));
  protected readonly notifications = computed(() => this.data.notificationsOf(this.user()?.id ?? ''));
}
