import { ChangeDetectionStrategy, Component, computed, input, output, signal } from '@angular/core';
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
  readonly clearAll = output();
  readonly remove = output<string>();
  protected readonly unread = computed(() => this.items().filter((n) => !n.read).length);
  /** Clear all was clicked once and waits for confirmation. */
  protected readonly confirmingClear = signal(false);

  protected confirmClear() {
    this.confirmingClear.set(false);
    this.clearAll.emit();
  }
}
