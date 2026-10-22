import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { Status } from '../../models';

const LABELS: Record<Status, string> = { present: 'Present', late: 'Late', absent: 'Absent' };

@Component({
  selector: 'app-status-badge',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './status-badge.html',
})
export class StatusBadge {
  readonly status = input<Status | null | undefined>();
  protected readonly label = computed(() => {
    const status = this.status();
    return status ? LABELS[status] : 'Not marked';
  });
}
