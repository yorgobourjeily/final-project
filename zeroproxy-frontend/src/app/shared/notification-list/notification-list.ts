import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import { DatePipe } from '@angular/common';
import { AppNotification } from '../../models';

@Component({
  selector: 'app-notification-list',
  imports: [DatePipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './notification-list.html',
  styleUrl: './notification-list.css',
})
export class NotificationList {
  readonly items = input.required<AppNotification[]>();
  readonly markAllRead = output();
  protected readonly unread = computed(() => this.items().filter((n) => !n.read).length);
}
